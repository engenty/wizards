import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A guest's run posts to Slack (docs/plans/capabilities.md, "Decided on 2026-11-05", 3): only
 * from a fixed step, to the channel the published step names as a literal, within the limits a
 * guest's mails have. A channel that comes from the run's values is refused; a member's run is
 * not bound. Slack is played by its own connector with a key for a sign-in and a post that
 * leaves nothing.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-guest-slack-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";

const posts: { channel: string; text: string }[] = [];

vi.mock("../src/engenty/connections-slack/connector", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/engenty/connections-slack/connector")>();
  return {
    ...mod,
    slackConnector: {
      ...mod.slackConnector,
      auth: {
        kind: "api_key",
        apiKey: {
          fields: [{ key: "access_token", label: "Token", secret: true }],
          verify: async () => ({ label: "Firma / bot" }),
        },
      },
      // The connector's own actions, groups and input names; the post goes nowhere.
      actions: mod.slackConnector.actions.map((action) =>
        action.id === "post_message"
          ? {
              ...action,
              handler: async (input: { channel: string; text: string }) => {
                posts.push({ channel: input.channel, text: input.text });
                return { channel: input.channel, ts: "1.0" };
              },
            }
          : action,
      ),
    },
  };
});

let client: typeof import("../src/db/client");
let broker: typeof import("../src/broker/index");
let connections: typeof import("../src/connectors/space-connections");
let steps: typeof import("../src/engine/steps/index.js");
let runServices: typeof import("../src/run-services/index.js");
let app: typeof import("../src/app").default;
let space = "";
let wizardId = "";
let slack = "";
let definition: ReturnType<typeof definitionWith>;

const TENANT = "local";
const ORIGIN = "http://localhost:5181";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

type Holder = { kind: "guest"; id: string } | { kind: "person"; id: string; role: "member" };
const guest: Holder = { kind: "guest", id: "visitor-7" };
const member: Holder = { kind: "person", id: "local", role: "member" };

/** A fixed step that posts to the team's Slack, its channel as given. */
const post = (id: string, channel: string) => ({
  id,
  type: "tool",
  title: "Team informieren",
  call: {
    connection: "team",
    action: "post_message",
    input: { channel, text: "Neue Anfrage von {{email}}" },
  },
});

/** The wizard: a page, a post to a fixed channel, a post to a channel the page asks for. */
const definitionWith = (spaceConnection: string) => ({
  version: 1,
  title: "Anfrage",
  description: "Eine Anfrage ans Team",
  avatar: "dome",
  connections: [{ id: "team", spaceConnection, title: "Slack" }],
  steps: [
    {
      id: "start",
      type: "form",
      title: "Du",
      fields: [
        { id: "email", kind: "email", label: "E-Mail" },
        { id: "where", kind: "text", label: "Kanal" },
      ],
    },
    post("tell", "C0TEAM"),
    post("tell_any", "{{where}}"),
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
});

/** The run's values: the guest typed the team's own channel into the page. */
const state = () => ({
  values: { email: "kundin@example.com", where: "C0TEAM" },
  outputs: {},
  history: ["start"],
  notes: {},
});

async function runRow(id: string, who: Holder) {
  await inTenant(() =>
    client.db.insert(client.schema.run).values({
      id,
      wizardId,
      tenantId: TENANT,
      definition: definition as never,
      files: [],
      grant: broker.grantOf(definition as never),
      version: null,
      mode: "live",
      ...(who.kind === "guest" ? { visitorId: who.id } : { userId: who.id }),
      status: "running",
      cursor: "tell",
      state: state(),
    }),
  );
}

/** A step's context as far as a fixed step reads it. */
function contextOf(runId: string, stepId: string, holder: Holder) {
  const ctx = {
    runId,
    tenantId: TENANT,
    holder,
    test: false,
    stepId,
    store: { wizardId, holder: holder.kind === "guest" ? `v:${holder.id}` : `u:${holder.id}` },
    def: definition,
    lang: null,
    files: [],
    state: state(),
    scope: { def: definition, state: state(), brand: {} },
    space: { id: space },
    spaceFiles: [],
    signal: new AbortController().signal,
    resources: { allowed: new Set<string>() },
    emit: async () => {},
    ask: async () => null,
    call: {},
  } as unknown as import("../src/engine/types").StepContext;
  ctx.services = runServices.inProcessServices(
    { id: runId, definition } as never,
    () => ctx,
    (s, c) => steps.runAgentStep(s, c),
  );
  return ctx;
}

/** The step, run as the engine runs it: its input filled from the run's values, then the broker. */
const run = (runId: string, stepId: "tell" | "tell_any", holder: Holder) =>
  inTenant(() =>
    steps.runAutomaticStep(
      definition.steps.find((s) => s.id === stepId) as never,
      contextOf(runId, stepId, holder),
    ),
  );

const lastLine = async () =>
  (
    await inTenant(() =>
      client.db.query.brokerLog.findMany({
        where: (t, { eq }) => eq(t.connectionId, slack),
        orderBy: (t, { asc }) => [asc(t.at)],
      }),
    )
  ).at(-1);

const setDailyLimit = (dailyMailLimit: number) =>
  inTenant(() =>
    client.db
      .update(client.schema.wizard)
      .set({ dailyMailLimit })
      .where(eq(client.schema.wizard.id, wizardId)),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  broker = await import("../src/broker/index");
  connections = await import("../src/connectors/space-connections");
  steps = await import("../src/engine/steps/index.js");
  runServices = await import("../src/run-services/index.js");
  app = (await import("../src/app")).default;
  const spaces = await import("../src/services/spaces");
  const wizards = await import("../src/services/wizards");
  space = (await inTenant(() => spaces.createSpace("local", "Vertrieb"))).id;
  // The team's Slack: signs in as the space, open to guests' runs, sending allowed.
  const row = await inTenant(() =>
    connections.createSpaceConnection("local", space, {
      connectorId: "slack",
      name: "Team",
      signIn: "space",
      audience: "all",
      rules: { read: "allow", write: "ask", destructive: "deny", send: "allow" },
      actions: [],
    }),
  );
  slack = row.id;
  await inTenant(() =>
    connections.signInWithCredentials(slack, { as: "space" }, { access_token: "xoxb-7" }),
  );
  definition = definitionWith(slack);
  wizardId = (await inTenant(() => wizards.createWizard("local", { definition, spaceId: space })))
    .id;
  for (const id of ["run-g", "run-g2", "run-g3"]) {
    await runRow(id, guest);
  }
  await runRow("run-m", member);
}, 60_000);

