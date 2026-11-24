import type { McpServer, ServerContext, ToolCallback } from "@modelcontextprotocol/server";
import { z } from "zod";
import { prompt } from "../prompts.js";
import {
  answerRunAsk,
  answerRunForm,
  answerRunQuestion,
  controlRun,
  type RunReport,
  reviewRun,
  runReport,
} from "../services/runs.js";
import type { Principal } from "./auth.js";
import { withPages } from "./run-pages.js";
import { annotationsOf, failure, ok } from "./tools.js";

/**
 * A run once it started: what it waits for, and the person's answers to it. For the wizard's
 * author testing it (`runs:test`) and for anyone who runs the space's wizards (`elements:run`,
 * `wizard_run`), a client of the organization too: the run decides who may answer it
 * (`answerableRun`), never the token alone.
 */
export function registerRunTools(server: McpServer, who: Principal) {
  if (!(who.scopes.includes("runs:test") || who.scopes.includes("elements:run"))) {
    return;
  }
  const tool = <S extends z.ZodObject>(
    name: string,
    config: {
      title: string;
      description: string;
      input: S;
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
      /** The run's next page goes to the person, where the client asks them (mcp/run-pages.ts). */
      pages?: boolean;
    },
    run: (args: z.infer<S>) => Promise<unknown>,
  ) => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: annotationsOf(config),
      },
      (async (args: z.infer<S>, ctx: ServerContext) => {
        try {
          if (config.pages) {
            return await withPages(
              ctx,
              who,
              async () => (await run(args)) as RunReport,
              (report) => ok(report),
            );
          }
          return ok(await run(args));
        } catch (err) {
          return failure(err);
        }
      }) as ToolCallback<S>,
    );
  };

  const waitSeconds = z
    .number()
    .int()
    .min(0)
    .max(45)
    .default(0)
    .describe("Wait up to this long while the run is still working.");

  tool(
    "get_run",
    {
      title: "Get run",
      description: prompt("mcp", "tool.get_run"),
      input: z.object({ runId: z.string(), waitSeconds }),
      readOnly: true,
    },
    async ({ runId, waitSeconds }) => runReport(who.userId, runId, waitSeconds),
  );

  tool(
    "answer_form",
    {
      title: "Answer form",
      description: prompt("mcp", "tool.answer_form"),
      input: z.object({
        runId: z.string(),
        stepId: z.string().describe("waitingFor.form"),
        values: z.record(z.string(), z.unknown()),
        waitSeconds,
      }),
      openWorld: true,
      pages: true,
    },
    async ({ runId, stepId, values, waitSeconds }) => {
      await answerRunForm(who.userId, runId, stepId, values);
      return runReport(who.userId, runId, waitSeconds);
    },
  );

  tool(
    "review_step",
    {
      title: "Review step",
      description: prompt("mcp", "tool.review_step"),
      input: z.object({
        runId: z.string(),
        stepId: z.string().describe("waitingFor.review"),
        action: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("accept"),
            edits: z.record(z.string(), z.string()).optional(),
            note: z.string().max(2000).optional(),
          }),
          z.object({
            type: z.literal("decline").describe("Only when waitingFor.approve is true."),
            note: z.string().max(2000).optional(),
          }),
          z.object({
            type: z.literal("regenerate"),
            target: z.string().describe("One of waitingFor.show."),
            note: z.string().max(2000),
          }),
        ]),
        waitSeconds,
      }),
      openWorld: true,
      pages: true,
    },
    async ({ runId, stepId, action, waitSeconds }) => {
      await reviewRun(who.userId, runId, stepId, action);
      return runReport(who.userId, runId, waitSeconds);
    },
  );

  tool(
    "answer_ask",
    {
      title: "Answer confirmation",
      description: prompt("mcp", "tool.answer_ask"),
      input: z.object({
        runId: z.string(),
        askId: z.string(),
        answer: z.enum(["allow", "skip"]),
        waitSeconds,
      }),
      destructive: true,
      openWorld: true,
      pages: true,
    },
    async ({ runId, askId, answer, waitSeconds }) => {
      await answerRunAsk(who.userId, runId, askId, answer);
      return runReport(who.userId, runId, waitSeconds);
    },
  );

  tool(
    "answer_question",
    {
      title: "Answer a step's question",
      description: prompt("mcp", "tool.answer_question"),
      input: z.object({ runId: z.string(), answer: z.string().min(1), waitSeconds }),
      destructive: false,
      openWorld: true,
      pages: true,
    },
    async ({ runId, answer, waitSeconds }) => {
      await answerRunQuestion(who.userId, runId, answer);
      return runReport(who.userId, runId, waitSeconds);
    },
  );

  tool(
    "control_run",
    {
      title: "Control run",
      description: prompt("mcp", "tool.control_run"),
      input: z.object({ runId: z.string(), action: z.enum(["back", "retry", "cancel"]) }),
      destructive: true,
      openWorld: true,
    },
    async ({ runId, action }) => {
      await controlRun(who.userId, runId, action);
      return runReport(who.userId, runId);
    },
  );
}
