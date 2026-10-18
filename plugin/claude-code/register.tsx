import type { EngineInterface, Register, RenderSurface } from "claude-code";
import { atom, read, update } from "claude-code";
import { engentyColor, engentySvg } from "./engenty";
import type { RunView, WizardDetails, WizardRow } from "./types";

const PANE = "wizards";

const wizards = atom({ plugin: "wizards", key: "wizards" } as const, []);
const details = atom({ plugin: "wizards", key: "details" } as const, {}, { shape: "v2" });
const message = atom({ plugin: "wizards", key: "message" } as const, null);
const shown = atom({ plugin: "wizards", key: "shown" } as const, null);
const runtime = atom({ plugin: "wizards", key: "runtime" } as const, null);
const fallback = atom({ plugin: "wizards", key: "fallback" } as const, null);

/** The runtime's MCP tools whose answer is a run report: a run the model drives. */
const RUN_TOOLS = new Set([
  "run_wizard",
  "get_run",
  "answer_page",
  "answer_ask",
  "review_step",
  "control_run",
]);

type Called = { ok: true; body: unknown } | { ok: false; error: string };

/** What the hooks need beyond `$`: the two MCP servers the pane talks to. */
type Servers = { server: string; browser: string };

/** This plugin's name in its manifest: a server bundled with it is listed under it. */
const PLUGIN = "wizards";

/** A server's spelling inside a tool name: anything but letters, digits, `_` and `-` becomes `_`. */
const slug = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** The tool-name prefixes under which the runtime's tools may appear. */
const prefixesOf = (server: string) => [
  `mcp__${slug(server)}__`,
  `mcp__plugin_${PLUGIN}_${slug(server)}__`,
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** The text of a tool result, whatever shape the engine hands it in. */
const textOf = (result: unknown): string | undefined => {
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.content)
      ? result.content
      : [];
  const block = blocks.find((b) => isRecord(b) && b.type === "text" && typeof b.text === "string");
  return isRecord(block) ? String(block.text) : undefined;
};

const isReport = (v: unknown): v is RunView =>
  isRecord(v) && typeof v.runId === "string" && typeof v.status === "string";

const isOver = (r: RunView) =>
  r.status === "done" || r.status === "failed" || r.status === "cancelled";

const originOf = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** What get_wizard answers, kept to what the pane draws. */
const detailsOf = (body: unknown): WizardDetails | undefined => {
  if (!isRecord(body) || !isRecord(body.draft)) return undefined;
  const d = body.draft;
  const steps = Array.isArray(d.steps) ? d.steps.filter(isRecord) : [];
  const shareUrl =
    typeof body.shareUrl === "string" && body.shareEnabled !== false ? body.shareUrl : undefined;
  return {
    title: typeof d.title === "string" && d.title ? d.title : String(body.wizardId ?? ""),
    ...(typeof d.description === "string" && d.description ? { description: d.description } : {}),
    ...(typeof d.avatar === "string" ? { avatar: d.avatar } : {}),
    ...(shareUrl ? { shareUrl } : {}),
    steps: steps.map((s) => ({
      id: String(s.id),
      type: typeof s.type === "string" ? s.type : "step",
      title: typeof s.title === "string" && s.title ? s.title : String(s.id),
    })),
  };
};

async function call(
  $: EngineInterface,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  isRetry = false,
): Promise<Called> {
  try {
    const result = await $.mcp.call(server, tool, args);
    const text = result.content.find((b) => b.type === "text")?.text ?? "";
    const body = parse(text);
    if (result.isError) {
      const reason = isRecord(body) && typeof body.message === "string" ? body.message : text;
      return { ok: false, error: reason || `${tool} failed.` };
    }
    return { ok: true, body };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // The auto-mode classifier's "no verdict" asks for one more try, as-is.
    if (!isRetry && /no verdict/i.test(error)) return call($, server, tool, args, true);
    return { ok: false, error };
  }
}

function say($: EngineInterface, text: string | null) {
  return update($, message, () => text);
}

/** Opens a page in the app's browser pane, beside the transcript; refused, offers a link. */
async function show($: EngineInterface, browser: string, url: string) {
  const got = await call($, browser, "navigate", { url });
  if (got.ok) {
    await update($, fallback, () => null);
    await say($, null);
    return true;
  }
  await update($, fallback, () => url);
  await say($, `The browser pane did not open it: ${got.error}`);
  return false;
}

