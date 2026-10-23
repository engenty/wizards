import { DEFINITION_VERSION, upgradeDefinition } from "@engenty/wizards-shared/definition";
import type { CallToolResult, McpServer, ToolCallback } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authoringGuide } from "../authoring/guide.js";
import { wizardOpSchema } from "../authoring/ops.js";
import { importFromRegistry, listConnectors, searchRegistry } from "../connectors/external.js";
import { RunConflict } from "../engine/runner.js";
import { pluginToolsOf } from "../plugins/registry.js";
import { prompt } from "../prompts.js";
import { publishAndSync, pushSharing } from "../services/cloud.js";
import { ServiceError } from "../services/errors.js";
import { deleteFile, listFiles, readFileText, writeFile } from "../services/files.js";
import { marketplaceWizard, searchMarketplace } from "../services/marketplace.js";
import { markAgent, presentIn } from "../services/presence.js";
import { defaultProject, listProjects, ownedProject } from "../services/projects.js";
import {
  answerRunAsk,
  answerRunPage,
  controlRun,
  reviewRun,
  runReport,
  startRun,
  startTestRun,
  testRunReport,
} from "../services/runs.js";
import { checkDraftWidget } from "../services/widgets.js";
import {
  createWizard,
  editWizard,
  listWizards,
  ownedWizard,
  parseDraft,
  shareUrl,
  studioUrl,
  updateWizardSettings,
  type Writer,
  wizardState,
  writeDraft,
} from "../services/wizards.js";
import type { Principal } from "./auth.js";
import { FLOW_VIEW_KEY, type FlowView, flowAppMeta, flowView } from "./flow-app.js";
import type { Scope } from "./scopes.js";

const definition = z
  .record(z.string(), z.unknown())
  .describe("The complete wizard JSON as described by get_authoring_guide.");

/** A wizard a model wrote from today's authoring guide is of today's version, said or not. */
const authored = (raw: unknown) => upgradeDefinition(raw, DEFINITION_VERSION);
const note = z
  .string()
  .max(500)
  .optional()
  .describe(
    "One sentence for the person about what changed, in their language. Shown in the studio.",
  );
const baseRevision = z
  .number()
  .int()
  .min(0)
  .describe("The revision you last read. A newer one on the server answers revision_conflict.");

function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  };
}

function failure(err: unknown): CallToolResult {
  let body: unknown;
  if (err instanceof ServiceError) {
    body = err.toJSON();
  } else if (err instanceof RunConflict) {
    body = { error: err.message, code: "conflict" };
  } else if (err instanceof z.ZodError) {
    body = { error: "Invalid input", code: "invalid", issues: err.issues };
  } else {
    console.error("[mcp]", err);
    body = { error: "Internal error", code: "internal" };
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

/** Where a space comes from, as the person knows it: sent by their local install, or made here. */
function spaceFrom(p: { origin: string | null }): "your computer" | "here" {
  return p.origin === "local" ? "your computer" : "here";
}

/**
 * What a tool does to the person's data, as the MCP annotations say it. Every hint is set: a
 * missing `destructiveHint` counts as destructive, and the app directories require all three.
 * - `readOnly`: changes nothing.
 * - `destructive`: deletes, overwrites, revokes, cancels, or allows a write into a connected
 *   account, even where a revision can undo it.
 * - `openWorld`: reaches past the person's own workspace: publishes, or runs steps that search
 *   the web and use connected accounts.
 */
type ToolConfig<S extends z.ZodObject> = {
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
};

function annotationsOf(config: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean }) {
  const readOnly = config.readOnly ?? false;
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && (config.destructive ?? false),
    openWorldHint: config.openWorld ?? false,
  };
}

/** What a client tells its person when people edit the wizard it just changed. */
function presentNote(people: [string, string | null][]): string {
  const who = people.map(([name, where]) => (where ? `${name} (${where})` : name)).join(", ");
  return prompt("mcp", "note.present", { who, verb: people.length > 1 ? "are" : "is" });
}

