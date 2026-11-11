import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeHost } from "@engenty/wizards-run/node-host";
import { type ResolvedWizard, resolveWizard, WizardRefused } from "@engenty/wizards-run/resolve";
import { type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import { withRequires } from "@engenty/wizards-shared/requires";
import { PACKAGE_MIME } from "@engenty/wizards-shared/wizard-package";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePath } from "../src/cli/validate";

/**
 * `@engenty/wizards-run/resolve` (docs/plans/runs-on-their-own.md, 5.4): a wizard from a folder,
 * a `.wizard` file or an address is the same wizard, checked as `wizards validate` checks it, and
 * starts the same run.
 */

const SCORE = `
export const description = "Scores an offer";
export const input = { type: "object", properties: { price: { type: "number" } }, required: ["price"] };
export function run({ price }: { price: number }) { return { score: price / 100 }; }
`;

/** A wizard that starts at a page: the run stands there without a service. */
const definition = (extra: Record<string, unknown>[] = []) =>
  withRequires(
    wizardSchema.parse({
      title: "Offer",
      description: "Scores an offer",
      avatar: "round",
      steps: [
        {
          id: "ask",
          type: "form",
          title: "Your offer",
          fields: [{ id: "price", kind: "text", label: "Price" }],
        },
        ...extra,
        { id: "done", type: "result", title: "Done", deliverables: [] },
      ],
    }) as WizardDefinition,
  );

const manifest = (def: unknown) =>
  JSON.stringify({ format: "engenty-wizard", version: 1, definition: def }, null, 2);

const WORKSPACE: Record<string, string> = {
  "notes.md": "# Notes\n\nOffers under 100 score low.\n",
  "data/prices.csv": "item,price\nchair,80\ntable,240\n",
  "tools/score.ts": SCORE,
};

let root: string;
let server: Server;
let origin: string;
/** What the local server answers, by path. */
const served = new Map<string, { type: string; body: Uint8Array }>();

/** An unpacked package in a folder of its own. */
function folderOf(name: string, def: unknown, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "wizard.json"), manifest(def));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "files", path)), { recursive: true });
    writeFileSync(join(dir, "files", path), text);
  }
  return dir;
}