/** The run's own page, the wizard as it greets a person; a test run has the studio instead. */
async function showRun($: EngineInterface, browser: string, current: RunView) {
  const url = current.browserUrl ?? current.studioUrl;
  if (!url) {
    await say($, "This run has no page of its own.");
    return false;
  }
  await update($, shown, () => current.runId);
  return show($, browser, url);
}

/** A wizard's name, engenty, steps and page, fetched once per wizard. */
async function ensureDetails($: EngineInterface, server: string, wizardId: string) {
  const known = await read($, details);
  if (known[wizardId]) return;
  const got = await call($, server, "get_wizard", { wizardId });
  if (!got.ok) {
    await say($, `The wizard's details did not load: ${got.error}`);
    return;
  }
  const found = detailsOf(got.body);
  if (found) await update($, details, (d) => ({ ...d, [wizardId]: found }));
}

/** The list, then each wizard's details, so every row has its engenty and page. */
async function loadWizards($: EngineInterface, server: string) {
  const got = await call($, server, "list_wizards", {});
  if (!got.ok) {
    await say($, got.error);
    return false;
  }
  const rows: WizardRow[] = (Array.isArray(got.body) ? got.body : []).filter(isRecord).map((w) => ({
    id: String(w.id),
    title: typeof w.title === "string" && w.title ? w.title : String(w.id),
    published: Boolean(w.published),
    ...(typeof w.studioUrl === "string" ? { studioUrl: w.studioUrl } : {}),
  }));
  await update($, wizards, () => rows);
  await say($, null);
  const origin = originOf(rows.find((r) => r.studioUrl)?.studioUrl);
  if (origin) await update($, runtime, () => origin);
  for (const row of rows) await ensureDetails($, server, row.id);
  return true;
}

/** Runs a wizard: its own page where it has one, else a run started here and its page. */
async function runWizard($: EngineInterface, at: Servers, wizard: WizardRow) {
  if (!wizard.published) {
    await say($, `"${wizard.title}" is not published yet.`);
    return false;
  }
  const page = (await read($, details))[wizard.id]?.shareUrl;
  if (page) return show($, at.browser, page);
  const got = await call($, at.server, "run_wizard", { wizardId: wizard.id, answers: {} });
  if (!got.ok) {
    await say($, got.error);
    return false;
  }
  if (!isReport(got.body)) return false;
  return showRun($, at.browser, got.body);
}

/**
 * Puts a change request for the wizard into the chat, for the person to finish; where no box
 * takes it, the sentence goes to the clipboard instead.
 */
async function askForChanges($: EngineInterface, title: string, surface?: RenderSurface) {
  const text = `For my engenty wizard "${title}" I need the following changes: `;
  const filled = await $.prompt.fill({ text, mode: "replace" });
  if (filled.isFilled) {
    await say($, null);
    return;
  }
  const copied = await $.ui.copy({ text, ...(surface ? { surface } : {}) });
  const why =
    filled.refusal === "dialog" ? "a dialog holds the keys" : "this surface has no prompt box";
  await say(
    $,
    copied.isCopied
      ? `The chat box did not take the text (${why}). It is on your clipboard: paste it into the chat.`
      : `The chat box did not take the text (${why}), and the clipboard is not reachable either.`,
  );
}

function openPane($: EngineInterface, focus?: true) {
  return $.ui.open({ id: PANE, title: "engenty.wizards", ...(focus ? { focus } : {}) });
}

