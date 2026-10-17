import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A stand-in for the account (sign-in, tokens) and its cloud runtime (the spaces API): it keeps
// what a local install sent and answers as told.
interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body: any;
}
const seen: Seen[] = [];
/** The answer to the next sending of a wizard; back to "take it" afterwards. */
let refuseWith: { status: number; body: unknown } | null = null;
const cloudSpaces: { id: string; name: string; syncedAt: null; wizards: [] }[] = [];
let origin = "";

const unsigned = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const cloud: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
      token_endpoint: `${origin}/token`,
      jwks_uri: `${origin}/jwks`,
    });
  }
  if (url.pathname === "/token") {
    return json({
      access_token: unsigned({
        sub: "user-1",
        tenant: "tenant-1",
        name: "Clara",
        email: "clara@test.local",
        scope: "wizards:read wizards:write wizards:publish",
      }),
      refresh_token: "refresh-2",
      expires_in: 600,
    });
  }
  const entry: Seen = {
    method: req.method ?? "",
    path: url.pathname,
    authorization: req.headers.authorization,
    body: raw ? JSON.parse(raw) : null,
  };
  seen.push(entry);
  if (url.pathname === "/api/v1/spaces" && req.method === "GET") {
    return json({ spaces: cloudSpaces });
  }
  if (url.pathname === "/api/v1/spaces/check") {
    return json({
      problems: [{ code: "sandbox", blocking: false, steps: [{ id: "w", title: "W" }], detail: "" }],
    });
  }
  if (/^\/api\/v1\/spaces\/[^/]+\/data$/.test(url.pathname) && req.method === "PUT") {
    const sent = JSON.parse(raw || "{}");
    return json({ tables: sent.tables?.length ?? 0, pages: sent.pages?.length ?? 0 });
  }
  if (/^\/api\/v1\/spaces\/[^/]+\/wizards\/[^/]+\/rotate-link$/.test(url.pathname)) {
    return json({ shareUrl: `${origin}/w/cloudtoken00002`, code: "K7WM4TQ9" });
  }
  const wizard = url.pathname.match(/^\/api\/v1\/spaces\/([^/]+)\/wizards\/([^/]+)$/);
  if (wizard && req.method === "PUT") {
    if (refuseWith) {
      const refusal = refuseWith;
      refuseWith = null;
      return json(refusal.body, refusal.status);
    }
    return json({
      wizardId: wizard[2],
      shareUrl: `${origin}/w/cloudtoken00001`,
      shareEnabled: entry.body.shareEnabled,
      publishedVersion: entry.body.version,
      runnable: true,
      problems: [],
    });
  }
  if (wizard || /^\/api\/v1\/spaces\/[^/]+$/.test(url.pathname)) {
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
});
await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-cloud-"));
process.env.APP_URL = "http://localhost:5181";
process.env.ACCOUNT_URL = origin;
process.env.CLOUD_URL = origin;
process.env.PLUGINS_WATCH = "0";

let client: typeof import("../src/db/client");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");
let projects: typeof import("../src/services/projects");
let sync: typeof import("../src/services/cloud");

const USER = "local";
const local = <T>(fn: () => Promise<T>) => client.withTenant("local", fn);

const definition = (title: string) => ({
  version: 1,
  title,
  description: "",
  avatar: "round",
  steps: [
    { id: "start", type: "page", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
});

async function link() {
  const { vaultSet } = await import("../src/secrets/vault");
  const { writeSetting } = await import("../src/settings");
  await vaultSet("account.refresh", "refresh-1");
  await writeSetting("account", {
    userId: "user-1",
    tenantId: "tenant-1",
    name: "Clara",
    email: "clara@test.local",
  });
}

const sent = (method: string) => seen.filter((s) => s.method === method && s.path.includes("/wizards/"));

let wizardId = "";
let projectId = "";

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  projects = await import("../src/services/projects");
  sync = await import("../src/services/cloud");
  await local(async () => {
    wizardId = (await wizards.createWizard(USER, { definition: definition("Angebot") })).id;
    await files.writeFile(USER, wizardId, "prices.csv", "a;1\n");
    const project = await projects.defaultProject(USER);
    projectId = project.id;
    await projects.updateProject(USER, projectId, { brand: { name: "Tischlerei Holz" } });
  });
}, 60_000);

