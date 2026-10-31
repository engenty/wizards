import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-health-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let health: typeof import("../src/health");

const get = (path: string) => app.fetch(new Request(`http://localhost:5181${path}`));

beforeAll(async () => {
  const { migrateControlDb } = await import("../src/db/client");
  await migrateControlDb();
  const control = await import("../src/tenants/control");
  // A runtime that runs alone is its own runner: it reports as one when it starts (index.ts).
  await control.registerRunner();
  await control.markLine();
  health = await import("../src/health");
  app = (await import("../src/app")).default;
}, 60_000);

describe("readiness", () => {
  it("answers each check's status, and nothing else, to anyone", async () => {
    const res = await get("/api/health/ready");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.role).toBe("all");
    expect(body.checks).toEqual({
      process: "ok",
      control: "ok",
      tenants: "ok",
      databases: "ok",
      objects: "ok",
      line: "ok",
    });
    expect(JSON.stringify(body)).not.toMatch(/error|detail|ms/);
  });

  it("keeps the answer, so a public endpoint never loads the databases", async () => {
    const a = await (await get("/api/health/ready")).json();
    const b = await (await get("/api/health/ready")).json();
    expect(b.checkedAt).toBe(a.checkedAt);
  });

  it("reports a check that never answers as down, and never starts it twice", async () => {
    const never = () => new Promise<undefined>(() => undefined);
    const started = Date.now();
    const first = await health.timed("never", never);
    expect(first.status).toBe("down");
    expect(first.error).toMatch(/no answer within/);
    expect(Date.now() - started).toBeLessThan(3000);
    const second = await health.timed("never", never);
    expect(second.status).toBe("down");
    expect(second.error).toMatch(/still waiting since/);
    expect(second.ms).toBe(0);
  });

  it("reports a failing check with its error, secrets taken out", async () => {
    const r = await health.timed("fails", async () => {
      throw new Error("refused: Bearer abcdefghijklmnop\nsecond line");
    });
    expect(r.status).toBe("down");
    expect(r.error).toBe("refused: Bearer [redacted]");
  });

  it("reports tenant databases that don't open", async () => {
    const { controlDb, control, tenantDb } = await import("../src/db/client");
    await tenantDb("works");
    await controlDb
      .insert(control.tenant)
      .values({ id: "broken", dbUrl: `file:${join(dir, "no-such-folder", "broken.db")}` });
    await expect(tenantDb("broken")).rejects.toThrow();
    const r = await health.databasesCheck();
    expect(r?.status).toBe("degraded");
    expect(r?.error).toMatch(/1 of \d+ tenant databases don't open/);
    expect(r?.detail).toEqual({ failing: [{ id: "broken", at: expect.any(String) }] });
    await controlDb.delete(control.tenant).where(eq(control.tenant.id, "works"));
    expect((await health.databasesCheck())?.status).toBe("down");
  });

  it("counts requests until their handler returned", async () => {
    const done = health.requestStarted("GET", "/api/runs/x");
    const h = await health.health();
    expect(h.checks.process.status).toBe("ok");
    done();
  });
});
