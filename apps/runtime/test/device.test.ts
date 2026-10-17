import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-device-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.MARKETPLACE_URL = "off";
// This process is the web alone: it drives no run, so the runs below stay as they are made.
process.env.RUNTIME_ROLE = "web";

type V3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type Options = Parameters<V3["doGenerate"]>[0];

let client: typeof import("../src/db/client");
let device: typeof import("../src/engine/device");
let events: typeof import("../src/engine/events");
let wizardId = "";

const T = "tenant-device";
const inTenant = <R>(fn: () => Promise<R>) => client.withTenant(T, fn);

/** The runtime's own model: answers "own" and counts its calls. */
function ownModel() {
  const calls: Options[] = [];
  const model: V3 = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "own",
    supportedUrls: {},
    async doGenerate(options) {
      calls.push(options);
      return {
        content: [{ type: "text", text: "own" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
          raw: {},
        },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("not streamed in this test");
    },
  };
  return { model, calls };
}

const prompt = (text: string): Options["prompt"] => [
  { role: "system", content: "Be brief." },
  { role: "user", content: [{ type: "text", text }] },
];

/** A run that waits on its first page: nothing drives it. */
async function newRun(): Promise<string> {
  const runner = await import("../src/engine/runner");
  return inTenant(() =>
    runner.createRun({
      wizardId,
      definition: {
        version: 1,
        title: "Device",
        description: "",
        avatar: "round",
        steps: [
          { id: "start", type: "page", title: "Start", fields: [] },
          { id: "done", type: "result", title: "Fertig", deliverables: [] },
        ],
      },
      files: [],
      version: null,
      mode: "test",
      userId: "u",
    }),
  );
}

/** Plays the phone behind another process's stream: answers each open call of the run once. */
function phone(runId: string, answer: (call: { id: string }) => { text?: string; error?: string }) {
  const answered = new Set<string>();
  const timer = setInterval(() => {
    void inTenant(async () => {
      for (const call of await device.openDeviceCalls(runId)) {
        if (!answered.has(call.id)) {
          answered.add(call.id);
          await device.answerDevice(runId, call.id, answer(call));
        }
      }
    });
  }, 20);
  return () => clearInterval(timer);
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  device = await import("../src/engine/device");
  events = await import("../src/engine/events");
  const wizards = await import("../src/services/wizards");
  wizardId = (
    await inTenant(() =>
      wizards.createWizard("u", {
        definition: {
          version: 1,
          title: "Device",
          description: "",
          avatar: "round",
          steps: [{ id: "done", type: "result", title: "Fertig", deliverables: [] }],
        },
      }),
    )
  ).id;
});

