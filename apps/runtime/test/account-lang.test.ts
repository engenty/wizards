import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-account-lang-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.PLUGINS_WATCH = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
}, 60_000);

describe("the language a person picks", () => {
  it("is kept with them: none until they pick, then the one they picked", async () => {
    expect((await (await send("GET", "/api/studio/me")).json()).lang).toBeNull();
    expect((await send("PUT", "/api/studio/lang", { lang: "en" })).status).toBe(200);
    expect((await (await send("GET", "/api/studio/me")).json()).lang).toBe("en");
    await send("PUT", "/api/studio/lang", { lang: "de" });
    expect((await (await send("GET", "/api/studio/me")).json()).lang).toBe("de");
  });

  it("takes only a language the studio speaks, and only from the person", async () => {
    expect((await send("PUT", "/api/studio/lang", { lang: "fr" })).status).toBe(400);
    const stranger = await app.fetch(
      new Request(url("/api/studio/lang"), {
        method: "PUT",
        headers: { "content-type": "application/json", origin: "http://localhost:5181" },
        body: JSON.stringify({ lang: "en" }),
      }),
    );
    expect(stranger.status).toBe(401);
  });
});
