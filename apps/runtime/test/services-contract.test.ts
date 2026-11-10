import { httpServices } from "@engenty/wizards-engine/http-services";
import {
  type RunServices,
  ServiceError,
  type ServiceStep,
} from "@engenty/wizards-shared/run-services";
import { vi } from "vitest";
import {
  type ContractRun,
  servicesContract,
} from "../../../packages/engine/test/services-contract";
import {
  answers,
  definition,
  loadRuntime,
  MODEL,
  SCHEMA,
  startRun,
  TORN,
} from "./run-services-fixture";

/**
 * One contract for the run's services (packages/engine/test/services-contract.ts), run twice: on
 * the runtime's own functions, as the runner calls them, and on the engine's HTTP client against
 * this runtime's routes. Each side has a run of its own, in a tenant of its own; the model is
 * run-services-fixture.ts's script.
 */
vi.setConfig({ testTimeout: 120_000 });

/** The run in `tenant`, with what the contract knows of it; `services` as `serve` gives them. */
async function contractRun(
  tenant: string,
  serve: (started: { tenant: string; runId: string; token: string }) => Promise<RunServices>,
): Promise<ContractRun> {
  const started = await startRun(tenant);
  const services = await serve(started);
  // A file of the run's tenant, saved before the contract reads it.
  const file = await services.files.save({
    kind: "text",
    mime: "text/plain",
    name: "otters.txt",
    data: "Otters hold hands.",
  });
  const finish = {
    type: "finish" as const,
    reason: "stop",
    usage: { inputTokens: 3, outputTokens: 2 },
    model: MODEL,
  };
  const turn = (stepId: string) => ({
    stepId,
    class: "standard" as const,
    messages: [{ role: "user" as const, content: "Write about otters." }],
  });
  const { classifyFailure } = await import("../src/engine/failures");
  const { failureContext } = await loadRuntime().then((r) => r.runner);
  return {
    services,
    // As the runner sorts a step's error: a ServiceError keeps its class.
    sorted(err) {
      if (err instanceof ServiceError) {
        return err.failure;
      }
      const { class: cls, retryAfterMs } = classifyFailure(err, failureContext());
      return cls === "retry"
        ? { class: "retry", retryAfterMs }
        : cls === "sign_in"
          ? { class: "sign_in", service: "" }
          : { class: cls };
    },
    turn: {
      request: turn("write"),
      parts: [...answers.write.map((text) => ({ type: "text" as const, text })), finish],
    },
    torn: {
      request: turn("torn"),
      parts: answers.torn.map((text) => ({ type: "text" as const, text })),
      failure: { class: "retry", retryAfterMs: null },
      message: TORN,
    },
    decide: {
      request: {
        stepId: "pick",
        state: "A river with otters.",
        questions: { otters: { type: "noul", instructions: "Are there otters?" } },
      },
      answer: { answers: { otters: { type: "noul", noul: 1 } }, source: "llm" },
    },
    tool: {
      stepId: "write",
      name: "list_write",
      input: { list: "notes", rows: [{ title: "Otters" }] },
      output: { added: 1, updated: 0, deleted: 0 },
    },
    setting: { stepId: "write", has: { lang: "en", skills: "" } },
    file: { ref: file.id, name: "otters.txt", mime: "text/plain", text: "Otters hold hands." },
    workspace: { path: "data/schema.sql", text: SCHEMA },
    data: { stepId: "write", scope: "shared", table: "notes", column: "text" },
    list: { id: "notes" },
    serviceStep: {
      step: definition.steps.find((s) => s.id === "doc") as ServiceStep,
      kind: "html",
    },
    refused: {
      listId: "nope",
      failure: { class: "final" },
      message: "No list nope in this wizard.",
    },
  };
}

servicesContract("in process", () =>
  contractRun("tenant-contract-in", async ({ tenant, runId }) => {
    const { client, runner } = await loadRuntime();
    const { withCaller } = await import("../src/broker/caller");
    const { whereOf } = await import("../src/broker/call");
    const { holderWho } = await import("../src/tools/plugin");
    // As the runner's step calls them: in the run's tenant, for the run's person, at its cursor.
    const ctx = await client.withTenant(tenant, async () => {
      const run = await runner.loadRun(runId);
      return runner.contextAt(run!, null, new AbortController().signal);
    });
    const caller = { who: holderWho(ctx), where: whereOf(ctx) };
    const inRun = <T>(fn: () => T | Promise<T>) =>
      client.withTenant(tenant, () => withCaller(caller, async () => fn()));
    return inside(ctx.services, inRun);
  }),
);

servicesContract("over HTTP", async () => {
  const { app } = await loadRuntime();
  return contractRun("tenant-contract-http", async ({ token }) =>
    httpServices({
      url: "http://localhost:5181",
      token,
      fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
    }),
  );
});

/**
 * The services with each call made inside `inRun`: a promise's whole call, a turn's every step,
 * so what the call reads of its tenant and caller is there however it is awaited.
 */
function inside(
  services: RunServices,
  inRun: <T>(fn: () => T | Promise<T>) => Promise<T>,
): RunServices {
  const wrap = (service: object) =>
    new Proxy(service, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        if (key === "turn") {
          return (...args: unknown[]): AsyncIterable<unknown> => ({
            [Symbol.asyncIterator]() {
              let it: AsyncIterator<unknown> | null = null;
              const of = () => {
                it ??= (value.apply(target, args) as AsyncIterable<unknown>)[
                  Symbol.asyncIterator
                ]();
                return it;
              };
              return {
                next: () => inRun(() => of().next()),
                return: (v?: unknown) =>
                  inRun(async () => (await of().return?.(v)) ?? { done: true, value: v }),
              };
            },
          });
        }
        return (...args: unknown[]) => inRun(() => value.apply(target, args));
      },
    });
  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => [name, wrap(service as object)]),
  ) as unknown as RunServices;
}
