import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatStart, GooseChat, Step, ToolAnswer } from "./chat.js";
import { createGoose, type GooseEvent } from "./goose.js";
import { gooseRoutes } from "./routes.js";
import { defineTool, type Person } from "./tool.js";

/** A step the fake model takes: text it writes, then the calls it makes. */
type Scripted = { text?: string; calls?: Step["calls"]; stop?: Step["stop"] } | Error;

/** A GooseChat that plays a script and records what it was given. */
function fakeChat(script: Scripted[], extra: Partial<GooseChat> = {}) {
  const seen = { starts: [] as ChatStart[], answers: [] as ToolAnswer[][] };
  const chat: GooseChat = {
    label: "fake/model",
    start(o) {
      seen.starts.push(o);
      let at = 0;
      return {
        step(onText) {
          const next = script[at++];
          if (!next) {
            return Promise.reject(new Error("The script has no more steps."));
          }
          if (next instanceof Error) {
            return Promise.reject(next);
          }
          if (next.text) {
            onText(next.text);
          }
          const calls = next.calls ?? [];
          return Promise.resolve({
            calls,
            stop: next.stop ?? (calls.length ? "tools" : "end"),
            usage: "in 1 out 1",
          });
        },
        answer(results) {
          seen.answers.push(results);
        },
      };
    },
    ...extra,
  };
  return { chat, seen };
}

const person: Person = {
  name: "Ada",
  email: "ada@example.com",
  role: "editor",
};

const readFile = defineTool({
  name: "read_file",
  description: "Read a file.",
  input: z.object({ path: z.string().describe("The file's path") }),
  label: (input) => `Read ${input.path}`,
  run: ({ path }) => Promise.resolve(path === "a.md" ? "# A" : `${path} does not exist`),
});

const suggestEdit = defineTool({
  name: "suggest_edit",
  description: "Suggest a change.",
  input: z.object({ path: z.string(), new_text: z.string() }),
  eager: true,
  run: ({ path, new_text }) =>
    Promise.resolve({
      text: "Shown to the person.",
      suggestion: {
        path,
        oldText: "# A",
        newText: new_text,
        reason: "shorter",
      },
    }),
});

async function turn(
  chat: GooseChat | (() => GooseChat | null),
  message = "What is in a.md?",
  options: Partial<Parameters<typeof createGoose>[0]> = {},
) {
  const goose = createGoose({
    chat,
    system: "You are a test.",
    tools: [readFile, suggestEdit],
    ...options,
  });
  const events: GooseEvent[] = [];
  await goose.turn(
    { message, page: { path: "a.md", text: "# A" } },
    { person, emit: (e) => void events.push(e) },
  );
  return events;
}

describe("defineTool", () => {
  it("makes the JSON schema from the zod input", () => {
    expect(readFile.spec).toEqual({
      name: "read_file",
      description: "Read a file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file's path" },
        },
        required: ["path"],
      },
    });
    expect(suggestEdit.spec.eager).toBe(true);
  });

  it("refuses an input that is no object", () => {
    expect(() =>
      defineTool({
        name: "bad",
        description: "",
        input: z.string(),
        run: () => Promise.resolve(""),
      }),
    ).toThrow(/must be an object/);
  });
});