export function registerTools(server: McpServer, who: Principal) {
  const writer: Writer = { source: "mcp", client: who.client };
  /** This client, for this person: how the studio shows it among who is in a wizard. */
  const agent = {
    id: `mcp:${who.client}:${who.userId}`,
    name: who.client,
    client: who.name ?? null,
  };
  /**
   * A tool on a wizard marks this client as present there (docs/plans/live-changes.md, 8), and
   * its result says who else is: people and other agents, so the client can tell its person.
   */
  const withPresence = async (
    args: unknown,
    readOnly: boolean,
    result: unknown,
  ): Promise<unknown> => {
    const wizardId = (args as { wizardId?: unknown } | null)?.wizardId;
    if (typeof wizardId !== "string" || !result || typeof result !== "object") {
      return result;
    }
    try {
      await markAgent("wizard", wizardId, agent, readOnly ? "viewing" : "editing");
      const present = (await presentIn("wizard", wizardId)).filter((e) => e.who !== agent.id);
      if (!present.length) {
        return result;
      }
      const editing = present.filter((e) => e.whoKind === "person" && e.state === "editing");
      return {
        ...(result as Record<string, unknown>),
        present: present.map((e) => ({
          name: e.name,
          kind: e.whoKind,
          state: e.state,
          ...(e.placeLabel ? { where: e.placeLabel } : {}),
          ...(e.client ? { via: e.client } : {}),
          since: e.seenAt,
        })),
        ...(editing.length && !readOnly
          ? { presentNote: presentNote(editing.map((e) => [e.name, e.placeLabel])) }
          : {}),
      };
    } catch (err) {
      console.error("[mcp] presence:", err);
      return result;
    }
  };
  const tool = <S extends z.ZodObject>(
    name: string,
    scope: Scope,
    config: ToolConfig<S>,
    run: (args: z.infer<S>) => Promise<unknown>,
  ) => {
    if (!who.scopes.includes(scope)) {
      return;
    }
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: annotationsOf(config),
      },
      // The SDK has parsed `args` with `input` before this runs.
      (async (args: z.infer<S>) => {
        try {
          return ok(await withPresence(args, config.readOnly ?? false, await run(args)));
        } catch (err) {
          return failure(err);
        }
      }) as ToolCallback<S>,
    );
  };

  /** A tool whose result also opens the flow widget, in hosts that render MCP Apps. */
  const appTool = <S extends z.ZodObject>(
    name: string,
    scope: Scope,
    config: ToolConfig<S>,
    run: (args: z.infer<S>) => Promise<{ result: Record<string, unknown>; view: FlowView }>,
  ) => {
    if (!who.scopes.includes(scope)) {
      return;
    }
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: annotationsOf(config),
        _meta: flowAppMeta,
      },
      (async (args: z.infer<S>) => {
        try {
          const { result: plain, view } = await run(args);
          const result = (await withPresence(args, config.readOnly ?? false, plain)) as Record<
            string,
            unknown
          >;
          return {
            ...ok(result),
            structuredContent: result,
            _meta: { [FLOW_VIEW_KEY]: view },
          } satisfies CallToolResult;
        } catch (err) {
          return failure(err);
        }
      }) as ToolCallback<S>,
    );
  };

  // --- read ------------------------------------------------------------------
  tool(
    "get_authoring_guide",
    "wizards:read",
    {
      title: "Authoring guide",
      description: prompt("mcp", "tool.get_authoring_guide"),
      input: z.object({
        projectId: z.string().optional().describe("Defaults to the person's first project."),
      }),
      readOnly: true,
    },
    async ({ projectId }) => {
      const project = projectId
        ? await ownedProject(who.userId, projectId)
        : await defaultProject(who.userId);
      return authoringGuide(await listConnectors(project.id), await pluginToolsOf(who.tenantId));
    },
  );

  // --- connectors ------------------------------------------------------------
  tool(
    "find_connectors",
    "wizards:read",
    {
      title: "Find connectors",
      description: prompt("mcp", "tool.find_connectors"),
      input: z.object({ query: z.string().min(1).max(200) }),
      readOnly: true,
    },
    async ({ query }) => ({ services: await searchRegistry(query) }),
  );

  tool(
    "list_connectors",
    "wizards:read",
    {
      title: "List connectors",
      description: prompt("mcp", "tool.list_connectors"),
      input: z.object({ projectId: z.string().optional() }),
      readOnly: true,
    },
    async ({ projectId }) => {
      const project = projectId
        ? await ownedProject(who.userId, projectId)
        : await defaultProject(who.userId);
      return { projectId: project.id, connectors: await listConnectors(project.id) };
    },
  );

  tool(
    "import_connector",
    "wizards:write",
    {
      title: "Import connector",
      description: prompt("mcp", "tool.import_connector"),
      input: z.object({
        projectId: z.string().optional(),
        domain: z.string().describe("A domain from find_connectors, e.g. notion.com"),
        kind: z.enum(["mcp", "openapi"]).optional(),
      }),
    },
    async ({ projectId, domain, kind }) => {
      const project = projectId
        ? await ownedProject(who.userId, projectId)
        : await defaultProject(who.userId);
      return importFromRegistry(who.userId, project.id, { domain, kind });
    },
  );

  tool(
    "list_starters",
    "wizards:read",
    {
      title: "List starters",
      description: prompt("mcp", "tool.list_starters"),
      input: z.object({ query: z.string().max(200).optional() }),
      readOnly: true,
    },
    async ({ query }) =>
      (await searchMarketplace({ q: query ?? "", lang: "de", limit: 30 })).entries
        .filter((s) => s.usable && (query?.trim() || s.starter))
        .map((s) => ({
          id: s.id,
          title: s.title,
          pitch: s.pitch,
          formats: s.formats,
          useCases: s.useCases,
          capabilities: s.capabilities,
          ...(s.plugin ? { plugin: s.plugin.name } : {}),
          // Not startable here: its plugins come with the Pro plan.
          ...(s.needs?.length ? { needsPro: s.needs } : {}),
        })),
  );

  tool(
    "get_starter",
    "wizards:read",
    {
      title: "Get starter",
      description: prompt("mcp", "tool.get_starter"),
      input: z.object({ starterId: z.string() }),
      readOnly: true,
    },
    async ({ starterId }) => {
      const starter = await marketplaceWizard(starterId, "de");
      if (!starter) {
        throw new ServiceError("not_found", `There is no starter "${starterId}".`);
      }
      return starter.definition;
    },
  );

  tool(
    "list_projects",
    "wizards:read",
    {
      title: "List projects",
      description: prompt("mcp", "tool.list_projects"),
      input: z.object({}),
      readOnly: true,
    },
    async () =>
      (await listProjects(who.userId)).map((p) => ({
        id: p.id,
        name: p.name,
        from: spaceFrom(p),
        wizardCount: p.wizardCount,
      })),
  );

  tool(
    "list_wizards",
    "wizards:read",
    {
      title: "List wizards",
      description: prompt("mcp", "tool.list_wizards"),
      input: z.object({ projectId: z.string().optional() }),
      readOnly: true,
    },
    async ({ projectId }) => {
      const spaces = new Map((await listProjects(who.userId)).map((p) => [p.id, p]));
      return (await listWizards(who.userId, projectId)).map((w) => {
        const space = spaces.get(w.projectId);
        return {
          id: w.id,
          projectId: w.projectId,
          space: space?.name ?? null,
          spaceFrom: space ? spaceFrom(space) : null,
          title: w.title,
          revision: w.revision,
          published: w.published,
          updatedAt: w.updatedAt,
          studioUrl: studioUrl(w.id),
        };
      });
    },
  );

  tool(
    "get_wizard",
    "wizards:read",
    {
      title: "Get wizard",
      description: prompt("mcp", "tool.get_wizard"),
      input: z.object({ wizardId: z.string() }),
      readOnly: true,
    },
    async ({ wizardId }) => {
      const s = await wizardState(await ownedWizard(who.userId, wizardId));
      return {
        wizardId: s.id,
        projectId: s.projectId,
        revision: s.revision,
        draft: s.draft,
        issues: s.issues,
        publishedVersion: s.publishedVersion,
        dirty: s.dirty,
        shareEnabled: s.shareEnabled,
        dailyRunLimit: s.dailyRunLimit,
        shareUrl: s.shareUrl,
        studioUrl: s.studioUrl,
      };
    },
  );

  tool(
    "validate_wizard",
    "wizards:read",
    {
      title: "Validate wizard",
      description: prompt("mcp", "tool.validate_wizard"),
      input: z.object({ definition }),
      readOnly: true,
    },
    async (args) => {
      try {
        const { issues } = parseDraft(authored(args.definition));
        return { ok: issues.length === 0, issues };
      } catch (err) {
        if (err instanceof ServiceError && err.code === "invalid") {
          return { ok: false, issues: err.data.issues };
        }
        throw err;
      }
    },
  );

  // --- write -----------------------------------------------------------------
  tool(
    "create_wizard",
    "wizards:write",
    {
      title: "Create wizard",
      description: prompt("mcp", "tool.create_wizard"),
      input: z.object({
        projectId: z.string().optional().describe("Defaults to the person's first project."),
        definition: definition.optional(),
        starterId: z.string().optional().describe("Copy this starter instead of sending JSON."),
        note,
      }),
    },
    async (args) => {
      const created = await createWizard(
        who.userId,
        { ...args, definition: args.definition && authored(args.definition) },
        writer,
      );
      return {
        wizardId: created.id,
        revision: created.revision,
        issues: created.issues,
        studioUrl: created.studioUrl,
      };
    },
  );

  tool(
    "edit_wizard",
    "wizards:write",
    {
      title: "Edit wizard",
      description: prompt("mcp", "tool.edit_wizard"),
      input: z.object({
        wizardId: z.string(),
        baseRevision,
        ops: z.array(wizardOpSchema).min(1).max(50),
        note,
      }),
      destructive: true,
    },
    async ({ wizardId, ...input }) => {
      const { revision, issues } = await editWizard(who.userId, wizardId, input, writer);
      return { revision, issues };
    },
  );

  tool(
    "replace_wizard",
    "wizards:write",
    {
      title: "Replace wizard",
      description: prompt("mcp", "tool.replace_wizard"),
      input: z.object({ wizardId: z.string(), baseRevision, definition, note }),
      destructive: true,
    },
    async ({ wizardId, ...input }) => {
      const { revision, issues } = await writeDraft(
        who.userId,
        wizardId,
        { ...input, definition: authored(input.definition) },
        writer,
      );
      return { revision, issues };
    },
  );

  // --- publish ---------------------------------------------------------------
  tool(
    "publish_wizard",
    "wizards:publish",
    {
      title: "Publish wizard",
      description: prompt("mcp", "tool.publish_wizard"),
      input: z.object({ wizardId: z.string() }),
      destructive: true,
      openWorld: true,
    },
    async ({ wizardId }) => publishAndSync(who.userId, wizardId),
  );

  tool(
    "set_sharing",
    "wizards:publish",
    {
      title: "Set sharing",
      description: prompt("mcp", "tool.set_sharing"),
      input: z.object({
        wizardId: z.string(),
        enabled: z.boolean().optional(),
        dailyRunLimit: z.number().int().min(1).max(10_000).optional(),
      }),
      destructive: true,
      openWorld: true,
    },
    async ({ wizardId, enabled, dailyRunLimit }) => {
      const w = await updateWizardSettings(who.userId, wizardId, {
        shareEnabled: enabled,
        dailyRunLimit,
      });
      await pushSharing(who.userId, wizardId);
      return {
        shareEnabled: w.shareEnabled,
        dailyRunLimit: w.dailyRunLimit,
        shareUrl: shareUrl(w.shareToken),
      };
    },
  );

  // --- test runs ---------------------------------------------------------------
  appTool(
    "start_test_run",
    "runs:test",
    {
      title: "Start test run",
      description: prompt("mcp", "tool.start_test_run"),
      input: z.object({
        wizardId: z.string(),
        answers: z
          .record(z.string(), z.unknown())
          .default({})
          .describe(
            "Field id → value, for every page (field ids are unique in a wizard). Items fields take an array of row objects.",
          ),
        acceptReviews: z.boolean().default(true),
      }),
      openWorld: true,
    },
    async ({ wizardId, answers, acceptReviews }) => {
      const { runId } = await startTestRun(who.userId, wizardId, { answers, acceptReviews });
      const report = await runReport(who.userId, runId, 2, "test");
      return {
        result: report,
        view: await flowView(who.userId, wizardId, { shows: "draft", run: report }),
      };
    },
  );

  tool(
    "get_test_run",
    "runs:test",
    {
      title: "Get test run",
      description: prompt("mcp", "tool.get_test_run"),
      input: z.object({
        runId: z.string(),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(45)
          .default(0)
          .describe("Wait up to this long while the run is still working."),
      }),
      readOnly: true,
    },
    async ({ runId, waitSeconds }) => testRunReport(who.userId, runId, waitSeconds),
  );

  // --- using wizards: the flow, and runs of the published version -------------
  appTool(
    "show_wizard",
    "wizards:read",
    {
      title: "Show wizard",
      description: prompt("mcp", "tool.show_wizard"),
      input: z.object({
        wizardId: z.string(),
        version: z.enum(["published", "draft"]).optional().describe("Default: published, if any."),
      }),
      readOnly: true,
    },
    async ({ wizardId, version }) => {
      const view = await flowView(who.userId, wizardId, { shows: version });
      return {
        result: {
          wizardId,
          title: view.wizard.title,
          shows: view.wizard.shows,
          published: view.wizard.published,
          steps: view.definition.steps.map((s) => ({
            id: s.id,
            type: s.type,
            title: s.title,
            ...(s.type === "page"
              ? { fields: s.fields.map((f) => ({ id: f.id, label: f.label, kind: f.kind })) }
              : {}),
          })),
        },
        view,
      };
    },
  );

  appTool(
    "run_wizard",
    "runs:test",
    {
      title: "Run wizard",
      description: prompt("mcp", "tool.run_wizard"),
      input: z.object({
        wizardId: z.string(),
        answers: z.record(z.string(), z.unknown()).default({}),
        theme: z.string().max(80).optional().describe(prompt("mcp", "param.run_wizard.theme")),
      }),
      openWorld: true,
    },
    async ({ wizardId, answers, theme }) => {
      const { runId, refused } = await startRun(who.userId, wizardId, answers);
      const report = await runReport(who.userId, runId, 2);
      return {
        result: { ...report, ...(refused ? { refusedAnswers: refused } : {}) },
        view: await flowView(who.userId, wizardId, { run: report, theme }),
      };
    },
  );

  const waitSeconds = z
    .number()
    .int()
    .min(0)
    .max(45)
    .default(0)
    .describe("Wait up to this long while the run is still working.");

  tool(
    "get_run",
    "runs:test",
    {
      title: "Get run",
      description: prompt("mcp", "tool.get_run"),
      input: z.object({ runId: z.string(), waitSeconds }),
      readOnly: true,
    },
    async ({ runId, waitSeconds }) => runReport(who.userId, runId, waitSeconds),
  );

  tool(
    "answer_page",
    "runs:test",
    {
      title: "Answer page",
      description: prompt("mcp", "tool.answer_page"),
      input: z.object({
        runId: z.string(),
        stepId: z.string().describe("waitingFor.page"),
        values: z.record(z.string(), z.unknown()),
        waitSeconds,
      }),
      openWorld: true,
    },
    async ({ runId, stepId, values, waitSeconds }) => {
      await answerRunPage(who.userId, runId, stepId, values);
      return runReport(who.userId, runId, waitSeconds);
    },
  );

  tool(
    "review_step",
    "runs:test",
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
    },
    async ({ runId, stepId, action, waitSeconds }) => {
      await reviewRun(who.userId, runId, stepId, action);
      return runReport(who.userId, runId, waitSeconds);
    },
  );

  tool(
    "answer_ask",
    "runs:test",
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
    },
    async ({ runId, askId, answer, waitSeconds }) => {
      await answerRunAsk(who.userId, runId, askId, answer);
      return runReport(who.userId, runId, waitSeconds);
    },
  );

  tool(
    "control_run",
    "runs:test",
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

  // --- workspace (widget code, libraries, reference data) --------------------
  tool(
    "list_files",
    "wizards:read",
    {
      title: "List workspace files",
      description: prompt("mcp", "tool.list_files"),
      input: z.object({ wizardId: z.string() }),
      readOnly: true,
    },
    async ({ wizardId }) =>
      (await listFiles(who.userId, wizardId)).map(({ path, mime, size }) => ({ path, mime, size })),
  );

  tool(
    "read_file",
    "wizards:read",
    {
      title: "Read workspace file",
      description: prompt("mcp", "tool.read_file"),
      input: z.object({ wizardId: z.string(), path: z.string() }),
      readOnly: true,
    },
    async ({ wizardId, path }) => readFileText(who.userId, wizardId, path),
  );

  tool(
    "write_file",
    "wizards:write",
    {
      title: "Write workspace file",
      description: prompt("mcp", "tool.write_file"),
      input: z.object({
        wizardId: z.string(),
        path: z.string().describe('Relative path, e.g. "weather/index.html" or "lib/d3.min.js".'),
        content: z.string().optional(),
        base64: z.string().optional(),
        mime: z.string().optional(),
      }),
      destructive: true,
    },
    async ({ wizardId, path, content, base64, mime }) => {
      if ((content === undefined) === (base64 === undefined)) {
        throw new ServiceError("invalid", "Pass either content or base64.");
      }
      return writeFile(
        who.userId,
        wizardId,
        path,
        content ?? Buffer.from(base64 ?? "", "base64"),
        mime,
      );
    },
  );

  tool(
    "delete_file",
    "wizards:write",
    {
      title: "Delete workspace file",
      description: prompt("mcp", "tool.delete_file"),
      input: z.object({ wizardId: z.string(), path: z.string() }),
      destructive: true,
    },
    async ({ wizardId, path }) => {
      await deleteFile(who.userId, wizardId, path);
      return { ok: true };
    },
  );

  if (who.scopes.includes("wizards:read")) {
    const input = z.object({
      wizardId: z.string(),
      stepId: z.string().describe("A widget step of the draft."),
      data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Data to show instead of the step's sample file."),
    });
    server.registerTool(
      "check_widget",
      {
        title: "Check widget",
        description: prompt("mcp", "tool.check_widget"),
        inputSchema: input,
        annotations: annotationsOf({ readOnly: true }),
      },
      (async ({ wizardId, stepId, data }: z.infer<typeof input>) => {
        try {
          const r = await checkDraftWidget(who.userId, wizardId, stepId, data);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  errors: r.errors,
                  timelineSeconds: r.duration,
                  size: r.size,
                  bundleBytes: r.bytes,
                }),
              },
              { type: "image", data: Buffer.from(r.png).toString("base64"), mimeType: "image/png" },
            ],
          } satisfies CallToolResult;
        } catch (err) {
          return failure(err);
        }
      }) as ToolCallback<typeof input>,
    );
  }
}

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "design_wizard",
    {
      title: "Design a wizard",
      description: "Build an engenty wizard from a description.",
      argsSchema: z.object({ description: z.string().describe("What the wizard should do.") }),
    },
    ({ description }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: prompt("mcp", "prompt.design_wizard", { description }),
          },
        },
      ],
    }),
  );
}