/** The same package zipped, as the studio exports it: wizard.json and files/…. */
function zipOf(def: unknown, files: Record<string, string>): Uint8Array {
  return zipSync({
    "wizard.json": strToU8(manifest(def)),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`files/${k}`, strToU8(v)])),
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "wizards-resolve-"));
  server = createServer((req, res) => {
    const found = served.get(req.url ?? "");
    if (!found) {
      res.writeHead(404).end("not here");
      return;
    }
    res.writeHead(200, { "content-type": found.type }).end(found.body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

/** What a resolved wizard is, without where it came from. */
const wizardOf = (w: ResolvedWizard) => ({ definition: w.definition, files: w.files });

/** Where a run of `w` stands once its host started it: no services are reached on the way. */
async function firstState(w: ResolvedWizard) {
  const dir = mkdtempSync(join(tmpdir(), "wizards-resolve-run-"));
  const host = await nodeHost({
    dir,
    services: {
      url: "http://127.0.0.1:9",
      token: "none",
      fetch: () => Promise.reject(new Error("a page needs no service")),
    },
    def: w.definition,
    files: w.files.map(({ data: _, ...file }) => file),
    run: { id: "run-1" },
    now: () => 1_700_000_000_000,
  });
  try {
    await host.start();
    const { run } = await host.state();
    const log = readFileSync(join(dir, "events.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const e = JSON.parse(line) as { stepId: string | null; type: string; message: string };
        return [e.stepId, e.type, e.message];
      });
    return { run, log };
  } finally {
    await host.close();
  }
}

describe("a wizard from a folder, a file or an address", () => {
  it("is the same wizard three ways, and starts the same run", async () => {
    const def = definition();
    const folder = folderOf("offer", def, WORKSPACE);
    const file = join(root, "offer.wizard");
    writeFileSync(file, zipOf(def, WORKSPACE));
    served.set("/offer.wizard", { type: PACKAGE_MIME, body: readFileSync(file) });

    const fromFolder = await resolveWizard(folder);
    const fromManifest = await resolveWizard(join(folder, "wizard.json"));
    const fromFile = await resolveWizard(file);
    const fromAddress = await resolveWizard(`${origin}/offer.wizard`);

    expect(fromFolder.source).toEqual({ kind: "folder", where: folder });
    expect(fromManifest.source).toEqual({ kind: "folder", where: folder });
    expect(fromFile.source).toEqual({ kind: "file", where: file });
    expect(fromAddress.source).toEqual({ kind: "url", where: `${origin}/offer.wizard` });

    expect(fromFolder.files.map((f) => [f.path, f.mime, f.size])).toEqual([
      ["data/prices.csv", "text/csv", WORKSPACE["data/prices.csv"].length],
      ["notes.md", "text/markdown", WORKSPACE["notes.md"].length],
      ["tools/score.ts", "application/octet-stream", SCORE.length],
    ]);
    expect(fromFolder.files[1].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fromFolder.definition.title).toBe("Offer");
    for (const other of [fromManifest, fromFile, fromAddress]) {
      expect(wizardOf(other)).toEqual(wizardOf(fromFolder));
    }

    const states = [];
    for (const w of [fromFolder, fromFile, fromAddress]) {
      states.push(await firstState(w));
    }
    expect(states[0].run).toMatchObject({ cursor: "ask", status: "waiting_input" });
    expect(states[0].log).toEqual([[null, "run_started", "Run started"]]);
    expect(states[1]).toEqual(states[0]);
    expect(states[2]).toEqual(states[0]);
  });

  it("takes an address that answers a wizard's JSON", async () => {
    const def = definition();
    served.set("/offer/wizard.json", {
      type: "application/json",
      body: strToU8(manifest(def)),
    });
    served.set("/bare.json", { type: "application/json", body: strToU8(JSON.stringify(def)) });
    const fromJson = await resolveWizard(`${origin}/offer/wizard.json`);
    const bare = await resolveWizard(`${origin}/bare.json`);
    const fromFolder = await resolveWizard(folderOf("no-files", def, {}));
    expect(fromJson.files).toEqual([]);
    expect(wizardOf(fromJson)).toEqual(wizardOf(fromFolder));
    expect(wizardOf(bare)).toEqual(wizardOf(fromFolder));
  });

  it("refuses what `wizards validate` refuses, with the same issues, and starts nothing", async () => {
    const def = definition([
      {
        id: "work",
        type: "agent",
        title: "Work",
        instructions: "Score it.",
        tools: ["wizard.score", "wizard.gone"],
        output: { format: "text" },
      },
    ]);
    const files = { ...WORKSPACE, "tools/other.ts": "export function run() {}" };
    const folder = folderOf("broken", def, files);
    const file = join(root, "broken.wizard");
    writeFileSync(file, zipOf(def, files));
    served.set("/broken.wizard", { type: PACKAGE_MIME, body: readFileSync(file) });

    const validated = await validatePath(folder);
    expect(validated.ok).toBe(false);
    for (const source of [folder, file, `${origin}/broken.wizard`]) {
      const refused = await resolveWizard(source).catch((err) => err);
      expect(refused).toBeInstanceOf(WizardRefused);
      expect((refused as WizardRefused).issues).toEqual(validated.issues);
      expect((refused as WizardRefused).message).toContain('Tool "wizard.gone" has no file');
    }
  });

  it("refuses a source it can't read", async () => {
    const issue = (source: string, options?: Parameters<typeof resolveWizard>[1]) =>
      resolveWizard(source, options).then(
        () => null,
        (err: WizardRefused) => [err.source.kind, err.issues.map((i) => i.message)],
      );
    expect(await issue(join(root, "nowhere"))).toEqual(["file", ["No such file or folder."]]);
    mkdirSync(join(root, "empty"));
    expect(await issue(join(root, "empty"))).toEqual([
      "folder",
      ["This isn’t a wizard file: wizard.json is missing."],
    ]);
    expect(await issue("ftp://example.com/offer.wizard")).toEqual([
      "url",
      ["Only an http or https address can be opened."],
    ]);
    expect(await issue(`${origin}/missing.wizard`)).toEqual([
      "url",
      [`${origin}/missing.wizard answered 404 Not Found`],
    ]);
    // Larger than a wizard file may be: refused before the body is read.
    const big = () =>
      Promise.resolve(new Response("x", { headers: { "content-length": String(31_000_000) } }));
    expect(await issue("https://example.com/big.wizard", { fetch: big })).toEqual([
      "url",
      ["The wizard file is too large: a workspace holds at most 200 files and 25 MB."],
    ]);
    // An address that doesn't answer in time.
    const never: typeof fetch = (_, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    expect(await issue("https://example.com/slow.wizard", { fetch: never, timeoutMs: 50 })).toEqual(
      ["url", ["https://example.com/slow.wizard didn’t answer within 0.05 seconds."]],
    );
    // A request carries nothing but the address.
    let sent: RequestInit | undefined;
    const seen: typeof fetch = (_, init) => {
      sent = init;
      return Promise.resolve(new Response("{", { status: 200 }));
    };
    expect(await issue("https://example.com/x.wizard", { fetch: seen })).toEqual([
      "url",
      ["This isn’t a wizard file: its wizard.json can’t be read."],
    ]);
    expect(Object.keys(sent?.headers ?? {})).toEqual(["accept"]);
    expect(sent?.credentials).toBe("omit");
  });
});
