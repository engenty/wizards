import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Brand fonts with a source: a font file of the space is served from our address while the
// brand names it; an address on the space's website must be https.

const dir = mkdtempSync(join(tmpdir(), "wizards-brand-fonts-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const upload = async (name: string, type: string, bytes: Uint8Array) => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  const res = await app.fetch(
    new Request(url(`/api/studio/projects/${spaceId}/files?kind=asset`), {
      method: "POST",
      headers: { cookie, origin: "http://localhost:5181" },
      body: form,
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
};

const font = (source?: unknown) => ({
  id: "f1",
  family: "Acme Sans",
  role: "Headings",
  weights: [400],
  ...(source ? { source } : {}),
});

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const projects = await import("../src/services/projects");
  spaceId = (await client.withTenant("local", () => projects.defaultProject("local"))).id;
}, 60_000);

describe("a brand font's own file", () => {
  it("is served from our address while the brand names it, to any origin", async () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);
    const id = await upload("acme.woff2", "font/woff2", bytes);
    expect((await app.fetch(new Request(url(`/api/public/fonts/${id}`)))).status).toBe(404);

    const saved = await send("PATCH", `/api/studio/projects/${spaceId}`, {
      brand: { fonts: [font({ file: id })] },
    });
    expect(saved.status).toBe(200);
    const served = await app.fetch(new Request(url(`/api/public/fonts/${id}`)));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("font/woff2");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);

    const { themes, brandFonts } = (await (
      await send("GET", `/api/studio/projects/${spaceId}/themes`)
    ).json()) as { themes: unknown[]; brandFonts: unknown };
    expect(themes).toEqual([]);
    expect(brandFonts).toEqual({
      heading: "Acme Sans",
      text: null,
      faces: [{ family: "Acme Sans", url: `/api/public/fonts/${id}`, stylesheet: false }],
    });

    await send("PATCH", `/api/studio/projects/${spaceId}`, { brand: { fonts: [font()] } });
    expect((await app.fetch(new Request(url(`/api/public/fonts/${id}`)))).status).toBe(404);
  });

  it("must be a font of the space", async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const pixel = new Uint8Array(await createCanvas(1, 1).encode("png"));
    const png = await upload("pixel.png", "image/png", pixel);
    const res = await send("PATCH", `/api/studio/projects/${spaceId}`, {
      brand: { fonts: [font({ file: png })] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Acme Sans");
    const elsewhere = await send("PATCH", `/api/studio/projects/${spaceId}`, {
      brand: { fonts: [font({ file: "not-a-file" })] },
    });
    expect(elsewhere.status).toBe(400);
  });
});

describe("a brand font on the space's website", () => {
  it("takes an https address only", async () => {
    const ok = await send("PATCH", `/api/studio/projects/${spaceId}`, {
      brand: { fonts: [font({ url: "https://acme.example/fonts/acme.woff2" })] },
    });
    expect(ok.status).toBe(200);
    const plain = await send("PATCH", `/api/studio/projects/${spaceId}`, {
      brand: { fonts: [font({ url: "http://acme.example/fonts/acme.woff2" })] },
    });
    expect(plain.status).toBe(400);
  });
});