describe("the grant fixes a step's channel", () => {
  it("keeps the channel a fixed step names as a literal, and none that is a template", () => {
    expect(broker.grantOf(definition as never).channels).toEqual({
      tell: { connection: slack, action: "post_message", channel: "C0TEAM" },
    });
  });

  it("names a wizard's own connection by its id, and keeps no part-template", () => {
    const own = {
      ...definition,
      connections: [{ id: "team", connector: "slack", actions: ["post_message"] }],
      steps: [
        definition.steps[0],
        post("tell", " C0TEAM "),
        post("tell_part", "C0{{where}}"),
        definition.steps[3],
      ],
    };
    expect(broker.grantOf(own as never).channels).toEqual({
      tell: { connection: "team", action: "post_message", channel: "C0TEAM" },
    });
  });

  it("decides a guest's post from who posts and the grant alone", () => {
    const grant = broker.grantOf(definition as never);
    const check = (
      who: Parameters<typeof broker.guestPostCheck>[0]["who"],
      stepId: string,
      channel: string | null,
      actionId = "post_message",
    ) =>
      broker.guestPostCheck({
        who,
        where: { runId: "run-g", stepId, guest: true },
        connectionId: slack,
        actionId,
        channel,
        grant,
      });
    const step = (id: string) => ({ kind: "step" as const, id, for: { kind: "guest" as const } });
    expect(check(step("tell"), "tell", "C0TEAM")).toEqual({ ok: true });
    const refused = { ok: false, refused: "channel_not_fixed", reason: broker.FIXED_CHANNEL_ONLY };
    // Another channel, the step whose channel is a template, another action, no channel.
    expect(check(step("tell"), "tell", "C0OTHER")).toEqual(refused);
    expect(check(step("tell_any"), "tell_any", "C0TEAM")).toEqual(refused);
    expect(check(step("tell"), "tell", "C0TEAM", "update_message")).toEqual(refused);
    expect(check(step("tell"), "tell", null)).toEqual(refused);
    // The guest's own call (an AI step, a share job), though it names the step.
    expect(check({ kind: "guest", id: "visitor-7" }, "tell", "C0TEAM")).toEqual(refused);
    // A run from before grants kept channels.
    expect(
      broker.guestPostCheck({
        who: step("tell"),
        where: { runId: "run-g", stepId: "tell", guest: true },
        connectionId: slack,
        actionId: "post_message",
        channel: "C0TEAM",
        grant: { connections: {}, hosts: [], tools: [] },
      }),
    ).toEqual(refused);
  });
});

