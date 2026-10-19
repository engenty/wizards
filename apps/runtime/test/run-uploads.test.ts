import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-run-uploads-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let storage: typeof import("../src/files/storage");

const definition = {
  version: 1,
  title: "Schaden melden",
  description: "Fotos und Unterlagen",
  avatar: "dome",
  steps: [
    {
      id: "start",
      type: "page",
      title: "Unterlagen",
      fields: [{ id: "doc", kind: "file", label: "Datei" }],
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

const cookie = "wz_vid=run-uploads-0123456789ab";
let runId = "";

/** A multipart upload written by hand: the part's type is exactly what a sender puts there. */
function post(type: string, body: string | Uint8Array, name: string) {
  const boundary = "----wizards-test-boundary";
  const head = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${name}"`,
    `Content-Type: ${type}`,
    "",
    "",
  ].join("\r\n");
  const payload = Buffer.concat([
    Buffer.from(head),
    Buffer.from(body),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.fetch(
    new Request(`http://localhost:5181/api/runs/${runId}/uploads`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, cookie },
      body: payload,
    }),
  );
}

async function upload(type: string, body: string | Uint8Array, name = "x.bin") {
  const res = await post(type, body, name);
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; mime: string; name: string };
}

/** A real 4 × 4 PNG. */
async function png() {
  const { createCanvas } = await import("@napi-rs/canvas");
  return new Uint8Array(await createCanvas(4, 4).encode("png"));
}

/** The start of a WebM recording, then ten bytes that stand for the sound. */
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("0123456789")]);

const asset = (id: string, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://localhost:5181/api/runs/${runId}/assets/${id}`, {
      headers: { cookie, ...headers },
    }),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  storage = await import("../src/files/storage");
  const wizards = await import("../src/services/wizards");
  app = (await import("../src/app")).default;
  const token = await client.withTenant("tenant-a", async () => {
    const { id } = await wizards.createWizard("user-a", { definition });
    await wizards.publishWizard("user-a", id);
    return (await wizards.ownedWizard("user-a", id)).shareToken;
  });
  const started = await app.fetch(
    new Request(`http://localhost:5181/api/public/wizards/${token}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    }),
  );
  expect(started.status).toBe(200);
  runId = ((await started.json()) as { runId: string }).runId;
}, 60_000);

describe("a visitor's upload, served back", () => {
  it("never comes back as a page, whatever type the sender wrote", async () => {
    for (const type of ["text/html,x", "text/plain,text/html", "text/html", "image/png,text/html"]) {
      const ref = await upload(type, "<script>parent.owned = 1</script>", "x.html");
      expect(ref.mime, type).toBe("application/octet-stream");
      const res = await asset(ref.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(await res.text()).toContain("<script>");
    }
  });

  it("shows a photo in place, sandboxed, and an SVG only as a download", async () => {
    const photo = await upload("image/png", await png(), "photo.png");
    expect(photo.mime).toBe("image/png");
    const shown = await asset(photo.id);
    expect(shown.headers.get("content-type")).toBe("image/png");
    expect(shown.headers.get("content-security-policy")).toBe("sandbox");
    expect(shown.headers.get("content-disposition")).toBeNull();

    const svg = await upload("image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>", "a.svg");
    const drawn = await asset(svg.id);
    expect(drawn.headers.get("content-type")).toBe("image/svg+xml");
    expect(drawn.headers.get("content-security-policy")).toBe("sandbox");
    expect(drawn.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("plays a recording in parts and leaves a PDF to the browser's viewer", async () => {
    const voice = await upload("audio/webm;codecs=opus", webm, "note.webm");
    expect(voice.mime).toBe("audio/webm");
    const part = await asset(voice.id, { range: "bytes=6-9" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-type")).toBe("audio/webm");
    expect(part.headers.get("content-range")).toBe("bytes 6-9/14");
    expect(await part.text()).toBe("2345");

    const pdf = await upload("application/pdf", "%PDF-1.4", "a.pdf");
    const opened = await asset(pdf.id);
    expect(opened.headers.get("content-type")).toBe("application/pdf");
    expect(opened.headers.get("content-disposition")).toBeNull();
    expect(opened.headers.get("content-security-policy")).toBeNull();
  });

  it("refuses a page that says it is a photo, and says why", async () => {
    const res = await post("image/png", "<html><script>parent.owned = 1</script>", "x.png");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/picture/);
  });

  it("refuses a recording that isn't one", async () => {
    const res = await post("audio/webm", "0123456789", "note.webm");
    expect(res.status).toBe(400);
  });

  it("keeps a clean name and an SVG without its script", async () => {
    const ref = await upload(
      "image/svg+xml",
      "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script><rect width='1'/></svg>",
      "../logo\u202Egvs.svg",
    );
    expect(ref.name).toBe("logogvs.svg");
    const res = await asset(ref.id);
    const body = await res.text();
    expect(body).toContain("<rect");
    expect(body).not.toContain("script");
  });

  it("does not echo a type kept before uploads were checked", async () => {
    // Written straight to storage, as an upload from before this check would have been kept.
    const old = await client.withTenant("tenant-a", () =>
      storage.saveAsset({
        runId,
        kind: "upload",
        mime: "text/html,x",
        name: "old.html",
        data: new TextEncoder().encode("<script>parent.owned = 1</script>"),
      }),
    );
    const res = await asset(old.id);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("still shows a step's own HTML as a page, in its opaque origin", async () => {
    const page = await client.withTenant("tenant-a", () =>
      storage.saveAsset({
        runId,
        kind: "html",
        mime: "text/html",
        name: "start.html",
        data: new TextEncoder().encode("<!doctype html><p>Hallo</p>"),
      }),
    );
    const res = await asset(page.id);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts/);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).toContain("Hallo");
  });
});
