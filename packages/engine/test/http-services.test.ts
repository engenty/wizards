import type { AgentStep } from "@engenty/wizards-shared/definition";
import type { ServiceStep, TurnPart } from "@engenty/wizards-shared/run-services";
import { ServiceError } from "@engenty/wizards-shared/run-services";
import { describe, expect, it } from "vitest";
import { base64Of, httpServices } from "../src/http-services.js";
import type { StepContext } from "../src/types.js";

/**
 * What only the HTTP client meets (../src/http-services.ts): the network, a proxy's answer, a
 * stream cut in odd places. What every implementation does alike is services-contract.ts's, run
 * in apps/runtime/test/services-contract.test.ts.
 */

type Seen = { url: string; init: RequestInit };

/** A client whose `fetch` answers with `answer`, and the requests it made. */
function client(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const services = httpServices({
    url: "https://runtime.example/",
    token: "tok",
    fetch: async (input, init) => {
      const call = { url: String(input), init: init ?? {} };
      seen.push(call);
      return answer(call);
    },
  });
  return { services, seen };
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: unknown) => err,
  );

/** A body streamed in the chunks given, as the network may cut it. */
const chunked = (chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );

const collect = async (parts: AsyncIterable<TurnPart>) => {
  const out: TurnPart[] = [];
  for await (const part of parts) {
    out.push(part);
  }
  return out;
};

const turn = { stepId: "s", class: "standard" as const, messages: [] };
const finish: TurnPart = {
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "m",
};

