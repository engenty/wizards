import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Lang } from "@engenty-wizards/shared/definition";

const dir = mkdtempSync(join(tmpdir(), "wizards-apple-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";

describe("Apple Intelligence on this Mac as a model", () => {
  it("is offered on a Mac with Apple silicon on macOS 26 or later only", async () => {
    const { appleMachine } = await import("../src/harness/apple");
    expect(appleMachine("darwin", "arm64", "25.0.0")).toBeNull();
    expect(appleMachine("darwin", "arm64", "26.1.0")).toBeNull();
    expect(appleMachine("darwin", "arm64", "24.6.0")).toBe("os");
    expect(appleMachine("darwin", "x64", "25.0.0")).toBe("device");
    expect(appleMachine("linux", "arm64", "6.8.0")).toBe("device");
    expect(appleMachine("win32", "x64", "10.0.0")).toBe("device");
  });

  it("names why it waits: switched off, still loading, or not this device", async () => {
    const { appleReasonOf, appleUnavailableNote } = await import("../src/harness/apple");
    const { noteText } = await import("@engenty-wizards/shared/run");
    const appleUnavailable = (status: Parameters<typeof appleUnavailableNote>[0], lang: Lang) =>
      noteText(appleUnavailableNote(status), lang);
    expect(appleReasonOf("appleIntelligenceNotEnabled")).toBe("off");
    expect(appleReasonOf("modelNotReady")).toBe("loading");
    expect(appleReasonOf("deviceNotEligible")).toBe("device");
    expect(appleUnavailable({ supported: true, available: false, reason: "off" }, "de")).toContain(
      "Systemeinstellungen",
    );
    expect(appleUnavailable({ supported: true, available: false, reason: "off" }, "en")).toContain(
      "System Settings",
    );
    expect(appleUnavailable({ supported: false, available: false, reason: "os" }, "en")).toContain(
      "macOS 26",
    );
  });

  it("turns the helper's failures into what the person should read", async () => {
    const { appleFailure } = await import("../src/harness/apple");
    const { ModelUnavailableError } = await import("../src/model-errors");
    expect(appleFailure({ kind: "rateLimited", message: "" })).toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(
      appleFailure({ kind: "unavailable", message: "appleIntelligenceNotEnabled" }),
    ).toBeInstanceOf(ModelUnavailableError);
    expect(appleFailure({ kind: "contextWindow", message: "" }).message).toContain("4,096");
    expect(appleFailure({ kind: "guardrail", message: "" }).message).toContain("turned the request down");
    expect(appleFailure({ kind: "other", message: "boom" }).message).toBe(
      "Apple Intelligence: boom",
    );
  });

  it("is not there without the helper", async () => {
    const { appleStatus, APPLE_BIN } = await import("../src/harness/apple");
    const status = await appleStatus(true);
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      expect(status).toEqual({ supported: false, available: false, reason: "device" });
    } else if (!existsSync(APPLE_BIN)) {
      expect(status.supported).toBe(false);
      expect(status.reason).toBe("missing");
    } else {
      expect(status.supported).toBe(true);
    }
  });
});

// The helper itself: only on a Mac that built it (apps/runtime/scripts/build-apple.mjs) with
// Apple Intelligence switched on; elsewhere these are skipped.
describe("the wizards-apple helper", async () => {
  const { APPLE_BIN, appleStatus, appleModel } = await import("../src/harness/apple");
  const status = existsSync(APPLE_BIN) ? await appleStatus(true) : null;
  const live = Boolean(status?.available);

  const slow = { timeout: 90_000 };

  it.skipIf(!live)("answers a short prompt", slow, async () => {
    const { generateText } = await import("ai");
    const { text } = await generateText({
      model: appleModel("default"),
      system: "Answer with one word.",
      prompt: "Which city is the capital of Austria?",
      abortSignal: AbortSignal.timeout(60_000),
    });
    expect(text.toLowerCase()).toMatch(/vienna|wien/);
  });

  it.skipIf(!live)("keeps to a schema as a classifier step asks for one", slow, async () => {
    const { generateText, Output } = await import("ai");
    const { z } = await import("zod");
    const { output } = await generateText({
      model: appleModel("default"),
      prompt: "Request: 'I was charged twice for my March invoice.' Classify it.",
      output: Output.object({
        schema: z.object({
          category: z.enum(["billing", "technical", "sales", "other"]),
          urgent: z.boolean(),
          summary: z.string().describe("one line"),
          tags: z.array(z.string()).max(3),
          customer: z.string().nullable(),
        }),
      }),
      abortSignal: AbortSignal.timeout(60_000),
    });
    expect(output?.category).toBe("billing");
    expect(typeof output?.urgent).toBe("boolean");
    expect(Array.isArray(output?.tags)).toBe(true);
  });

  it.skipIf(!live)("writes a voice note down on this Mac", slow, async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const { experimental_transcribe } = await import("ai");
    const { appleTranscriptionModel } = await import("../src/harness/apple");
    // A note the Mac speaks itself, as the recorder would save it (AAC in an .m4a).
    const aiff = join(dir, "note.aiff");
    const m4a = join(dir, "note.m4a");
    execFileSync("say", ["-v", "Anna", "-o", aiff, "Bitte ruf den Kunden morgen um zehn Uhr zurück."]);
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", aiff, m4a]);
    const result = await experimental_transcribe({
      model: appleTranscriptionModel(),
      audio: readFileSync(m4a),
      mediaType: "audio/mp4",
      providerOptions: { apple: { locale: "de-DE" } },
      abortSignal: AbortSignal.timeout(60_000),
    });
    expect(result.text.toLowerCase()).toContain("kunden");
    expect(result.text.toLowerCase()).toMatch(/zehn|10/);
  });

  it.skipIf(!live)("says when a text is too long for the model", slow, async () => {
    const { generateText } = await import("ai");
    const words = Array.from({ length: 5500 }, (_, i) => `word${i}`).join(" ");
    await expect(
      generateText({
        model: appleModel("default"),
        prompt: `Summarize: ${words}`,
        abortSignal: AbortSignal.timeout(60_000),
      }),
    ).rejects.toThrow(/4,096 tokens/);
  });
});
