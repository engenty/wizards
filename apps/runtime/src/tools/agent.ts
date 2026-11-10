import { type AgentStep, agentStepSchema } from "@engenty/wizards-shared/definition";
import { note, type StepOutput } from "@engenty/wizards-shared/run";
import type { WizardAgent } from "@engenty/wizards-shared/wizard-agents";
import {
  stepAgents,
  wizardAgentCallName,
  wizardAgentId,
} from "@engenty/wizards-shared/wizard-code";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { summarizeInput, writeLog } from "../broker/log.js";
import { type StepContext, StepError } from "../engine/types.js";
import { loadWizardAgent } from "../engine/wizard-code.js";
import { snapshotFile } from "../services/files.js";
import { clip } from "./shared.js";
import { whoWhere } from "./wizard.js";

/**
 * A wizard's agents (docs/plans/wizard-code.md): `agents/<name>.md` in its workspace. A step runs
 * one as its own (`"agent": "<name>"`, engine/steps.ts) or lists it as a tool (`agent.<name>`,
 * here). As a tool, the step's model hands a task over and gets the agent's answer, or its
 * `output` as JSON. It runs as an agent step of its own, with the step's caller, grant and hosts;
 * its model calls are charged to the run. One level: an agent's file lists no other agent.
 */

/** Characters of an agent's written answer the step's model reads. */
const ANSWER_CHARS = 20_000;

/** Runs an agent step: engine/steps.ts hands its `runAgentStep` in. */
export type RunAgentStep = (step: AgentStep, ctx: StepContext) => Promise<StepOutput>;

/**
 * The agent `name` from the run's files. A step that names one its workspace lacks, or one that
 * doesn't parse, fails: the wizard is broken, not the model.
 */
export async function wizardAgentOf(name: string, ctx: StepContext): Promise<WizardAgent> {
  const loaded = await loadWizardAgent(
    name,
    ctx.files.map((f) => f.path),
    async (path) => {
      const file = await snapshotFile(ctx.files, path);
      return file ? file.data.toString("utf8") : null;
    },
  );
  if (!loaded) {
    throw new StepError(note("wizardAgentMissing", { name }));
  }
  if (!loaded.ok) {
    throw new StepError(note("wizardAgentBroken", { name, detail: loaded.issues[0] }));
  }
  return loaded.agent;
}

/**
 * The step an agent of the wizard runs: the agent's model and tools, the step's task. `tools` on
 * the step narrow the agent's; one the agent doesn't list fails the step. Returns the agent's
 * instructions too: the system part of every call.
 */
export async function stepOfAgent(
  step: AgentStep & { agent: string },
  ctx: StepContext,
): Promise<{ step: AgentStep; instructions: string }> {
  const agent = await wizardAgentOf(step.agent, ctx);
  const wider = step.tools.filter((id) => !agent.tools.includes(id));
  if (wider.length) {
    throw new StepError(
      note("wizardAgentBroken", {
        name: step.agent,
        detail: `the step lists ${wider.join(", ")}, which the agent doesn't.`,
      }),
    );
  }
  return {
    step: {
      ...step,
      agent: undefined,
      model: agent.model,
      maker: undefined,
      tools: step.tools.length ? step.tools : agent.tools,
    },
    instructions: agent.instructions,
  };
}

/** The agents a step lists as tools (`agent.<name>`), each as a tool its model calls. */
export async function agentTools(
  step: AgentStep,
  ctx: StepContext,
  run: RunAgentStep,
): Promise<Record<string, any>> {
  const tools: Record<string, any> = {};
  for (const name of stepAgents(step).tools) {
    const agent = await wizardAgentOf(name, ctx);
    const callName = wizardAgentCallName(name);
    tools[callName] = agentTool(agent, callName, step, ctx, run);
  }
  return tools;
}

function agentTool(
  agent: WizardAgent,
  callName: string,
  step: AgentStep,
  ctx: StepContext,
  run: RunAgentStep,
) {
  const id = wizardAgentId(agent.name);
  return createTool({
    id: callName,
    description: agent.description ?? `Hands a task to the agent ${agent.name}.`,
    inputSchema: z.object({
      task: z.string().min(1).describe("What the agent is to do, with everything it needs to know"),
    }),
    execute: async ({ task }) => {
      await ctx.emit("tool", { code: "asksAgent", params: { name: id } });
      // An agent step of its own, the agent's tools and nothing more: no connections, the
      // step's hosts. Its id is the step's and the agent's, so nothing of the step's own turn
      // is taken for it.
      const sub = agentStepSchema.parse({
        id: `${step.id}_${callName}`.slice(0, 41),
        title: agent.description ?? agent.name,
        type: "agent",
        agent: agent.name,
        // The task is no template: what the model wrote stays as it is.
        instructions: task.replace(/\{\{/g, "{ {"),
        ...(step.hosts ? { hosts: step.hosts } : {}),
        output: agent.output ? { format: "json", schema: agent.output } : { format: "markdown" },
      });
      const started = Date.now();
      // Each call is a line of the broker's log, as a function tool's; what the agent does
      // through its tools has lines of its own.
      const logged = (result: string, answer?: unknown) =>
        writeLog({
          at: new Date(started),
          durationMs: Date.now() - started,
          ...whoWhere(ctx),
          connectionId: `tool:${id}`,
          actionId: id,
          kind: "run",
          inputSummary: summarizeInput({ task }),
          outcome: "allow",
          rule: null,
          reason: "The step lists the wizard's agent.",
          result,
          resultSize: answer === undefined ? null : (JSON.stringify(answer)?.length ?? 0),
        });
      try {
        const out = await run(sub, ctx);
        const answer = agent.output
          ? (out.json ?? {})
          : { answer: clip(out.text ?? "", ANSWER_CHARS) };
        await logged("ok", answer);
        return answer;
      } catch (err) {
        if (ctx.signal.aborted) {
          throw err;
        }
        await logged((err as Error).name || "Error");
        return { error: (err as Error).message || "The agent stopped." };
      }
    },
  });
}