describe("the run's services over fetch", () => {
  it("posts JSON with the run's token to the call's path, and the call's signal", async () => {
    const { services, seen } = client(() => Response.json({ notes: 2 }));
    const signal = new AbortController().signal;
    expect(await services.data.counts()).toEqual({ notes: 2 });
    await services.models.decide({ stepId: "s", state: "x", questions: {} }, signal);
    expect(seen[0]?.url).toBe("https://runtime.example/api/run-services/v1/data/counts");
    expect(seen[0]?.init).toMatchObject({ method: "POST", body: "{}" });
    expect(new Headers(seen[0]?.init.headers).get("authorization")).toBe("Bearer tok");
    expect(seen[1]?.init.signal).toBe(signal);
  });

  it("reads a turn's lines however the stream is cut", async () => {
    const lines = [{ type: "text", text: "Ott€rs " }, { type: "text", text: "swim." }, finish]
      .map((p) => `${JSON.stringify(p)}\n`)
      .join("");
    const bytes = new TextEncoder().encode(lines);
    // Cut inside a line and inside the euro sign's bytes.
    const cut = [bytes.slice(0, 13), bytes.slice(13, 30), bytes.slice(30)];
    const { services } = client(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const piece of cut) {
                c.enqueue(piece);
              }
              c.close();
            },
          }),
        ),
    );
    expect(await collect(services.models.turn(turn))).toEqual([
      { type: "text", text: "Ott€rs " },
      { type: "text", text: "swim." },
      finish,
    ]);
  });

  it("throws a stream's error line, and a stream that ends without its finish, with their class", async () => {
    const said = client(() =>
      chunked([
        `${JSON.stringify({ type: "text", text: "a" })}\n`,
        `${JSON.stringify({ error: { failure: { class: "credits" }, message: "No credits." } })}\n`,
      ]),
    );
    const seen: TurnPart[] = [];
    const err = await rejection(
      (async () => {
        for await (const part of said.services.models.turn(turn)) {
          seen.push(part);
        }
      })(),
    );
    expect(seen).toEqual([{ type: "text", text: "a" }]);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).failure).toEqual({ class: "credits" });
    expect((err as ServiceError).message).toBe("No credits.");

    const cut = client(() => chunked([`${JSON.stringify({ type: "text", text: "a" })}\n`]));
    const broke = await rejection(collect(cut.services.models.turn(turn)));
    expect((broke as ServiceError).failure).toEqual({ class: "retry", retryAfterMs: null });
  });

  it("throws the runtime's error body with its class", async () => {
    const { services } = client(() =>
      Response.json(
        { error: { failure: { class: "sign_in", service: "google" }, message: "Sign in." } },
        { status: 403 },
      ),
    );
    const err = await rejection(services.tools.list("s"));
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).failure).toEqual({ class: "sign_in", service: "google" });
    expect((err as ServiceError).message).toBe("Sign in.");
  });

  it("takes a network failure and a 5xx that is no answer of the runtime as retry", async () => {
    for (const answer of [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
    ]) {
      const { services } = client(answer);
      const err = await rejection(services.data.counts());
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).failure).toEqual({ class: "retry", retryAfterMs: null });
    }
    // Answered, but not by the run's services (a path nobody serves): nothing to wait for.
    const { services } = client(() => Response.json({ code: "not_found" }, { status: 404 }));
    expect(((await rejection(services.data.counts())) as ServiceError).failure).toEqual({
      class: "final",
    });
  });

  it("gives the caller's abort back as it is", async () => {
    const stop = new AbortController();
    const { services } = client(
      ({ init }) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    );
    const pending = rejection(
      services.tools.call({ stepId: "s", name: "t", input: {}, effect: null }, stop.signal),
    );
    stop.abort(new Error("stopped"));
    const err = await pending;
    expect(err).not.toBeInstanceOf(ServiceError);
    expect((err as Error).message).toBe("stopped");
  });

  it("passes a pending answer through as it is", async () => {
    const pending = { pending: true, id: "film-1", wakeAt: 5 };
    const { services, seen } = client(() => Response.json(pending));
    expect(await services.tools.call({ stepId: "s", name: "t", input: {}, effect: "e" })).toEqual(
      pending,
    );
    const step = { id: "film", type: "motion-graphics" } as unknown as ServiceStep;
    expect(await services.steps.run(step)).toEqual(pending);
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({ stepId: "film" });
  });

  it("answers a missing file as null and a 204 as nothing", async () => {
    const missing = () =>
      Response.json(
        { error: { failure: { class: "final" }, message: "No such file." } },
        { status: 404 },
      );
    const { services } = client(missing);
    expect(await services.files.read("x")).toBeNull();
    expect(await services.files.workspace("x")).toBeNull();
    const told = client(() => new Response(null, { status: 204 }));
    expect(await told.services.people.tell({ kind: "done" })).toBeUndefined();
  });

  it("saves bytes as base64, a file by address as it is", async () => {
    const ref = { id: "a", kind: "text", mime: "text/plain", name: "n" };
    const { services, seen } = client(() => Response.json(ref));
    await services.files.save({ kind: "text", mime: "text/plain", name: "n", data: "Grüße" });
    await services.files.save({ kind: "image", name: "p", url: "https://x.example/p.png" });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      kind: "text",
      mime: "text/plain",
      name: "n",
      base64: "R3LDvMOfZQ==",
    });
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({
      kind: "image",
      name: "p",
      url: "https://x.example/p.png",
    });
  });

  it("names an agent step's tools by step, turn and entry; their model's turn carries them by name", async () => {
    const made = { id: "shot", kind: "image", mime: "image/png", name: "shot.png" };
    const later = { id: "page", kind: "html", mime: "text/html", name: "page.html" };
    const { services, seen } = client(({ url }) => {
      if (url.endsWith("/models/agentModel")) {
        return Response.json({ ownLoop: true, takesTools: true, seesImages: false });
      }
      if (url.endsWith("/tools/forStep")) {
        return Response.json({
          tools: [{ name: "send", description: "Sends.", inputSchema: { type: "object" } }],
          assets: [],
          sandbox: false,
        });
      }
      if (url.endsWith("/tools/stepCall")) {
        return Response.json({ output: { sent: true }, assets: [made] });
      }
      // A model with its own loop called a tool that acted and made a file, within the turn.
      return chunked([
        `${JSON.stringify({ type: "text", text: "Sent." })}\n`,
        `${JSON.stringify({ tools: { acted: true, assets: [later] } })}\n`,
        `${JSON.stringify(finish)}\n`,
      ]);
    });
    let saves = 0;
    const ctx = {
      scope: { entry: { item: "x", index: 2, count: 3 } },
      state: { turn: { stepId: "s", id: "r.t" } },
      signal: new AbortController().signal,
      saveState: async () => {
        saves += 1;
      },
    } as unknown as StepContext;
    const model = await services.models.agentModel({ stepId: "s", class: "standard" });
    expect(model).toMatchObject({ ownLoop: true, takesTools: true, seesImages: false });
    const set = await services.tools.forStep({ id: "s" } as AgentStep, ctx, {
      model,
      uploads: [],
      turn: "r.t.2",
    });
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({ stepId: "s", turn: "r.t.2", entry: 2 });
    expect(set.list()).toEqual([
      expect.objectContaining({
        name: "send",
        mastra: { id: "send", description: "Sends.", inputSchema: { type: "object" } },
      }),
    ]);
    expect(await set.call({ name: "send", input: { to: "a" }, effect: "r.t.2:c1" })).toEqual({
      output: { sent: true },
      assets: [made],
    });
    expect(JSON.parse(String(seen[2]?.init.body))).toEqual({
      stepId: "s",
      turn: "r.t.2",
      entry: 2,
      name: "send",
      input: { to: "a" },
      effect: "r.t.2:c1",
    });
    model.attach({ send: set.list()[0]?.mastra }, false);
    const parts = await collect(model.turn({ ...turn, messages: [] }));
    expect(parts).toEqual([{ type: "text", text: "Sent." }, finish]);
    expect(JSON.parse(String(seen[3]?.init.body))).toMatchObject({
      stepId: "s",
      attached: { stepId: "s", turn: "r.t.2", entry: 2, names: ["send"], ignorable: false },
    });
    expect(seen[3]?.url).toMatch(/\/models\/agentTurn$/);
    // The run notes that the turn acted, and the step has both files.
    expect(ctx.state.turn?.acted).toBe(true);
    expect(saves).toBe(1);
    expect(set.assets).toEqual([made, later]);
  });

  it("writes base64 of every byte, past one slice", () => {
    const data = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    const back = Uint8Array.from(atob(base64Of(data)), (ch) => ch.charCodeAt(0));
    expect(back).toEqual(data);
  });
});