afterAll(() => cloud.close());

describe("a runtime that runs alone and the cloud of its account", () => {
  it("publishes only here while no account is linked", async () => {
    const published = await local(() => sync.publishAndSync(USER, wizardId));
    expect(published).toMatchObject({ version: 1, cloud: null });
    expect(seen).toEqual([]);
    expect(await sync.cloudLinked()).toBe(false);
  });

  it("opens the account's sign-up page with the code, which goes on to the sign-in", async () => {
    const { startLink } = await import("../src/auth/account");
    const signIn = new URL(await startLink());
    expect(signIn.pathname).toBe("/api/auth/oauth2/authorize");
    expect(signIn.searchParams.get("client_id")).toBe("wizards-desktop");

    const signUp = new URL(await startLink({ signup: true, code: " ABCD2345 " }));
    expect(signUp.origin).toBe(origin);
    expect(signUp.pathname).toBe("/sign-up");
    expect(signUp.searchParams.get("code")).toBe("ABCD2345");
    const next = signUp.searchParams.get("next") ?? "";
    expect(next.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
    expect(new URLSearchParams(next.split("?")[1]).get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/callback$/,
    );
  });

  it("sends what it publishes once an account is linked", async () => {
    await link();
    expect(await sync.cloudLinked()).toBe(true);
    const published = await local(() => sync.publishAndSync(USER, wizardId));
    expect(published.version).toBe(2);
    expect(published.cloud).toMatchObject({
      copy: {
        shareUrl: `${origin}/w/cloudtoken00001`,
        version: 2,
        publishedVersion: 2,
        runnable: true,
      },
      error: null,
    });
    const [put] = sent("PUT");
    // Under the ids the wizard and its project have here, as the account's person.
    expect(put.path).toBe(`/api/v1/spaces/${projectId}/wizards/${wizardId}`);
    expect(put.authorization).toMatch(/^Bearer e30\./);
    expect(put.body).toMatchObject({
      space: { name: "My computer", brand: { name: "Tischlerei Holz" }, facts: [], logo: null },
      version: 2,
      definition: { title: "Angebot" },
      shareEnabled: true,
    });
    expect(put.body.files).toEqual([
      { path: "prices.csv", mime: "text/csv", data: Buffer.from("a;1\n").toString("base64") },
    ]);
    expect(await sync.cloudState(wizardId)).toMatchObject({ copy: { version: 2 }, error: null });
  });

  it("sends the published version, not the draft that went on", async () => {
    await local(async () => {
      const w = await wizards.ownedWizard(USER, wizardId);
      await wizards.writeDraft(USER, wizardId, {
        definition: definition("Angebot (Entwurf)"),
        baseRevision: w.revision,
      });
      await sync.syncToCloud(USER, wizardId);
    });
    expect(sent("PUT").at(-1)?.body).toMatchObject({ version: 2, definition: { title: "Angebot" } });
  });

  it("lets the copy follow how the wizard is shared", async () => {
    await local(async () => {
      await wizards.updateWizardSettings(USER, wizardId, { shareEnabled: false, dailyRunLimit: 9 });
      await sync.pushSharing(USER, wizardId);
    });
    expect(sent("PATCH").at(-1)).toMatchObject({
      path: `/api/v1/spaces/${projectId}/wizards/${wizardId}`,
      body: { shareEnabled: false, dailyRunLimit: 9 },
    });
  });

  it("gives the copy a new link when one is made here", async () => {
    const state = await local(() => sync.rotateInCloud(USER, wizardId));
    expect(sent("POST").at(-1)).toMatchObject({
      path: `/api/v1/spaces/${projectId}/wizards/${wizardId}/rotate-link`,
    });
    expect(state?.copy).toMatchObject({ shareUrl: `${origin}/w/cloudtoken00002`, code: "K7WM4TQ9" });
    expect((await local(() => sync.cloudState(wizardId))).copy?.shareUrl).toBe(
      `${origin}/w/cloudtoken00002`,
    );
  });

  it("keeps the copy from before when the cloud refuses, and says why", async () => {
    refuseWith = {
      status: 400,
      body: {
        error: "Dieses Konto hat hier schon ein Projekt.",
        code: "refused",
        reason: "space_limit",
        spaces: [{ id: "old-space", name: "Alter Rechner" }],
      },
    };
    const published = await local(() => sync.publishAndSync(USER, wizardId));
    // Publishing here went through; the cloud's refusal comes along.
    expect(published.version).toBe(3);
    expect(published.cloud).toMatchObject({
      copy: { version: 2 },
      error: { reason: "space_limit", message: "Dieses Konto hat hier schon ein Projekt." },
    });
  });

  it("tries again by itself after an error of the cloud's own, not after a refusal", async () => {
    // No room: only the person can help, so no try is planned.
    expect((await sync.cloudState(wizardId)).error).toMatchObject({ tries: 1, again: null });

    refuseWith = { status: 500, body: { error: "Interner Fehler" } };
    const failed = await local(() => sync.syncToCloud(USER, wizardId));
    expect(failed.error).toMatchObject({ message: "Interner Fehler", reason: "refused", tries: 2 });
    // A minute, then twice as long each time: the second try comes two minutes after.
    const planned = new Date(failed.error?.again ?? 0).getTime() - Date.parse(failed.error?.at ?? 0);
    expect(planned).toBe(2 * 60_000);

    // Not due yet: nothing is sent.
    const before = seen.length;
    await local(() => sync.retryFailedSends(USER));
    expect(seen.length).toBe(before);

    // Due: sent, and the copy is current again.
    const { writeSetting } = await import("../src/settings");
    await writeSetting(`cloud:${wizardId}`, {
      ...failed,
      error: { ...failed.error, again: new Date(Date.now() - 1000).toISOString() },
    });
    await local(() => sync.retryFailedSends(USER));
    expect(seen.slice(before).map((s) => `${s.method} ${s.path}`)).toEqual([
      `PUT /api/v1/spaces/${projectId}/wizards/${wizardId}`,
    ]);
    expect(await sync.cloudState(wizardId)).toMatchObject({ copy: { version: 3 }, error: null });
  });

  it("makes room by removing another install's project, then sends everything", async () => {
    cloudSpaces.push(
      { id: "old-space", name: "Alter Rechner", syncedAt: null, wizards: [] },
      { id: projectId, name: "Meine Wizards", syncedAt: null, wizards: [] },
    );
    const before = seen.length;
    const result = await local(() => sync.replaceCloudSpaces(USER));
    expect(result).toEqual({ sent: 1, failed: 0 });
    const calls = seen.slice(before).map((s) => `${s.method} ${s.path}`);
    expect(calls).toEqual([
      "GET /api/v1/spaces",
      // Only the other install's project goes.
      "DELETE /api/v1/spaces/old-space",
      `PUT /api/v1/spaces/${projectId}/wizards/${wizardId}`,
      // The space's own tables and pages go again: the cloud's copy of the space is new.
      `PUT /api/v1/spaces/${projectId}/data`,
    ]);
    expect(await sync.cloudState(wizardId)).toMatchObject({ copy: { version: 3 }, error: null });
  });

  it("asks the cloud what the draft would lack there", async () => {
    const check = await local(() => sync.checkForCloud(USER, wizardId));
    expect(check).toEqual({
      problems: [{ code: "sandbox", blocking: false, steps: [{ id: "w", title: "W" }], detail: "" }],
      documents: false,
    });
    expect(seen.at(-1)).toMatchObject({
      path: "/api/v1/spaces/check",
      body: { definition: { title: "Angebot (Entwurf)" }, files: ["prices.csv"] },
    });
  });

  it("takes the copy away with the wizard", async () => {
    await local(async () => {
      await sync.removeFromCloud(USER, wizardId);
      await wizards.deleteWizard(USER, wizardId);
    });
    expect(sent("DELETE").at(-1)?.path).toBe(`/api/v1/spaces/${projectId}/wizards/${wizardId}`);
    expect(await sync.cloudState(wizardId)).toEqual({ copy: null, error: null });
  });

  it("is told when the cloud is out of reach, without failing the publishing", async () => {
    const other = await local(async () => {
      const made = await wizards.createWizard(USER, { definition: definition("Zweiter") });
      return made.id;
    });
    cloud.close();
    await new Promise((r) => setTimeout(r, 50));
    const published = await local(() => sync.publishAndSync(USER, other));
    expect(published.version).toBe(1);
    expect(published.cloud).toMatchObject({ copy: null, error: { reason: "unreachable" } });
  });
});
