import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-codes-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.MOBILE_IOS_APP_IDS = "TEAM123456.ai.engenty.wizards";
process.env.MOBILE_ANDROID_CERT_SHA256 = "AA:BB";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let control: typeof import("../src/tenants/control");

const definition = {
  version: 1,
  title: "Übergabe",
  description: "Wohnungsübergabe",
  avatar: "dome",
  steps: [
    {
      id: "start",
      type: "form",
      title: "Start",
      fields: [{ id: "name", kind: "text", label: "Name" }],
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

let wizardId: string;
let shareToken: string;

const get = (path: string) => app.fetch(new Request(`http://localhost:5181${path}`));

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  control = await import("../src/tenants/control");
  app = (await import("../src/app")).default;
  await client.withTenant("tenant-a", async () => {
    wizardId = (await wizards.createWizard("user-a", { definition })).id;
    await wizards.publishWizard("user-a", wizardId);
    shareToken = (await wizards.ownedWizard("user-a", wizardId)).shareToken;
  });
}, 60_000);

describe("wizard IDs", () => {
  it("makes one ID per share token, 8 capitals and digits without look-alikes", async () => {
    const code = await client.withTenant("tenant-a", () => control.codeOf(shareToken));
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(await client.withTenant("tenant-a", () => control.codeOf(shareToken))).toBe(code);
  });

  it("answers the share token of an ID, typed in any case and with spaces", async () => {
    const code = await client.withTenant("tenant-a", () => control.codeOf(shareToken));
    const typed = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`;
    const res = await get(`/api/public/codes/${encodeURIComponent(typed)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: shareToken,
      url: `http://localhost:5181/w/${shareToken}`,
    });
    expect((await get("/api/public/codes/ZZZZZZZZ")).status).toBe(404);
  });

  it("gives a new ID when the link rotates; the old one stops working", async () => {
    const old = await client.withTenant("tenant-a", () => control.codeOf(shareToken));
    const rotated = await client.withTenant("tenant-a", () =>
      wizards.rotateShareLink("user-a", wizardId),
    );
    expect((await get(`/api/public/codes/${old}`)).status).toBe(404);
    const fresh = await client.withTenant("tenant-a", () => control.codeOf(rotated.shareToken));
    expect(fresh).not.toBe(old);
    expect(await (await get(`/api/public/codes/${fresh}`)).json()).toMatchObject({
      token: rotated.shareToken,
    });
  });

  it("serves the files that open wizard and result links in the app", async () => {
    const apple = await (await get("/.well-known/apple-app-site-association")).json();
    expect(apple.applinks.details[0]).toEqual({
      appIDs: ["TEAM123456.ai.engenty.wizards"],
      components: [{ "/": "/w/*" }, { "/": "/s/*" }],
    });
    const android = await (await get("/.well-known/assetlinks.json")).json();
    expect(android[0].target).toEqual({
      namespace: "android_app",
      package_name: "ai.engenty.wizards",
      sha256_cert_fingerprints: ["AA:BB"],
    });
  });

  it("keeps the app's push device for a run its visitor started, and only for that visitor", async () => {
    const vid = "app-visitor-0123456789ab";
    // The link rotated in a test before: the wizard's token now.
    const token = (
      await client.withTenant("tenant-a", () => wizards.ownedWizard("user-a", wizardId))
    ).shareToken;
    const started = await app.fetch(
      new Request(`http://localhost:5181/api/public/wizards/${token}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `wz_vid=${vid}` },
        body: "{}",
      }),
    );
    expect(started.status).toBe(200);
    const { runId } = (await started.json()) as { runId: string };
    const device = { token: "a1b2c3d4e5f6a7b8", platform: "ios", lang: "de" };
    const post = (cookie: string) =>
      app.fetch(
        new Request(`http://localhost:5181/api/runs/${runId}/notify`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(device),
        }),
      );
    expect((await post("wz_vid=someone-else-000000000")).status).toBe(404);
    const res = await post(`wz_vid=${vid}`);
    expect(res.status).toBe(200);
    // A runtime without the Manage-App has no push to send.
    expect(await res.json()).toEqual({ push: false });
    const row = await client.controlDb.query.runIndex.findFirst({
      where: (r, { eq }) => eq(r.runId, runId),
    });
    expect(row?.push).toEqual(device);
  });
});