describe("a guest's run posts to Slack", () => {
  it("posts to the channel its published step fixes", async () => {
    posts.length = 0;
    const out = await run("run-g", "tell", guest);
    expect(out.json).toEqual({ channel: "C0TEAM", ts: "1.0" });
    expect(posts).toEqual([{ channel: "C0TEAM", text: "Neue Anfrage von kundin@example.com" }]);
    expect(await lastLine()).toMatchObject({
      whoKind: "step",
      whoId: "tell",
      runId: "run-g",
      actionId: "post_message",
      kind: "send",
      outcome: "allow",
      rule: "rules.send",
      result: "ok",
    });
  });

  it("refuses a channel that comes from the run's values, though it is the same channel", async () => {
    posts.length = 0;
    await expect(run("run-g", "tell_any", guest)).rejects.toThrow(/published step/);
    expect(posts).toEqual([]);
    expect(await lastLine()).toMatchObject({
      whoKind: "step",
      whoId: "tell_any",
      kind: "send",
      outcome: "deny",
      rule: "guest_send",
      result: "channel_not_fixed",
      reason: broker.FIXED_CHANNEL_ONLY,
      critical: true,
      criticalKind: "refused_write",
    });
  });

  it("counts posts against the run's limit, which a mail then meets too", async () => {
    posts.length = 0;
    // One post went out above; the run sends three times.
    await run("run-g", "tell", guest);
    await run("run-g", "tell", guest);
    await expect(run("run-g", "tell", guest)).rejects.toThrow(/3 mails and posts/);
    expect(posts).toHaveLength(2);
    expect(await lastLine()).toMatchObject({
      outcome: "deny",
      rule: "guest_send",
      result: "run_limit",
      critical: true,
      criticalKind: "limit_reached",
    });
    // The same limit: the run's own address gets no mail any more.
    const mail = vi.fn(async () => "sent");
    const out = await inTenant(() =>
      broker.brokerSend({
        who: { kind: "guest", id: "visitor-7" },
        where: { runId: "run-g", wizardId, spaceId: space, mode: "live", guest: true },
        recipients: ["kundin@example.com"],
        input: { to: ["kundin@example.com"] },
        handler: mail,
      }),
    );
    expect(out).toMatchObject({ ok: false, refused: "run_limit" });
    expect(mail).not.toHaveBeenCalled();
  });

  it("counts posts against the wizard's limit for the day", async () => {
    posts.length = 0;
    // Three posts of guests' runs so far today: with a limit of four, one more goes out.
    await setDailyLimit(4);
    await run("run-g2", "tell", guest);
    await expect(run("run-g2", "tell", guest)).rejects.toThrow(/today's 4 mails and posts/);
    expect(posts).toHaveLength(1);
    expect(await lastLine()).toMatchObject({ outcome: "deny", result: "day_limit" });
    // Another guest's run meets the same day.
    await expect(run("run-g3", "tell", guest)).rejects.toThrow(/today's 4 mails and posts/);
    await setDailyLimit(50);
  });
});

describe("a member's run is not bound", () => {
  it("posts to any channel, as often as its steps say, and counts for no guest", async () => {
    posts.length = 0;
    for (let i = 0; i < 4; i++) {
      await run("run-m", "tell_any", member);
    }
    await run("run-m", "tell", member);
    expect(posts).toHaveLength(5);
    expect(await lastLine()).toMatchObject({ whoKind: "step", outcome: "allow", result: "ok" });
    // The member's posts are no guest's: with the day's limit at five, a guest's run still posts.
    await setDailyLimit(5);
    await run("run-g3", "tell", guest);
    await setDailyLimit(50);
    expect(posts).toHaveLength(6);
  });
});

describe("„Was darf …?“ answers as the call does", () => {
  let cookie = "";
  const ask = async (query: string) => {
    const res = await app.fetch(
      new Request(
        `${ORIGIN}/api/studio/spaces/${space}/broker/ask?resource=${slack}&action=post_message&${query}`,
        { headers: { cookie } },
      ),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    const entered = await app.fetch(new Request(`${ORIGIN}/api/local/enter?k=test-key`));
    cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  it("a fixed step of a guest's run: the connection's rule, and the channel must be fixed", async () => {
    const { status, body } = await ask("who=step&for=guest");
    expect(status).toBe(200);
    // What the call above was logged with.
    expect(body).toMatchObject({
      action: { id: "post_message", kind: "send", known: true },
      outcome: "allow",
      rule: "rules.send",
      fixedChannel: true,
    });
    expect(body.reason).toContain(broker.FIXED_CHANNEL_ONLY);
  });

  it("a guest's own call: refused, with the words of the refused call", async () => {
    // A chat is no AI step, so the connection's rule would let it through: the guest rule refuses.
    const { body } = await ask("who=guest&in=chat");
    expect(body).toMatchObject({
      outcome: "deny",
      rule: "guest_send",
      refused: "channel_not_fixed",
      reason: broker.FIXED_CHANNEL_ONLY,
    });
    // In a run an AI step does not send as the space, as before.
    expect((await ask("who=guest&in=run")).body).toMatchObject({
      outcome: "deny",
      rule: "ai_step_writes",
    });
  });

  it("a fixed step of a member's run: the connection's rule alone", async () => {
    const { body } = await ask("who=step&for=person");
    expect(body).toMatchObject({ outcome: "allow", rule: "rules.send" });
    expect(body.fixedChannel).toBeUndefined();
    expect(body.reason).not.toContain(broker.FIXED_CHANNEL_ONLY);
  });
});
