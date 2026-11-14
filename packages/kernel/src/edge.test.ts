import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadWizard } from "./compile";
import type { Run, Wizard } from "./types";

/**
 * The kernel with no Node in it: bundled for workerd, QuickJS from a compiled WebAssembly module,
 * each run a Durable Object. The model is a stand-in that always writes an offer of 8,400.
 */
const here = new URL(".", import.meta.url).pathname;
const require = createRequire(import.meta.url);
let worker: Miniflare;

const nap: Wizard = {
  file: { title: "Nap", start: "nap", edges: { nap: ["end"] }, output: { woke: "nap.timedOut" } },
  steps: {
    nap: "var __step = { default: async (run, ask) => ({ value: await ask({ type: 'wait', timeout: '1s' }) }) };",
  },
};

beforeAll(async () => {
  const offer = await loadWizard(new URL("../examples/offer/", import.meta.url).pathname);
  const entry = `
    import wasm from "./quickjs.wasm";
    import variant from "@jitl/quickjs-wasmfile-release-sync";
    import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
    import { createSandbox } from "${here}sandbox";
    import { runObject } from "${here}edge";

    const WIZARDS = ${JSON.stringify({ offer, nap })};
    const sandbox = createSandbox(() => newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule: wasm })));

    export const RunObject = runObject({
      sandbox,
      wizards: (id) => WIZARDS[id],
      batteries: { agent: async (row) => (row.step === "offer" ? { text: "An offer", price: 8400 } : { mail: "A reminder" }) },
    });

    export default {
      fetch(request, env) {
        const [, run, ...rest] = new URL(request.url).pathname.split("/");
        const object = env.RUNS.get(env.RUNS.idFromName(run));
        return object.fetch(new Request("https://run/" + rest.join("/"), request));
      },
    };`;
  const out = await build({
    stdin: { contents: entry, resolveDir: here, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    external: ["./quickjs.wasm"],
  });
  worker = new Miniflare({
    modulesRoot: "/",
    modules: [
      { type: "ESModule", path: "/worker.js", contents: out.outputFiles[0].text },
      {
        type: "CompiledWasm",
        path: "/quickjs.wasm",
        contents: await readFile(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")),
      },
    ],
    compatibilityDate: "2025-09-01",
    durableObjects: { RUNS: { className: "RunObject", useSQLite: true } },
  });
  await worker.ready;
});

afterAll(() => worker?.dispose());

const call = async (run: string, path = "", body?: unknown): Promise<Run & { error?: string }> => {
  const response = await worker.dispatchFetch(
    `https://kernel/${run}/${path}`,
    body ? { method: "POST", body: JSON.stringify(body) } : {},
  );
  return (await response.json()) as Run;
};

const input = {
  customer: "Nordlicht GmbH",
  email: "einkauf@nordlicht.example",
  budget: 9000,
  items: [{ name: "Workshop", price: 1500, quantity: 2 }],
};
const waiting = (run: Run) =>
  run.rows.findIndex((row) => !("left" in row) && row.state === "waiting");

it("runs the offer wizard in a Durable Object, one request per answer", async () => {
  let run = await call("a", "start", { wizard: "offer", input });
  expect(run).toMatchObject({ status: "waiting", cursor: "legal" });
  expect(run.wakeAt).toBeGreaterThan(Date.now());

  run = await call("a", "answer", {
    row: waiting(run),
    value: { approved: false, note: "Add the liability clause." },
    by: "legal",
  });
  expect(run).toMatchObject({ status: "waiting", cursor: "legal" });
  run = await call("a", "answer", { row: waiting(run), value: { approved: true }, by: "legal" });
  expect(run.cursor).toBe("check");
  run = await call("a", "answer", { row: waiting(run), value: { approved: true }, by: "operator" });
  run = await call("a", "answer", { row: waiting(run), value: { approved: true }, by: "user" });
  expect(run.cursor).toBe("signed");
  run = await call("a", "answer", { row: waiting(run), value: { came: true } });

  expect(run).toMatchObject({
    status: "done",
    output: { offer: "An offer", price: 8400, signed: true },
  });
  expect(run.rows.filter((row) => "left" in row).map((row) => row.step)).toEqual([
    "offer",
    "legal",
    "offer",
    "legal",
    "check",
    "accept",
    "signed",
  ]);
  expect(await call("a")).toEqual(run); // read back from the object's storage
});

it("keeps runs apart, and refuses what the kernel refuses", async () => {
  const b = await call("b", "start", { wizard: "offer", input });
  expect(b.rows).toHaveLength(3);
  expect((await call("b", "answer", { row: 0, value: {} })).error).toBe(
    "Row 0 does not wait for an answer.",
  );
  expect((await call("c", "start", { wizard: "offer", input: {} })).error).toBe(
    '"customer" is missing.',
  );
});

it("wakes a run by the object's alarm", async () => {
  const run = await call("n", "start", { wizard: "nap", input: {} });
  expect(run.status).toBe("waiting");
  await expect
    .poll(async () => (await call("n")).status, { timeout: 10_000, interval: 250 })
    .toBe("done");
  expect((await call("n")).output).toEqual({ woke: true });
});
