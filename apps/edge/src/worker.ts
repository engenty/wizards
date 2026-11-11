/**
 * The Worker in front of the runs' objects: a call under `/api/peer/runs/<run>/` goes to that
 * run's object (`run-object.ts`), one object a run, named by the run's id.
 */
import { PEER_RUNS_PATH } from "@engenty/wizards-engine/host-api";
import { countQuickJsInterrupts, useQuickJsWasm } from "@engenty/wizards-engine/quickjs";
import quickJsWasm from "@jitl/quickjs-wasmfile-release-sync/wasm";
import { type EdgeEnv, RunObject } from "./run-object.js";

// workerd compiles no WebAssembly from bytes: a code step's QuickJS comes as an imported module.
useQuickJsWasm(quickJsWasm);
// A deployed object's clock stands still while code runs: a code step's time is counted too.
countQuickJsInterrupts();

export { RunObject };

const RUN_PATH = new RegExp(`^${PEER_RUNS_PATH}/([^/]+)/[^/]+$`);

export default {
  async fetch(request: Request, env: EdgeEnv): Promise<Response> {
    const runId = new URL(request.url).pathname.match(RUN_PATH)?.[1];
    if (!runId) {
      return new Response(JSON.stringify({ error: "Not found." }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const object = env.RUN.get(env.RUN.idFromName(decodeURIComponent(runId)));
    return object.fetch(request);
  },
};
