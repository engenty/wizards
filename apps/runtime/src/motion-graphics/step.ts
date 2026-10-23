import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { MOTION_SIZES, type MotionGraphicsStep } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { note as runNote } from "@engenty/wizards-shared/run";
import { type StepContext, StepError } from "../engine/types.js";
import { CLAUDE_BIN, claudeEnv } from "../harness/claude.js";
import { failureOf } from "../harness/model.js";
import { type BridgeTool, openBridge } from "../mcp/bridge.js";
import { saidOf } from "../model-errors.js";
import { motionClient } from "../models.js";
import { keepBrandBase, prepareMotionFolder, savedSession, saveSession } from "./project.js";
import { runHyperframes } from "./tools.js";

/**
 * A motion-graphics step: the installed client (Claude Code) works in the video's folder with the skills,
 * the style kit, the brand and the run's material, and writes the video as code. Its shell runs
 * in the client's sandbox — writes only inside the folder, no network; HyperFrames (render,
 * snapshots, checks) runs outside it, through the `hyperframes` tool of this step, limited to
 * the folder. The final render is the runtime's, not the client's. A run that stops (a limit,
 * a crash) keeps the folder and the client's session: the next attempt picks up from there.
 */

/** What the client may run through the tool; everything that reaches the network stays out. */
const ALLOWED = new Set([
  "lint",
  "check",
  "validate",
  "inspect",
  "snapshot",
  "render",
  "compositions",
  "timeline",
  "info",
  "keyframes",
  "compare",
  "grade-compare",
  "beats",
  "normalize-audio",
  "media-treatment",
  "transcribe",
  "docs",
]);

/** The longest a video may take the client before the step gives up. */
const LIMIT_MS = 3 * 60 * 60_000;

function hyperframesTool(root: string, signal: AbortSignal): BridgeTool {
  return {
    name: "hyperframes",
    description:
      "Runs the HyperFrames CLI in the video folder: lint, check, snapshot, render, inspect, timeline, transcribe, keyframes, compare, docs and the like. Paths are relative to the folder. Returns what it printed.",
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: 'The arguments, e.g. ["snapshot", "video", "--at", "1,4,8"].',
        },
      },
      required: ["args"],
    },
    async execute(input) {
      const args = ((input as { args?: unknown }).args ?? []) as unknown[];
      if (!args.length || !args.every((a) => typeof a === "string")) {
        return "args: a list of strings, the subcommand first.";
      }
      const [cmd] = args as string[];
      if (!ALLOWED.has(cmd)) {
        return `"${cmd}" is not available here. Available: ${[...ALLOWED].join(", ")}.`;
      }
      // Every path stays inside the folder.
      for (const a of args as string[]) {
        const value = a.includes("=") && a.startsWith("-") ? a.slice(a.indexOf("=") + 1) : a;
        if (isAbsolute(value) || normalize(value).startsWith("..")) {
          return `"${a}" leaves the video folder.`;
        }
      }
      const extra = cmd === "transcribe" ? ["--no-runtime-install"] : [];
      const { code, out } = await runHyperframes([...(args as string[]), ...extra], {
        cwd: root,
        signal,
        timeoutMs: 20 * 60_000,
      });
      return `exit ${code}\n${out.slice(-6000)}`;
    },
  };
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
}

/** Lines of a failed render worth reading: what failed and why, not the progress bars. */
function renderProblem(out: string): string {
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /✗|fail|error|blocked|warning|cannot|undefined/i.test(l) && l.length < 600);
  return (lines.join("\n") || out.slice(-800)).slice(0, 2500);
}

/** How many times a failed final render goes back to the client to be fixed. */
const RENDER_FIXES = 2;

