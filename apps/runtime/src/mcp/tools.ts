import type { CallToolResult, McpServer, ToolCallback } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authoringGuide } from "../authoring/guide.js";
import { wizardOpSchema } from "../authoring/ops.js";
import { importFromRegistry, listConnectors, searchRegistry } from "../connectors/external.js";
import { RunConflict } from "../engine/runner.js";
import { pluginToolsOf } from "../plugins/registry.js";
import { publishAndSync, pushSharing } from "../services/cloud.js";
import { ServiceError } from "../services/errors.js";
import { deleteFile, listFiles, readFileText, writeFile } from "../services/files.js";
import { marketplaceWizard, searchMarketplace } from "../services/marketplace.js";
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

export function registerTools(server: McpServer, who: Principal) {
  const writer: Writer = { source: "mcp", client: who.client };
  const tool = <S extends z.ZodObject>(
    name: string,
    scope: Scope,
    config: { title: string; description: string; input: S; readOnly?: boolean },
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
        annotations: { readOnlyHint: config.readOnly ?? false, openWorldHint: false },
      },
      // The SDK has parsed `args` with `input` before this runs.
      (async (args: z.infer<S>) => {
        try {
          return ok(await run(args));
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
    config: { title: string; description: string; input: S; readOnly?: boolean },
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
        annotations: { readOnlyHint: config.readOnly ?? false, openWorldHint: false },
        _meta: flowAppMeta,
      },
      (async (args: z.infer<S>) => {
        try {
          const { result, view } = await run(args);
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
      description:
        "Read this before writing a wizard: the JSON schema, field kinds, step types and tools, templates, design rules, and the MCP servers of the project.",
      input: z.object({
        projectId: z.string().optional().describe("Defaults to the person's first project."),
      }),
      readOnly: true,
    },
    async ({ projectId }) => {
      const project = projectId
        ? await ownedProject(who.userId, projectId)
        : await defaultProject(who.userId);
      return authoringGuide(
        project.mcpServers.map((s) => ({ id: s.id, name: s.name })),
        await listConnectors(project.id),
        await pluginToolsOf(who.tenantId),
      );
    },
  );

  // --- connectors ------------------------------------------------------------
  tool(
    "find_connectors",
    "wizards:read",
    {
      title: "Find connectors",
      description:
        "Search the integrations registry for a service that can be imported as a connector, from its OpenAPI spec or its MCP server.",
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
      description: "The connectors a project has imported, each with its actions.",
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
      description:
        "Import a registry service into a project as a connector. Returns its id, tool prefix, how people connect and its actions. A wizard uses it through a connection { id, connector }.",
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
      description:
        "Ready-made wizards to start from: first those the space's plugins bring (marked with the plugin), then the marketplace's (tweet with image, video ad, research briefing, dashboard, invoice, offer …), with what each makes and needs. Give a query to search them; without one you get the starters.",
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
      description: "A starter's complete wizard JSON — the best example to copy from.",
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
      description:
        "The person's projects, called spaces in the studio. Each holds wizards, a brand and MCP servers. Name a space by its name; where two share one, add where it comes from (`from`). Ids are for the tools: never show them to the person.",
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
      description:
        "The person's wizards, newest first, each with its space's name and where that space comes from. Ids are for the tools: never show them to the person.",
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
      description:
        "A wizard's draft with its revision and validator issues, whether it differs from the published version, and its links.",
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
      description: "Check a wizard JSON without saving it. Returns ok and the issues.",
      input: z.object({ definition }),
      readOnly: true,
    },
    async (args) => {
      try {
        const { issues } = parseDraft(args.definition);
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
      description:
        "Create a wizard from your JSON, or copy a starter. The draft may still have issues; fix them with edit_wizard.",
      input: z.object({
        projectId: z.string().optional().describe("Defaults to the person's first project."),
        definition: definition.optional(),
        starterId: z.string().optional().describe("Copy this starter instead of sending JSON."),
        note,
      }),
    },
    async (args) => {
      const created = await createWizard(who.userId, args, writer);
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
      description: `Apply ops to the draft atomically, in order:
- set_meta {title?, description?, avatar?, intro? (null removes)}
- set_lists {lists} / set_connections {connections}: replace the wizard's lists or connections as a whole
- upsert_step {step (complete), before?|after?}: replaces the step with that id, else inserts it (default: before the final result step)
- remove_step {stepId}
- move_step {stepId, before|after}
Returns the new revision and the issues.`,
      input: z.object({
        wizardId: z.string(),
        baseRevision,
        ops: z.array(wizardOpSchema).min(1).max(50),
        note,
      }),
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
      description: "Replace the whole draft. Use edit_wizard for smaller changes.",
      input: z.object({ wizardId: z.string(), baseRevision, definition, note }),
    },
    async ({ wizardId, ...input }) => {
      const { revision, issues } = await writeDraft(who.userId, wizardId, input, writer);
      return { revision, issues };
    },
  );

  // --- publish ---------------------------------------------------------------
  tool(
    "publish_wizard",
    "wizards:publish",
    {
      title: "Publish wizard",
      description:
        "Publish the draft as a new version behind the share link. Refused while the draft has issues. Only when the person asked for it.",
      input: z.object({ wizardId: z.string() }),
    },
    async ({ wizardId }) => publishAndSync(who.userId, wizardId),
  );

  tool(
    "set_sharing",
    "wizards:publish",
    {
      title: "Set sharing",
      description: "Turn the share link on or off, or change how many runs it allows per day.",
      input: z.object({
        wizardId: z.string(),
        enabled: z.boolean().optional(),
        dailyRunLimit: z.number().int().min(1).max(10_000).optional(),
      }),
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
      description:
        "Run the draft once with your answers. Spends the person's credits (short copy + image about 15, research about 150, video about 250). Pages are filled from `answers`, reviews accepted when acceptReviews is true. Follow it with get_test_run. Shows the flow with the run on it.",
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
      description:
        "Status, recent events, outputs (text clipped) with signed download links valid one hour, credits spent, and what the run waits for.",
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
      description:
        "Show a wizard as its flow diagram: its pages, AI steps, reviews and branches. The published version when there is one, else the draft. Also returns the steps as text.",
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
      description: `Start a run of a published wizard for the person, here in the chat. Spends credits like any run.
Start it right away — no show_wizard first: the widget shows the wizard's pages and the person can answer there. What the person already said goes to the first page with answer_page, using the field ids in waitingFor. Then follow waitingFor:
- page: ask the person for the fields with inChat=true, in order, answer_page; fields with inChat=false (files, recordings, signatures) need the run page at browserUrl. A field with a when is asked only while its condition holds on the answers so far (shown says so for what is known now); fields the wizard decided against are not listed
- review: show the outputs, then review_step
- ask: answer_ask (allow/skip a change in a connected account) or the run page for a sign-in
While status is running, get_run with waitSeconds. Hosts with MCP Apps also show the run as a widget the person can answer in.`,
      input: z.object({
        wizardId: z.string(),
        answers: z.record(z.string(), z.unknown()).default({}),
      }),
    },
    async ({ wizardId, answers }) => {
      const { runId, refused } = await startRun(who.userId, wizardId, answers);
      const report = await runReport(who.userId, runId, 2);
      return {
        result: { ...report, ...(refused ? { refusedAnswers: refused } : {}) },
        view: await flowView(who.userId, wizardId, { run: report }),
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
      description:
        "A run's status, what it waits for, its outputs (text clipped) with signed download links valid one hour, and the credits it spent.",
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
      description:
        "Fill the page a run waits for: field id → value (items: an array of row objects; toggle: true/false; multiselect: an array; slot: one of the offered times, as given). Returns the run, after waitSeconds.",
      input: z.object({
        runId: z.string(),
        stepId: z.string().describe("waitingFor.page"),
        values: z.record(z.string(), z.unknown()),
        waitSeconds,
      }),
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
      description:
        "Answer the review a run waits for: accept (optionally with edited texts, step id → text, when the review is editable) or regenerate one step it shows, with a note what to change.",
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
      description:
        "A running step asks before it changes something in a connected account (waitingFor.ask, kind confirm): allow it once, or skip it. Ask the person first.",
      input: z.object({
        runId: z.string(),
        askId: z.string(),
        answer: z.enum(["allow", "skip"]),
        waitSeconds,
      }),
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
      description:
        "back: return to the previous page or review. retry: run the failed step again. cancel: stop the run.",
      input: z.object({ runId: z.string(), action: z.enum(["back", "retry", "cancel"]) }),
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
      description:
        "The wizard's workspace: widget HTML/JS/CSS, vendored libraries, reference data. Runs use a snapshot of it.",
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
      description: "A workspace file as text (binary files are described, not returned).",
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
      description:
        "Create or overwrite a workspace file: `content` for text (HTML, JS, CSS, JSON, CSV, SVG) or `base64` for binary (images, fonts). Max 5 MB per file, 25 MB per workspace. A widget may only use files from here — no network when it runs.",
      input: z.object({
        wizardId: z.string(),
        path: z.string().describe('Relative path, e.g. "weather/index.html" or "lib/d3.min.js".'),
        content: z.string().optional(),
        base64: z.string().optional(),
        mime: z.string().optional(),
      }),
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
      description: "Remove a file from the workspace.",
      input: z.object({ wizardId: z.string(), path: z.string() }),
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
        description:
          "Load a widget step of the draft in a real browser with its sample data: script errors, the timeline it registered (seconds, for the MP4 export) and a screenshot.",
        inputSchema: input,
        annotations: { readOnlyHint: true, openWorldHint: false },
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
            text: `Build an engenty wizard: ${description}

1. Call get_authoring_guide and follow its rules.
2. Pick the closest starter (list_starters, get_starter) as an example.
3. create_wizard with a short note; fix every issue with edit_wizard.
4. start_test_run with realistic answers, then get_test_run with waitSeconds until it is done; fix what looks wrong.
5. Give me the studioUrl and a short summary. Publish only if I ask.`,
          },
        },
      ],
    }),
  );
}
