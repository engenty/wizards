import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, vi } from "vitest";

/*
 * The broker of accounts-apart.test.ts: a process of its own (`RUNTIME_ROLE=broker`) with
 * `ACCOUNTS_KEY`, on the data folder of the runner it serves. Slack's post leaves nothing but a
 * line in `posts` there. It serves until the runner's test leaves a `stop` file. Run without
 * `ACCOUNTS_BROKER_PORT`, as a test file like any other, it does nothing.
 */
const PORT = process.env.ACCOUNTS_BROKER_PORT;
const DIR = process.env.DATA_DIR ?? "";
if (PORT) {
  process.env.APP_URL = "http://localhost:5181";
  process.env.LOCAL_ACCESS_KEY = "test-key";
  process.env.MARKETPLACE_URL = "off";
  process.env.RUNTIME_ROLE = "broker";
  process.env.FEATURES = "durableRuns=on,runServices=on";
  process.env.ACCOUNTS_PUBLIC_KEY = "";
  process.env.PLUGINS_WATCH = "0";
  process.env.PLUGIN_JOBS = "0";
}

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
      // A plugin's own requests go to the runner test's server; the stream is a mailbox of one.
      request: { origins: () => [process.env.ACCOUNTS_REQUEST_ORIGIN ?? ""] },
      stream: {
        kind: "messages",
        pull: async (ctx: { accessToken: string }, cursor: string | null) => ({
          items: cursor ? [] : [mail(ctx.accessToken)],
          nextCursor: "c1",
          hasMore: false,
        }),
        read: async (ctx: { accessToken: string }) => mail(ctx.accessToken),
      },
      actions: mod.slackConnector.actions.map((action) =>
        action.id === "post_message"
          ? {
              ...action,
              handler: async (
                input: { channel: string; text: string },
                ctx: { accessToken: string },
              ) => {
                // A post that takes its time, so a share can be cancelled on its way.
                if (input.channel === "C0SLOW") {
                  await new Promise((r) => setTimeout(r, 3000));
                }
                appendFileSync(
                  join(DIR, "posts"),
                  `${JSON.stringify({ ...input, token: ctx.accessToken })}\n`,
                );
                return { channel: input.channel, ts: "1.0" };
              },
            }
          : action,
      ),
    },
  };
});

function mail(token: string) {
  return {
    attachments: [],
    body_html: null,
    body_text: "Hallo",
    cc: [],
    from_email: "kim@example.com",
    from_name: null,
    provider_message_id: "m1",
    provider_thread_id: null,
    received_at: null,
    subject: `read with ${token}`,
    to: [],
  };
}

describe.runIf(PORT)("the broker that opens the accounts", () => {
  it("serves the runs' services until the runner is done", { timeout: 300_000 }, async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    const { serve } = await import("@hono/node-server");
    const app = (await import("../src/app")).default;
    const server = serve({ fetch: app.fetch, port: Number(PORT), hostname: "127.0.0.1" });
    writeFileSync(join(DIR, "broker-ready"), String(process.pid));
    const stop = join(DIR, "stop");
    const until = Date.now() + 290_000;
    while (!existsSync(stop) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
    server.close();
  });
});