describe("the device a run is watched from as a model", () => {
  it("is asked only while it offers the class, and forgotten when it offers nothing", async () => {
    const [r1, r2] = [await newRun(), await newRun()];
    await inTenant(async () => {
      await device.offerDevice(r1, { think: { classes: ["classifier"], maxChars: 1000 } });
      expect(await device.deviceThinks(r1, "classifier")).toEqual({ maxChars: 1000 });
      expect(await device.deviceThinks(r1, "standard")).toBeNull();
      expect(await device.deviceThinks(r2, "classifier")).toBeNull();
      await device.offerDevice(r1, {});
      expect(await device.deviceThinks(r1, "classifier")).toBeNull();
    });
  });

  it("puts the call in the database for the stream, takes the answer from there, and parses JSON for a schema", async () => {
    const runId = await newRun();
    const own = ownModel();
    const seen: unknown[] = [];
    const stop = phone(runId, (call) => {
      seen.push(call);
      return { text: '{"yes": true}' };
    });
    try {
      const result = await inTenant(() =>
        new device.DeviceModel(runId, own.model, 5000, 2000).doGenerate({
          prompt: prompt("Is water wet?"),
          responseFormat: { type: "json", schema: { type: "object" } },
        }),
      );
      expect(result.content).toEqual([{ type: "text", text: '{"yes":true}' }]);
      expect(result.providerMetadata).toEqual({ device: { answered: true } });
      expect(own.calls).toHaveLength(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        kind: "think",
        system: "Be brief.",
        prompt: "Is water wet?",
        schema: { type: "object" },
      });
      // An answered call leaves nothing behind.
      expect(await inTenant(() => device.openDeviceCalls(runId))).toEqual([]);
    } finally {
      stop();
    }
  });

  it("thinks on its own when the device does not answer in time, errs, or cannot take the call", async () => {
    const own = ownModel();
    // No one answers: the timeout hands the call to the own model and takes the call back.
    const silentRun = await newRun();
    await inTenant(async () => {
      const silent = new device.DeviceModel(silentRun, own.model, 5000, 60);
      expect((await silent.doGenerate({ prompt: prompt("Hi") })).content).toEqual([
        { type: "text", text: "own" },
      ]);
      expect(await device.openDeviceCalls(silentRun)).toEqual([]);
    });
    expect(own.calls).toHaveLength(1);
    // The phone says it cannot.
    const failingRun = await newRun();
    const stop = phone(failingRun, () => ({ error: "guardrail" }));
    try {
      const failing = new device.DeviceModel(failingRun, own.model, 5000, 2000);
      expect(
        (await inTenant(() => failing.doGenerate({ prompt: prompt("Hi") }))).content,
      ).toEqual([{ type: "text", text: "own" }]);
      expect(own.calls).toHaveLength(2);
    } finally {
      stop();
    }
    // Too long for the phone, or with tools: never asked.
    const smallRun = await newRun();
    const asked: unknown[] = [];
    const watch = phone(smallRun, (call) => {
      asked.push(call);
      return { text: "phone" };
    });
    try {
      const small = new device.DeviceModel(smallRun, own.model, 20, 2000);
      await inTenant(async () => {
        await small.doGenerate({ prompt: prompt("A prompt longer than twenty characters") });
        await small.doGenerate({
          prompt: prompt("Hi"),
          tools: [{ type: "function", name: "t", inputSchema: { type: "object" } }],
        });
      });
      expect(asked).toHaveLength(0);
      expect(own.calls).toHaveLength(4);
    } finally {
      watch();
    }
  });

  it("takes an answer only for the call it belongs to", async () => {
    const [runId, other] = [await newRun(), await newRun()];
    await inTenant(async () => {
      expect(await device.answerDevice(runId, "unknown", { text: "x" })).toBe(false);
      const pending = device.askDevice(
        runId,
        { kind: "think", system: "", prompt: "Hi", schema: null },
        2000,
      );
      let call: { id: string } | undefined;
      while (!call) {
        await new Promise((r) => setTimeout(r, 10));
        [call] = await device.openDeviceCalls(runId);
      }
      expect(await device.answerDevice(other, call.id, { text: "wrong run" })).toBe(false);
      expect(await device.answerDevice(runId, call.id, { text: "right" })).toBe(true);
      expect(await device.answerDevice(runId, call.id, { text: "twice" })).toBe(false);
      expect(await pending).toBe("right");
    });
  });
});

describe("watching a run another process works on", () => {
  it("hands on each event once, whether this process or another wrote it, and tells of device calls", async () => {
    const runId = await newRun();
    const seen: (string | null)[] = [];
    const unwatch = await inTenant(async () =>
      events.watchRun(runId, (signal) => seen.push(signal.event?.message ?? null)),
    );
    try {
      await new Promise((r) => setTimeout(r, 100));
      await inTenant(async () => {
        // Written here: told at once, and not again by the next look.
        await events.emitEvent(runId, null, "info", "here");
        // Written by another process: only the row tells.
        await client.db
          .insert(client.schema.runEvent)
          .values({ runId, stepId: null, type: "info", message: "elsewhere" });
      });
      await new Promise((r) => setTimeout(r, 1500));
      expect(seen.filter((m) => m !== null)).toEqual(["here", "elsewhere"]);

      // A call to the device another process put in: a change for the stream to send.
      const before = seen.length;
      await inTenant(() =>
        client.db.insert(client.schema.deviceCall).values({
          runId,
          reqId: "call-from-runner",
          request: { id: "call-from-runner", kind: "think", system: "", prompt: "Hi", schema: null },
        }),
      );
      await new Promise((r) => setTimeout(r, 1500));
      expect(seen.slice(before)).toContain(null);
    } finally {
      unwatch();
    }
  });
});
