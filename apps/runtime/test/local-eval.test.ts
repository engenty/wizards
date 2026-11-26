import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-local-eval-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let ticket: (purpose: "local-eval" | "local-debug") => string;
let oldWizard: string;

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  const { env } = await import("../src/env");
  const { mintLocalTicket } = await import("../src/auth/local-ticket");
  ticket = (purpose) => mintLocalTicket(env.authSecret, Date.now(), purpose);
  app = (await import("../src/app")).default;
  const { LOCAL_TENANT } = await import("../src/tenants/tenant");
  const wizards = await import("../src/services/wizards");
  const def = {
    version: 1,
    title: "Old offer",
    description: "",
    avatar: "round",
    steps: [{ id: "done", type: "result", title: "Done", deliverables: [] }],
  };
  oldWizard = await client.withTenant(LOCAL_TENANT, async () => {
    const created = await wizards.createWizard("local", { definition: def as never });
    return created.id;
  });
}, 60_000);

const post = (body: unknown, headers: Record<string, string>) =>
  app.fetch(
    new Request("http://localhost:5181/api/local/eval", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
const dataset = [{ name: "one", input: {} }];

describe("wizards eval, as the runtime answers it", () => {
  it("is refused without the ticket of its own purpose", async () => {
    expect((await post({ wizard: oldWizard, dataset }, {})).status).toBe(401);
    expect((await post({ wizard: oldWizard, dataset }, { "x-engenty-local": ticket("local-debug") })).status).toBe(401);
  });

  it("says what is wrong with the dataset, and with a wizard it doesn't know", async () => {
    const bad = await post({ wizard: oldWizard, dataset: [{ input: {} }] }, { "x-engenty-local": ticket("local-eval") });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("0.name");
    const none = await post({ wizard: "Nothing here", dataset }, { "x-engenty-local": ticket("local-eval") });
    expect(none.status).toBe(404);
  });

  it("finds the wizard by its title, and runs only a wizard in version 0.3.0", async () => {
    const res = await post({ wizard: "Old offer", dataset }, { "x-engenty-local": ticket("local-eval") });
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ error: "Only a wizard in version 0.3.0 has evals to run.", code: "refused" }]);
  });
});