export const register: Register = (on, options) => {
  const at: Servers = {
    server:
      typeof options.server === "string" && options.server ? options.server : "engenty-wizards",
    browser:
      typeof options.browser === "string" && options.browser ? options.browser : "Claude_Browser",
  };
  let prefixes = prefixesOf(at.server);

  on("session.start", async ($, e, next) => {
    // The plugin's own server (plugin/.mcp.json) answers under the name the engine gave it;
    // a server configured elsewhere under the same name keeps it.
    const own = await $.mcp.connect(at.server);
    if (own.isConnected) {
      at.server = own.server;
      prefixes = prefixesOf(own.server);
    }
    await $.command.register({
      name: "wizards",
      description: "The engenty.wizards list in a pane; each runs beside the chat",
      argumentHint: "[run <wizard> | reload | close]",
    });
    await say($, null);
    // The list is a sidebar: it opens by itself where someone can see it.
    if (e.isInteractive) await openPane($);
    if ((await read($, wizards)).length === 0) await loadWizards($, at.server);
    return next(e);
  });

  on("command.run", { command: "wizards" }, async ($, e) => {
    const [verb = "", ...rest] = e.args.trim().split(/\s+/).filter(Boolean);
    if (verb === "close") {
      await $.ui.close({ id: PANE });
      return { text: "Wizards pane closed." };
    }
    const opened = await openPane($, true);
    const where = opened.isPlaced ? "" : ` It waits undrawn: ${opened.reason}`;
    if (verb === "run" && rest.length) {
      if (!(await loadWizards($, at.server))) return { text: `Wizards: ${await read($, message)}` };
      const want = rest.join(" ").toLowerCase();
      const list = await read($, wizards);
      const found =
        list.find((w) => w.id === want) ??
        list.find((w) => w.title.toLowerCase() === want) ??
        list.find((w) => w.title.toLowerCase().includes(want));
      if (!found) return { text: `No wizard "${rest.join(" ")}".` };
      const ran = await runWizard($, at, found);
      return {
        text: ran
          ? `"${found.title}" is open beside the chat.${where}`
          : `Wizards: ${await read($, message)}`,
      };
    }
    if (verb === "reload" || (await read($, wizards)).length === 0) await loadWizards($, at.server);
    return { text: `Wizards pane opened.${where}` };
  });

  // A run the model drives through the runtime's MCP tools opens beside the chat once it
  // waits for the person, one time per run.
  on("tool.call", async ($, e, next) => {
    const ran = await next(e);
    const prefix = prefixes.find((p) => e.tool.startsWith(p));
    if (!prefix || ran.deny !== undefined || ran.result === undefined) return ran;
    if (!RUN_TOOLS.has(e.tool.slice(prefix.length))) return ran;
    const text = textOf(ran.result);
    if (text === undefined) return ran;
    const report = parse(text);
    if (!isReport(report) || isOver(report) || !report.waitingFor) return ran;
    if ((await read($, shown)) === report.runId) return ran;
    const origin = originOf(report.browserUrl);
    if (origin) await update($, runtime, () => origin);
    await showRun($, at.browser, report);
    return ran;
  }).catch((_, e, next) => next(e));

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e);
    const { Box, Text, Button, Link } = table;
    const Svg = "Svg" in table ? table.Svg : undefined;
    const width = e.props.bodyColumns;
    const [list, known, note, origin, link] = await Promise.all([
      read($, wizards),
      read($, details),
      read($, message),
      read($, runtime),
      read($, fallback),
    ]);

    /** The engenty of a wizard, as the studio draws it; a glyph where no surface draws SVG. */
    const mascot = (kind: string | undefined, size: number) =>
      Svg ? (
        <Svg source={engentySvg(kind, size)} alt="engenty" width={size} height={size} />
      ) : (
        <Text color={engentyColor(kind)}>◉</Text>
      );

    /** One wizard: its engenty, name and description; Run opens its page, Edit asks the chat. */
    const row = (w: WizardRow, i: number) => {
      const about = known[w.id];
      const title = about?.title ?? w.title;
      return (
        <Box key={`w:${w.id}`} gap={1} alignItems="center">
          {mascot(about?.avatar, 36)}
          <Box flexDirection="column" flexGrow={1}>
            <Text bold={w.published} dimColor={!w.published}>
              {title}
              {w.published ? "" : " · draft"}
            </Text>
            {about?.description && (
              <Text dimColor wrap="truncate">
                {about.description}
              </Text>
            )}
          </Box>
          {w.published && (
            <Button
              key={`run:${w.id}`}
              variant="primary"
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              onPress={() => runWizard($, at, w)}
            >
              Run
            </Button>
          )}
          <Button
            key={`edit:${w.id}`}
            plain
            dimColor
            onPress={(press) => askForChanges($, title, press.surface)}
          >
            Edit
          </Button>
        </Box>
      );
    };

    return (
      <Box flexDirection="column" width={width} gap={1}>
        {note && <Text color="error">{note}</Text>}
        {link && <Link href={link} label="Open it in your browser instead" />}
        {list.length === 0 ? (
          <Text dimColor>No wizards yet. Press Reload, or start the wizards runtime first.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            {list.map(row)}
          </Box>
        )}
        <Box gap={1} alignItems="center">
          {origin && <Text dimColor>{origin.replace(/^https?:\/\//, "")}</Text>}
          {origin && (
            <Button
              plain
              dimColor
              hotkey="o"
              onPress={() => show($, at.browser, `${origin}/studio`)}
            >
              Studio
            </Button>
          )}
          <Button plain dimColor hotkey="l" onPress={() => loadWizards($, at.server)}>
            Reload
          </Button>
        </Box>
      </Box>
    );
  });
};
