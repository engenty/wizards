import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-mcp-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.DEV_LOGIN = "1";

const MCP_URL = "http://localhost:5181/api/mcp";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let key: string;

async function connect(): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text (the guide)
  }
  return { isError: Boolean(res.isError), body };
}

beforeAll(async () => {
  const { migrateControlDb } = await import("../src/db/client");
  await migrateControlDb();
  const { createLocalKey } = await import("../src/auth/keys");
  key = (await createLocalKey("Claude Code")).key;
  app = (await import("../src/app")).default;
}, 60_000);

describe("MCP endpoint", () => {
  it("refuses a request without a key", async () => {
    const res = await app.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("lists the authoring tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "get_authoring_guide",
        "create_wizard",
        "edit_wizard",
        "replace_wizard",
        "publish_wizard",
        "start_test_run",
        "get_test_run",
      ]),
    );
    const guide = await call(client, "get_authoring_guide");
    expect(guide.body).toContain("type Wizard");
  });

  it("says what each tool does to the person's data, with all three hints", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        expect(typeof t.annotations?.[hint], `${t.name}.${hint}`).toBe("boolean");
      }
    }
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    expect(hints("list_wizards")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hints("create_wizard")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints("delete_file")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hints("publish_wizard")).toMatchObject({ destructiveHint: true, openWorldHint: true });
  });

  it("creates, edits with revisions, refuses stale writes and unclean publishes", async () => {
    const client = await connect();
    const created = await call(client, "create_wizard", { note: "Leeren Wizard angelegt." });
    expect(created.isError).toBe(false);
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    const { wizardId } = created.body;
    expect(created.body.revision).toBe(0);

    const edited = await call(client, "edit_wizard", {
      wizardId,
      baseRevision: 0,
      ops: [
        { op: "set_meta", title: "Stellenanzeige" },
        {
          op: "upsert_step",
          step: {
            id: "done",
            type: "result",
            title: "Fertig",
            deliverables: [{ from: "missing", formats: ["md"] }],
          },
        },
      ],
      note: "Titel gesetzt.",
    });
    expect(edited.isError).toBe(false);
    expect(edited.body.revision).toBe(1);
    expect(edited.body.issues.length).toBeGreaterThan(0);

    const stale = await call(client, "edit_wizard", {
      wizardId,
      baseRevision: 0,
      ops: [{ op: "set_meta", title: "Zu spät" }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.body).toMatchObject({ code: "revision_conflict", revision: 1 });

    const refused = await call(client, "publish_wizard", { wizardId });
    expect(refused.isError).toBe(true);
    expect(refused.body.code).toBe("has_issues");

    const badShape = await call(client, "validate_wizard", { definition: { title: "x" } });
    expect(badShape.body.ok).toBe(false);

    const fixed = await call(client, "edit_wizard", {
      wizardId,
      baseRevision: 1,
      ops: [
        {
          op: "upsert_step",
          step: { id: "done", type: "result", title: "Fertig", deliverables: [] },
        },
      ],
    });
    expect(fixed.body).toMatchObject({ revision: 2, issues: [] });

    const { withTenant, db, schema } = await import("../src/db/client");
    const { eq } = await import("drizzle-orm");
    const notes = await withTenant("local", () =>
      db.query.wizardMessage.findMany({ where: eq(schema.wizardMessage.wizardId, wizardId) }),
    );
    expect(notes.map((n) => [n.source, n.client, n.content])).toEqual([
      ["mcp", "Claude Code", "Leeren Wizard angelegt."],
      ["mcp", "Claude Code", "Titel gesetzt."],
    ]);

    const run = await call(client, "start_test_run", { wizardId, answers: { input: "Bäcker" } });
    expect(run.isError).toBe(false);
    const report = await call(client, "get_test_run", { runId: run.body.runId, waitSeconds: 10 });
    expect(report.body.status).toBe("done");

    const published = await call(client, "publish_wizard", { wizardId });
    expect(published.body).toMatchObject({ version: 1 });
    expect(published.body.shareUrl).toMatch(/^http:\/\/localhost:5181\/w\//);
  });

  it("offers the flow widget with the tools that show a wizard or a run", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const meta = (name: string) => tools.find((t) => t.name === name)?._meta as any;
    for (const name of ["show_wizard", "run_wizard", "start_test_run"]) {
      expect(meta(name)?.ui?.resourceUri).toMatch(/^ui:\/\/engenty-wizards\/flow-[0-9a-f]{10}\.html$/);
    }
    expect(meta("get_run")?.ui).toBeUndefined();
    const { contents } = await client.readResource({ uri: meta("show_wizard").ui.resourceUri });
    expect(contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    expect(String((contents[0] as { text: string }).text)).toMatch(/<html|flow widget/i);
  });

  it("runs a published wizard page by page, and only for the one who started it", async () => {
    const client = await connect();
    const created = await call(client, "create_wizard", {
      definition: {
        version: 1,
        title: "Zwei Seiten",
        description: "",
        avatar: "round",
        steps: [
          {
            id: "first",
            type: "page",
            title: "Thema",
            fields: [{ id: "topic", label: "Thema", kind: "text", required: true }],
          },
          {
            id: "second",
            type: "page",
            title: "Ton",
            fields: [
              { id: "tone", label: "Ton", kind: "select", options: ["locker", "förmlich"] },
              {
                id: "why",
                label: "Warum locker?",
                kind: "text",
                when: { field: "tone", op: "equals", value: "locker" },
              },
              { id: "logo", label: "Logo", kind: "image" },
            ],
          },
          { id: "done", type: "result", title: "Fertig", deliverables: [] },
        ],
      },
    });
    const { wizardId } = created.body;

    const unpublished = await call(client, "run_wizard", { wizardId });
    expect(unpublished.isError).toBe(true);
    const published = await call(client, "publish_wizard", { wizardId });
    expect(published.body).not.toHaveProperty("error");

    const shown = await client.callTool({ name: "show_wizard", arguments: { wizardId } });
    const view = (shown._meta as any)["engenty/flow"];
    expect(view.wizard).toMatchObject({ id: wizardId, shows: "published", published: true });
    expect(view.definition.steps.map((s: { id: string }) => s.id)).toEqual([
      "first",
      "second",
      "done",
    ]);

    const startedRaw = await client.callTool({
      name: "run_wizard",
      arguments: { wizardId, answers: { topic: "Brot" } },
    });
    const started = {
      isError: Boolean(startedRaw.isError),
      body: JSON.parse((startedRaw.content as { text: string }[])[0].text),
    };
    expect(started.isError).toBe(false);
    const runId = started.body.runId;
    expect(started.body.mode).toBe("live");

    // The widget reaches the run itself, from the host's origin, with the run's ticket only.
    const { runtime } = (startedRaw._meta as any)["engenty/flow"];
    expect(runtime.base).toBe("http://localhost:5181");
    const fromWidget = (path: string, ticket: string, method = "GET") =>
      app.fetch(
        new Request(`http://localhost:5181/api/runs/${path}?rt=${ticket}`, {
          method,
          headers: { origin: "https://widget.example" },
        }),
      );
    const seen = await fromWidget(runId, runtime.ticket);
    expect(seen.status).toBe(200);
    expect(seen.headers.get("access-control-allow-origin")).toBe("https://widget.example");
    expect((await fromWidget(runId, runtime.ticket, "OPTIONS")).status).toBe(204);
    expect((await fromWidget(runId, "1.forged")).status).toBe(404);
    expect((await fromWidget(`${runId}/back`, "1.forged", "POST")).status).toBe(403);
    const waiting = await call(client, "get_run", { runId, waitSeconds: 5 });
    expect(waiting.body.waitingFor.page).toBe("second");
    expect(waiting.body.passed).toContain("first");
    const fields = waiting.body.waitingFor.fields;
    expect(fields.find((f: { id: string }) => f.id === "logo").inChat).toBe(false);
    // A field with a condition on another field of the page is listed with it, not shown yet.
    expect(fields.find((f: { id: string }) => f.id === "why")).toMatchObject({
      when: { field: "tone", op: "equals", value: "locker" },
      shown: false,
    });
    expect(fields.find((f: { id: string }) => f.id === "tone").when).toBeUndefined();
    expect(waiting.body.waitingFor.known).toEqual({});
    expect(waiting.body.browserUrl).toMatch(new RegExp(`/w/[^/]+/${runId}$`));

    const wrong = await call(client, "answer_page", {
      runId,
      stepId: "second",
      values: { tone: "laut" },
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.body.code).toBe("invalid");

    const back = await call(client, "control_run", { runId, action: "back" });
    expect(back.body.waitingFor.page).toBe("first");
    await call(client, "answer_page", { runId, stepId: "first", values: { topic: "Brot" } });
    const done = await call(client, "answer_page", {
      runId,
      stepId: "second",
      values: { tone: "locker" },
      waitSeconds: 5,
    });
    expect(done.body.status).toBe("done");

    // A run someone started on the wizard's link is theirs, not the client's.
    const { withTenant, db, schema } = await import("../src/db/client");
    const { eq } = await import("drizzle-orm");
    await withTenant("local", () =>
      db.update(schema.run).set({ userId: null }).where(eq(schema.run.id, runId)),
    );
    const foreign = await call(client, "get_run", { runId });
    expect(foreign.body.code).toBe("not_found");
  });

  it("takes requests that `engenty-wizards mcp` signs with the data folder's secret", async () => {
    const { env } = await import("../src/env");
    const { mintLocalTicket } = await import("../src/auth/local-ticket");
    const list = (ticket: string) =>
      app.fetch(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-engenty-local": ticket,
            "x-engenty-client": "Claude Desktop",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
    const signed = await list(mintLocalTicket(env.authSecret, Date.now(), "local-mcp"));
    expect(signed.status).toBe(200);
    expect(await signed.text()).toContain("run_wizard");
    // A ticket for the browser's one-time link is not one for the MCP endpoint.
    const other = await list(mintLocalTicket(env.authSecret, Date.now(), "local-enter"));
    expect(other.status).toBe(401);
  });
});

describe("who else is in a wizard", () => {
  it("marks the client as present and tells it who is editing", async () => {
    const client = await connect();
    const created = await call(client, "create_wizard", { note: "Für die Anwesenheit." });
    const { wizardId } = created.body;
    // Alone: nothing about others.
    const alone = await call(client, "get_wizard", { wizardId });
    expect(alone.body.present).toBeUndefined();
    const { withTenant } = await import("../src/db/client");
    const presence = await import("../src/services/presence");
    const inStudio = await withTenant("local", () => presence.presentIn("wizard", wizardId));
    expect(inStudio).toEqual([
      expect.objectContaining({ whoKind: "agent", name: "Claude Code", state: "viewing" }),
    ]);
    // A person edits the step "Contact" in the studio.
    await withTenant("local", () =>
      presence.markPresent({
        kind: "wizard",
        item: wizardId,
        who: "anna",
        tab: "t1",
        whoKind: "person",
        name: "Anna",
        place: "steps.contact",
        placeLabel: "Step “Contact”",
        state: "editing",
      }),
    );
    const read = await call(client, "get_wizard", { wizardId });
    expect(read.body.present).toEqual([
      expect.objectContaining({ name: "Anna", kind: "person", state: "editing", where: "Step “Contact”" }),
    ]);
    expect(read.body.presentNote).toBeUndefined();
    const edited = await call(client, "edit_wizard", {
      wizardId,
      baseRevision: created.body.revision,
      ops: [{ op: "set_meta", title: "Neben Anna" }],
    });
    expect(edited.isError).toBe(false);
    expect(edited.body.presentNote).toContain("Anna (Step “Contact”) is editing this wizard");
    // The write still happened, and the client now counts as editing.
    expect(edited.body.revision).toBe(created.body.revision + 1);
    const after = await withTenant("local", () => presence.presentIn("wizard", wizardId));
    expect(after.find((e) => e.whoKind === "agent")?.state).toBe("editing");
  });

  it("lets a person go after 45 seconds unseen, an agent after a minute", async () => {
    const { withTenant } = await import("../src/db/client");
    const presence = await import("../src/services/presence");
    await withTenant("local", async () => {
      const t0 = Date.now();
      await presence.markPresent({ kind: "page", item: "p1", who: "anna", whoKind: "person", name: "Anna", state: "viewing" }, new Date(t0));
      await presence.markAgent("page", "p1", { id: "mcp:x", name: "Codex", client: null }, "viewing");
      expect(await presence.presentIn("page", "p1", t0 + 50_000)).toEqual([expect.objectContaining({ name: "Codex" })]);
      await presence.expirePresence(t0 + 70_000);
      expect(await presence.presentIn("page", "p1", t0 + 70_000)).toEqual([]);
    });
  });
});
