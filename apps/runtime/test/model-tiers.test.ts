import { mkdtempSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A stand-in Manage-App and gateway: tenant A has `modelTiers` on and a tier, tenant B neither.
const SERVICE_KEY = "wzr_test_service_key";
const calls: { path: string; headers: IncomingHttpHeaders }[] = [];

const server: Server = createServer(async (req, res) => {
  for await (const _ of req) {
    // drain
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith("/v1/tenants/")) {
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    return json({
      id,
      name: id,
      status: "active",
      balanceCredits: 100,
      limits: { concurrentRuns: 2 },
      db: null,
      features: { modelTiers: id === "tenant-a" },
      ...(id === "tenant-a"
        ? {
            tier: {
              id: "eu-private",
              name: "EU Private",
              locked: false,
              rules: {
                regions: ["EU"],
                zdr: true,
                noTraining: true,
                ownKeys: false,
                search: false,
                decisions: false,
              },
              classes: {
                high: { model: "maker/model-h", name: "Model H", route: null, region: null },
                "anthropic/high": {
                  model: "anthropic/model-a",
                  name: "Model A",
                  route: "Route",
                  region: "Frankfurt",
                },
              },
            },
          }
        : {}),
    });
  }
  if (url.pathname === "/v1/models") {
    return json({ markup: 2, classes: {}, webSearchCredits: 2 });
  }
  calls.push({ path: url.pathname, headers: req.headers });
  // Refused: what the call asked for is all this test reads, and what the gateway masked.
  res.setHeader("x-wizards-masked", JSON.stringify({ person: 2, email: 1 }));
  return json({ error: { message: "refused", type: "outside_tier" } }, 403);
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-model-tiers-"));
process.env.APP_URL = "http://localhost:5181";
process.env.MANAGE_URL = base;
process.env.GATEWAY_URL = base;
process.env.MANAGE_SERVICE_KEY = SERVICE_KEY;
process.env.SECRETS = "file";

let withTenant: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
let models: typeof import("../src/models");

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  withTenant = client.withTenant;
  models = await import("../src/models");
});

afterAll(() => {
  server.close();
});

/** The gateway call one text call of the tenant makes. */
async function callOf(tenant: string, meta: Parameters<typeof models.textModel>[1]) {
  calls.length = 0;
  await withTenant(tenant, async () => {
    const resolved = await models.textModel("high", meta);
    await generateText({ model: resolved.model as never, prompt: "x", maxRetries: 0 }).catch(
      () => null,
    );
  });
  return calls.find((c) => c.path.endsWith("/language-model"));
}

describe("gateway calls of an organization with a tier", () => {
  it("ask for the maker class and say a run's call is for a wizard", async () => {
    const call = await callOf("tenant-a", {
      runId: "run-1",
      stepId: "draft",
      makerClass: "anthropic/high",
    });
    expect(call?.headers["ai-language-model-id"]).toBe("wizards/anthropic/high");
    expect(call?.headers["x-wizards-purpose"]).toBe("wizard");
    expect(call?.headers["x-wizards-run"]).toBe("run-1");
    expect(call?.headers["x-wizards-tenant"]).toBe("tenant-a");
  });

  it("say a call outside a run is for the assistant, and keep the plain class without a maker", async () => {
    const call = await callOf("tenant-a", {});
    expect(call?.headers["ai-language-model-id"]).toBe("wizards/high");
    expect(call?.headers["x-wizards-purpose"]).toBe("assistant");
    expect(call?.headers["x-wizards-run"]).toBeUndefined();
  });

  it("take the purpose a caller names", async () => {
    const call = await callOf("tenant-a", { purpose: "work" });
    expect(call?.headers["x-wizards-purpose"]).toBe("work");
  });

  it("keep what the gateway masked in a run's step until its Log line takes it", async () => {
    await callOf("tenant-a", { runId: "run-m", stepId: "draft" });
    await callOf("tenant-a", { runId: "run-m", stepId: "draft" });
    expect(models.takeMasked("run-m", "draft")).toEqual({ person: 4, email: 2 });
    expect(models.takeMasked("run-m", "draft")).toBeNull();
  });

  it("name the model the maker class runs on in the tier", async () => {
    await withTenant("tenant-a", async () => {
      const resolved = await models.textModel("high", { makerClass: "anthropic/high" });
      expect(resolved.ref).toBe("anthropic/model-a");
    });
  });
});

describe("side doors of an organization with a tier", () => {
  it("take no evaluation model and no web search where the tier allows neither", async () => {
    expect(await withTenant("tenant-a", () => models.systemOneAccess({ runId: "run-1" }))).toBeNull();
    expect(await withTenant("tenant-a", () => models.searchAllowed())).toBe(false);
    expect(await withTenant("tenant-b", () => models.searchAllowed())).toBe(true);
  });
});

describe("gateway calls while modelTiers is off", () => {
  it("ask for the class and send no purpose, whatever the step names", async () => {
    const call = await callOf("tenant-b", { runId: "run-2", makerClass: "anthropic/high" });
    expect(call?.headers["ai-language-model-id"]).toBe("wizards/high");
    expect(call?.headers["x-wizards-purpose"]).toBeUndefined();
    expect(call?.headers["x-wizards-run"]).toBe("run-2");
  });
});

describe("the studio's models endpoint", () => {
  it("names the organization's tier while modelTiers is on, and none while it is off", async () => {
    const a = await withTenant("tenant-a", () => models.modelSettings());
    expect(a.tier?.name).toBe("EU Private");
    expect(a.tier?.classes["anthropic/high"]).toMatchObject({ name: "Model A", region: "Frankfurt" });
    const b = await withTenant("tenant-b", () => models.modelSettings());
    expect(b.tier).toBeNull();
  });
});