export async function runMotionGraphicsStep(
  step: MotionGraphicsStep,
  ctx: StepContext,
): Promise<StepOutput> {
  const found = await motionClient(step.model ?? "low");
  if ("problem" in found) {
    throw new StepError(found.problem);
  }
  const { client, alias } = found;

  await ctx.emit("info", { code: "motionSetup" });
  const { root, brief, brandChanged, start } = await prepareMotionFolder(step, ctx);
  const resume = await savedSession(root);
  await ctx.emit(
    "info",
    resume ? { code: "motionResume" } : { code: "motionClient", params: { client: client.name } },
  );

  const limit = AbortSignal.any([ctx.signal, AbortSignal.timeout(LIMIT_MS)]);
  const bridge = openBridge([hyperframesTool(root, limit)]);

  /** One turn of the client in the folder; returns its final event. */
  const turn = async (prompt: string, session: string | null): Promise<StreamEvent> => {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      alias,
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: { video: { type: "http", url: bridge.url } } }),
      // The shell writes only inside the folder and has no network.
      "--settings",
      JSON.stringify({
        sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
      }),
      "--allowedTools",
      [
        "Bash",
        "Read(./**)",
        "Edit(./**)",
        "Write(./**)",
        "Glob",
        "Grep",
        "Task",
        "TodoWrite",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "TaskGet",
        "Skill",
        "mcp__video",
      ].join(","),
      "--disallowedTools",
      "WebFetch,WebSearch",
    ];
    if (step.effort) {
      args.push("--effort", step.effort);
    }
    if (session) {
      args.push("--resume", session);
    }
    let last: StreamEvent | null = null;
    let stderr = "";
    await new Promise<void>((resolve, reject) => {
      void (async () => {
        const child = spawn(CLAUDE_BIN, args, {
          cwd: root,
          env: await claudeEnv(),
          stdio: ["pipe", "pipe", "pipe"],
          signal: limit,
        });
        let buffer = "";
        let lastLook = 0;
        let lastTask = "";
        const subjects: string[] = [];
        const task = async (now: string | undefined) => {
          if (now && now !== lastTask) {
            lastTask = now;
            await ctx.emit("tool", { code: "motionTask", params: { task: now.slice(0, 90) } });
          }
        };
        const onEvent = async (event: StreamEvent) => {
          if (event.session_id && event.type === "system") {
            await saveSession(root, event.session_id);
          }
          if (event.type === "result") {
            last = event;
          }
          for (const part of event.message?.content ?? []) {
            if (part.type !== "tool_use") {
              continue;
            }
            const input = part.input ?? {};
            // What the client is on, as its own task list says; else a look at its frames.
            if (part.name === "TodoWrite") {
              const todos = (input.todos ?? []) as { content?: string; status?: string }[];
              await task(todos.find((t) => t.status === "in_progress")?.content);
            } else if (part.name === "TaskCreate") {
              subjects.push(String(input.subject ?? ""));
            } else if (part.name === "TaskUpdate" && input.status === "in_progress") {
              const id = Number(input.taskId);
              await task(
                typeof input.subject === "string" ? input.subject : subjects[id - 1] || undefined,
              );
            } else if (
              part.name === "mcp__video__hyperframes" &&
              (input.args as string[] | undefined)?.[0] === "snapshot" &&
              Date.now() - lastLook > 60_000
            ) {
              lastLook = Date.now();
              await ctx.emit("tool", { code: "motionLooks" });
            }
          }
        };
        child.stdout.on("data", (chunk) => {
          buffer += String(chunk);
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
            if (line.startsWith("{")) {
              try {
                void onEvent(JSON.parse(line) as StreamEvent).catch(() => {});
              } catch {
                // not a line of the stream
              }
            }
          }
        });
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + String(chunk)).slice(-4000);
        });
        child.on("error", reject);
        child.on("close", () => resolve());
        child.stdin.end(prompt);
      })().catch(reject);
    }).catch((err) => {
      if (ctx.signal.aborted) {
        throw err;
      }
      throw new StepError(
        runNote("motionClientStopped", { name: client.name, detail: (err as Error).message }),
      );
    });
    const result = last as StreamEvent | null;
    if (!result || result.is_error) {
      const detail = String(result?.result ?? (stderr.trim() || "no result")).slice(0, 400);
      const failure = failureOf(client, detail);
      throw new StepError(runNote("motionWorkSaved", { problem: saidOf(failure) }));
    }
    return result;
  };

  const out = join(root, "video", "renders", "video.mp4");
  let summary = "";
  try {
    // A review's note asks for a change: the video's code is there, so it is edited, not redone.
    const note = ctx.state.notes[step.id]?.trim();
    // A brand changed in the space since the video was made: the video's code carries the old one.
    const brandNote = !brandChanged
      ? ""
      : start === "init"
        ? "\n\nThe space's brand has changed since the video was made: brand/brand.json and brand/logos/ are new. Carry them into the video wherever it uses the brand (its own copies included), so every colour, logo and name is the new one, and check the frames for contrast."
        : "\n\nThe space's brand has changed since the video was made: video/brand/brand.json and the logos are new. If video/brand/theme.json is missing, make it again as video/BRAND.md says. Make sure every colour, logo and name in the video is the new one, and check the frames for contrast.";
    const size = MOTION_SIZES[step.format];
    const prompt =
      resume && note
        ? `The person watched the video and asks for this change:\n\n${note}${brandNote}\n\nChange the video in video/ accordingly — keep what they did not mention — check the frames again, and end with a short summary of what you changed.`
        : resume
          ? `Carry on with the video where you stopped. Read PROGRESS.md and the folder to see where that was, then finish it.${brandNote}`
          : start === "from"
            ? `video/ holds this run's video in another format. Lay it out for ${step.format} (${size.width}×${size.height}), following CLAUDE.md: set the size of video/index.html, then make every scene fit — scenes, timing, words and sound stay. Check the frames, render a draft, and end with a short summary of what you changed.\n\nThe brief, for reference:\n\n${brief}`
            : `Make the video BRIEF.md asks for, following CLAUDE.md.\n\n${brief}`;
    const first = await turn(prompt, resume);
    summary = typeof first.result === "string" ? first.result.trim() : "";

    // The final render is ours: it does not depend on the client still running. What fails
    // goes back to the client, which fixes its code.
    for (let attempt = 0; ; attempt++) {
      if (!existsSync(join(root, "video", "index.html"))) {
        throw new StepError(`${client.name} hat kein Video hinterlassen.`);
      }
      await ctx.emit("info", { code: "videoRendering" });
      await rm(out, { force: true });
      const render = await runHyperframes(
        ["render", "video", "-o", "video/renders/video.mp4", "--crf", "23", "--quiet"],
        { cwd: root, signal: ctx.signal, timeoutMs: 30 * 60_000 },
      );
      if (render.code === 0 && existsSync(out) && (await stat(out)).size > 0) {
        break;
      }
      const problem = renderProblem(render.out);
      if (attempt >= RENDER_FIXES) {
        throw new StepError(runNote("motionRenderFailed", { detail: problem.slice(0, 400) }));
      }
      await ctx.emit("tool", { code: "motionFix" });
      const fixed = await turn(
        `The final render of video/ failed:\n\n${problem}\n\nFind the cause in the composition's code, fix it, run \`check\` and a draft render through the hyperframes tool until both pass, and end with one line on what you fixed.`,
        await savedSession(root),
      );
      if (typeof fixed.result === "string" && fixed.result.trim()) {
        summary = `${summary}\n\n${fixed.result.trim()}`.trim();
      }
    }
  } finally {
    bridge.close();
  }

  await keepBrandBase(root).catch(() => {});
  const ref = await ctx.saveAsset({
    stepId: step.id,
    kind: "video",
    mime: "video/mp4",
    name: `${step.id}.mp4`,
    data: new Uint8Array(await readFile(out)),
    ai: "generated",
  });
  return { text: summary.slice(0, 3000), assets: [ref], at: new Date().toISOString() };
}