describe("createGoose", () => {
  it("streams the text and ends with done when the model calls no tool", async () => {
    const { chat, seen } = fakeChat([{ text: "Hello." }]);
    const events = await turn(chat);
    expect(events).toEqual([
      { event: "text", data: { delta: "Hello." } },
      { event: "done", data: {} },
    ]);
    const start = seen.starts[0];
    expect(start?.system).toBe("You are a test.");
    expect(start?.tools.map((t) => t.name)).toEqual(["read_file", "suggest_edit"]);
    expect(start?.user[0]).toMatchObject({ type: "text" });
    const text = (start?.user[0] as { text: string }).text;
    expect(text).toContain("The person is Ada.");
    expect(text).toContain("They have a.md open.");
    expect(text.endsWith("What is in a.md?")).toBe(true);
  });

  it("runs the tools, answers the model and goes on", async () => {
    const { chat, seen } = fakeChat([
      {
        text: "Let me look.",
        calls: [{ id: "c1", name: "read_file", input: { path: "a.md" } }],
      },
      { text: "It holds a heading." },
    ]);
    const events = await turn(chat);
    expect(events.map((e) => e.event)).toEqual(["text", "step", "step", "text", "done"]);
    expect(events[1]).toEqual({
      event: "step",
      data: { id: "c1", label: "Read a.md", state: "running" },
    });
    expect(events[2]).toMatchObject({ data: { state: "done" } });
    expect(seen.answers).toEqual([[{ id: "c1", content: "# A" }]]);
  });

  it("sends a suggestion as an action", async () => {
    const { chat } = fakeChat([
      {
        calls: [
          {
            id: "c1",
            name: "suggest_edit",
            input: { path: "a.md", new_text: "# B" },
          },
        ],
      },
      { text: "Done." },
    ]);
    const events = await turn(chat);
    expect(events).toContainEqual({
      event: "action",
      data: {
        kind: "edit",
        path: "a.md",
        before: "# A",
        after: "# B",
        reason: "shorter",
      },
    });
  });

  it("tells the model about invalid input and unknown tools", async () => {
    const { chat, seen } = fakeChat([
      {
        calls: [
          { id: "c1", name: "read_file", input: { path: 3 } },
          { id: "c2", name: "read_file", input: undefined },
          { id: "c3", name: "delete_all", input: {} },
        ],
      },
      { text: "Sorry." },
    ]);
    const events = await turn(chat);
    const [answers] = seen.answers;
    expect(answers?.map((a) => a.error)).toEqual([true, true, true]);
    expect(answers?.[0]?.content).toMatch(/^Invalid input:/);
    expect(answers?.[2]?.content).toBe("Unknown tool delete_all.");
    expect(events.filter((e) => e.event === "step" && e.data.state === "failed")).toHaveLength(3);
  });

  it("reports a tool that throws to the model", async () => {
    const broken = defineTool({
      name: "broken",
      description: "Fails.",
      input: z.object({}),
      run: () => Promise.reject(new Error("disk on fire")),
    });
    const { chat, seen } = fakeChat([
      { calls: [{ id: "c1", name: "broken", input: {} }] },
      { text: "It failed." },
    ]);
    await turn(chat, "Go", { tools: [broken] });
    expect(seen.answers[0]).toEqual([{ id: "c1", content: "disk on fire", error: true }]);
  });

  it("stops after maxSteps", async () => {
    const call = { id: "c", name: "read_file", input: { path: "a.md" } };
    const { chat, seen } = fakeChat(Array.from({ length: 10 }, () => ({ calls: [call] })));
    const events = await turn(chat, "Loop", { maxSteps: 3 });
    expect(seen.answers).toHaveLength(3);
    expect(events.at(-1)).toEqual({ event: "done", data: {} });
  });

  it("says so on a refusal and when the answer gets too long", async () => {
    const refused = await turn(fakeChat([{ stop: "refusal" }]).chat);
    expect(refused[0]).toEqual({
      event: "text",
      data: { delta: "\n\nGoose can't help with this one." },
    });
    const long = await turn(fakeChat([{ text: "…", stop: "max_tokens" }]).chat, "x", {
      texts: { tooLong: "Too long." },
    });
    expect(long.map((e) => e.event === "text" && e.data.delta)).toEqual(["…", "Too long.", false]);
  });

  it("asks a failed first step again once when the chat says it may", async () => {
    const cut = new Error("cut off mid-JSON");
    const { chat } = fakeChat([cut, { text: "Second try." }], {
      retryable: () => true,
    });
    const events = await turn(chat);
    expect(events).toContainEqual({
      event: "text",
      data: { delta: "Second try." },
    });
    expect(events.at(-1)?.event).toBe("done");
  });

  it("sends an error, in the chat's words, when a step fails", async () => {
    const errors: unknown[] = [];
    const { chat } = fakeChat([new Error("401")], {
      describe: (_err, doing) => `${doing}: no valid key.`,
    });
    const events = await turn(chat, "x", {
      onError: (err) => errors.push(err),
    });
    expect(events).toEqual([
      {
        event: "error",
        data: { text: "Goose could not answer: no valid key." },
      },
    ]);
    expect(errors).toHaveLength(1);
  });

  it("follows a chat that changes, and is off without one", async () => {
    const events = await turn(() => null);
    expect(events).toEqual([
      {
        event: "error",
        data: { text: "Goose is switched off or not set up." },
      },
    ]);
  });

  it("refuses two tools of one name", () => {
    expect(() =>
      createGoose({
        chat: fakeChat([]).chat,
        system: "",
        tools: [readFile, readFile],
      }),
    ).toThrow(/Two Goose tools/);
  });
});

/** The events of a server-sent stream. */
function eventsOf(body: string) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

describe("gooseRoutes", () => {
  const app = (chat: GooseChat | null, who: Person | null = person) => {
    const goose = createGoose({
      chat: () => chat,
      system: "Test.",
      tools: [readFile],
    });
    const host = new Hono<{ Variables: { person: Person } }>();
    host.use(async (c, next) => {
      if (who) {
        c.set("person", who);
      }
      await next();
    });
    host.route("/goose", gooseRoutes(goose));
    return host;
  };
  const post = (host: Hono<never>, body: unknown) =>
    host.request("/goose/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers as server-sent events", async () => {
    const { chat } = fakeChat([
      { calls: [{ id: "c1", name: "read_file", input: { path: "a.md" } }] },
      { text: "A heading." },
    ]);
    const res = await post(app(chat) as never, {
      message: "What is in a.md?",
      history: [],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(eventsOf(await res.text())).toEqual([
      {
        event: "step",
        data: { id: "c1", label: "Read a.md", state: "running" },
      },
      { event: "step", data: { id: "c1", label: "Read a.md", state: "done" } },
      { event: "text", data: { delta: "A heading." } },
      { event: "done", data: {} },
    ]);
  });

  it("takes the person from the host", async () => {
    const { chat, seen } = fakeChat([{ text: "Hi." }]);
    const goose = createGoose({ chat, system: "Test.", tools: [] });
    const host = new Hono();
    host.route("/goose", gooseRoutes(goose, { person: () => ({ name: "Grace" }) }));
    await (await post(host as never, { message: "Hi" })).text();
    expect((seen.starts[0]?.user[0] as { text: string }).text).toContain("The person is Grace.");
  });

  it("refuses without a person, when Goose is off, and a bad body", async () => {
    const { chat } = fakeChat([]);
    expect((await post(app(chat, null) as never, { message: "Hi" })).status).toBe(401);
    const off = await post(app(null) as never, { message: "Hi" });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: "goose_off" });
    expect((await post(app(chat) as never, { message: "" })).status).toBe(400);
  });
});
