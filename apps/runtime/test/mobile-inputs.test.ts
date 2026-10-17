import { beforeEach, describe, expect, it, vi } from "vitest";
import { placeLabel } from "../src/geocode";
import { fieldErrorsIn, readPageInput } from "../src/engine/input";
import { prepareInputs } from "../src/engine/prepare";
import { renderTemplate, type TemplateScope } from "../src/engine/template";
import type { StepContext } from "../src/engine/types";
import {
  bareMime,
  byteRange,
  inlineSafe,
  uploadLimit,
  uploadMime,
  wizardManifest,
} from "../src/routes/delivery";
import { locationText, type PageStep, parseWizard, type WizardDefinition } from "@engenty-wizards/shared/definition";

const assets = new Map<string, { runId: string; mime: string }>();
const transcribe = vi.fn(async () => ({ text: "Die Stoßstange ist eingedrückt.", costUsd: 0.002 }));

vi.mock("../src/files/storage", () => ({
  loadAsset: async (id: string) => {
    const row = assets.get(id);
    return row ? { row, data: Buffer.from("audio") } : null;
  },
}));
vi.mock("../src/media/transcribe", () => ({
  transcribeAudio: (...args: unknown[]) => transcribe(...(args as [])),
}));

const report = {
  title: "Schaden melden",
  steps: [
    {
      id: "site",
      type: "page",
      title: "Vor Ort",
      fields: [
        { id: "place", label: "Ort", kind: "location", required: true },
        { id: "note", label: "Notiz", kind: "audio" },
        { id: "sign", label: "Unterschrift", kind: "signature" },
        { id: "serial", label: "Seriennummer", kind: "text", scan: true },
        { id: "clip", label: "Video", kind: "file", video: true },
      ],
    },
    {
      id: "write",
      type: "agent",
      title: "Schreiben",
      instructions: "Ort {{place}} bei {{place.lat}}/{{place.lng}}, gesagt: {{note}}",
      tools: [],
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [{ from: "write", formats: ["md"] }] },
  ],
};

function wizard(): WizardDefinition {
  const parsed = parseWizard(report);
  if (!parsed.ok) {
    throw new Error("invalid");
  }
  return parsed.wizard;
}

function scope(values: Record<string, unknown>): TemplateScope {
  return { def: wizard(), state: { values, outputs: {}, history: [], notes: {} }, brand: {} };
}

describe("device field kinds", () => {
  it("accepts location, audio and signature fields and their templates", () => {
    const parsed = parseWizard(report);
    expect(parsed.ok && parsed.issues).toEqual([]);
  });

  it("flags scan and video on fields that cannot take them", () => {
    const parsed = parseWizard({
      title: "x",
      steps: [
        {
          id: "p",
          type: "page",
          title: "P",
          fields: [
            { id: "a", label: "A", kind: "number", scan: true },
            { id: "b", label: "B", kind: "image", video: true },
          ],
        },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    const messages = parsed.ok ? parsed.issues.map((i) => i.message) : [];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('"scan"');
    expect(messages[1]).toContain('"video"');
  });
});

describe("page input from a phone", () => {
  const page = wizard().steps[0] as PageStep;
  const read = (input: Record<string, unknown>) => readPageInput(page, input);

  it("keeps a position with its accuracy and address", () => {
    const { values, errors } = read({
      place: { lat: 47.0707123456, lng: "15.4395", accuracy: 11.6, label: " Hauptplatz 1, Graz ", x: 1 },
    });
    expect(errors).toEqual([]);
    expect(values.place).toEqual({ lat: 47.070712, lng: 15.4395, accuracy: 12, label: "Hauptplatz 1, Graz" });
  });

  it("takes a typed address alone and drops coordinates off the globe", () => {
    expect(read({ place: "Herrengasse 16" }).values.place).toEqual({ label: "Herrengasse 16" });
    expect(read({ place: { lat: 123, lng: 15, label: "Graz" } }).values.place).toEqual({ label: "Graz" });
  });

  it("asks for a required location that is empty or impossible", () => {
    for (const place of [undefined, "", {}, { lat: 91, lng: 0 }, { lat: 47 }, { label: "  " }, []]) {
      expect(fieldErrorsIn(read({ place }).errors, "de")).toEqual([{ field: "place", message: "Pflichtfeld" }]);
      expect(fieldErrorsIn(read({ place }).errors, "en")).toEqual([{ field: "place", message: "Required" }]);
    }
  });

  it("reads a voice note by its upload, with length and transcript", () => {
    const { values } = read({
      place: "x",
      note: { asset: "rec1", seconds: 12.4, transcript: "Hallo", extra: true },
      sign: "sig1",
    });
    expect(values.note).toEqual({ asset: "rec1", seconds: 12, transcript: "Hallo" });
    expect(values.sign).toBe("sig1");
    expect(read({ place: "x", note: "rec2" }).values.note).toEqual({ asset: "rec2" });
    expect(read({ place: "x", note: { seconds: 3 }, sign: { id: "x" } }).values).toEqual({
      place: { label: "x" },
    });
  });
});

describe("templates", () => {
  it("renders a position as text, as numbers and as a map link", () => {
    const s = scope({ place: { lat: 47.07071, lng: 15.4395, accuracy: 12, label: "Hauptplatz 1, Graz" } });
    expect(renderTemplate("{{place}}", s)).toBe("Hauptplatz 1, Graz (47.07071, 15.43950, ±12 m)");
    expect(renderTemplate("{{place.lat}}|{{place.lng}}|{{place.accuracy}}|{{place.label}}", s)).toBe(
      "47.07071|15.4395|12|Hauptplatz 1, Graz",
    );
    expect(renderTemplate("{{place.map}}", s)).toBe(
      "https://www.openstreetmap.org/?mlat=47.07071&mlon=15.4395#map=17/47.07071/15.4395",
    );
    expect(locationText({ label: "Nur Adresse" })).toBe("Nur Adresse");
    expect(renderTemplate("{{place}}{{place.map}}", scope({ place: { label: "Graz" } }))).toBe("Graz");
  });

  it("renders a voice note as what was said and a signature as a placeable image", () => {
    const s = scope({ note: { asset: "rec1", seconds: 9, transcript: " Die Tür klemmt. " }, sign: "sig1" });
    expect(renderTemplate("{{note}} ({{note.seconds}} s) {{sign}}", s)).toBe("Die Tür klemmt. (9 s) asset://sig1");
    expect(renderTemplate("{{note}}", scope({ note: { asset: "rec1" } }))).toContain("voice note");
    expect(renderTemplate("[{{note}}{{sign}}{{place}}]", scope({}))).toBe("[]");
  });
});

describe("preparing answers for a step", () => {
  const context = (values: Record<string, unknown>) => {
    const emit = vi.fn(async () => undefined);
    const chargeUsd = vi.fn(async () => undefined);
    const ctx = {
      runId: "run1",
      def: wizard(),
      state: { values, outputs: {}, history: [], notes: {} },
      signal: new AbortController().signal,
      emit,
      chargeUsd,
    } as unknown as StepContext;
    return { ctx, emit, chargeUsd };
  };

  beforeEach(() => {
    assets.clear();
    transcribe.mockClear();
    assets.set("rec1", { runId: "run1", mime: "audio/webm" });
    assets.set("sig1", { runId: "run1", mime: "image/png" });
    assets.set("foreign", { runId: "run2", mime: "audio/webm" });
  });

  it("transcribes a voice note once and charges for it", async () => {
    const { ctx, chargeUsd } = context({ note: { asset: "rec1", seconds: 9 }, sign: "sig1" });
    await prepareInputs(ctx);
    expect(ctx.state.values.note).toEqual({
      asset: "rec1",
      seconds: 9,
      transcript: "Die Stoßstange ist eingedrückt.",
    });
    expect(ctx.state.values.sign).toBe("sig1");
    expect(chargeUsd).toHaveBeenCalledWith(0.002);
    await prepareInputs(ctx);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("drops a recording or signature that is not this run's own", async () => {
    const { ctx } = context({ note: { asset: "foreign" }, sign: "rec1" });
    await prepareInputs(ctx);
    expect(ctx.state.values).toEqual({});
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("lets the step go on when transcription fails, and tries again next time", async () => {
    transcribe.mockRejectedValueOnce(new Error("model down"));
    const { ctx, emit } = context({ note: { asset: "rec1" } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await prepareInputs(ctx);
    quiet.mockRestore();
    expect(ctx.state.values.note).toEqual({ asset: "rec1" });
    expect(emit).toHaveBeenCalledTimes(2);
    await prepareInputs(ctx);
    expect((ctx.state.values.note as { transcript?: string }).transcript).toBeTruthy();
  });
});

describe("delivery", () => {
  it("answers the byte ranges a phone asks a clip in", () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 });
    expect(byteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(byteRange("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
    expect(byteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=5-2", 100)).toBe("unsatisfiable");
    expect(byteRange("items=0-1", 100)).toBeNull();
    expect(byteRange("bytes=0-1,5-6", 100)).toBeNull();
  });

  it("gives clips more room than other uploads", () => {
    expect(uploadLimit("video/mp4")).toBeGreaterThan(uploadLimit("audio/webm"));
    expect(uploadLimit("image/jpeg")).toBe(15_000_000);
  });

  it("keeps an upload's type only when it is a bare type a wizard takes", () => {
    expect(uploadMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(uploadMime("Image/JPEG")).toBe("image/jpeg");
    expect(uploadMime("video/quicktime")).toBe("video/quicktime");
    expect(uploadMime("application/pdf")).toBe("application/pdf");
    expect(uploadMime("text/csv")).toBe("text/csv");
    expect(
      uploadMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    // A browser reads the last of comma-joined types: none of these may come back as a page.
    for (const declared of [
      "text/html",
      "text/html,x",
      "text/plain,text/html",
      "image/png,text/html",
      "image/png text/html",
      "application/xhtml+xml",
      "application/javascript",
      "",
    ]) {
      expect(uploadMime(declared), declared).toBe("application/octet-stream");
    }
    expect(bareMime("text/html,x")).toBeNull();
    expect(bareMime('text/"html"')).toBeNull();
    expect(bareMime("image/svg+xml; charset=utf-8")).toBe("image/svg+xml");
  });

  it("shows photos, sound, film and PDFs in place, never an SVG", () => {
    for (const mime of ["image/png", "image/jpeg", "audio/webm", "video/mp4", "application/pdf"]) {
      expect(inlineSafe(mime), mime).toBe(true);
    }
    for (const mime of ["image/svg+xml", "text/plain", "text/html", "application/octet-stream"]) {
      expect(inlineSafe(mime), mime).toBe(false);
    }
  });

  it("makes a wizard an app that opens on its own link", () => {
    const manifest = wizardManifest("tok123", "Schadensmeldung aufnehmen", "Vor Ort");
    expect(manifest.start_url).toBe("/w/tok123");
    expect(manifest.id).toBe("/w/tok123");
    expect(manifest.display).toBe("standalone");
    expect(manifest.short_name.length).toBeLessThanOrEqual(14);
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    expect(manifest.icons.every((i) => i.src.includes("/wizards/tok123/icons/"))).toBe(true);
  });

  it("names a place from a geocoder's answer", () => {
    expect(
      placeLabel({ address: { road: "Herrengasse", house_number: "16", postcode: "8010", city: "Graz" } }),
    ).toBe("Herrengasse 16, 8010 Graz");
    expect(placeLabel({ address: { village: "Pöllau" } })).toBe("Pöllau");
    expect(placeLabel({ display_name: "A, B, C, D" })).toBe("A, B, C");
    expect(placeLabel({})).toBeNull();
  });
});

describe("how many files a page takes", () => {
  const page: PageStep = {
    id: "p",
    type: "page",
    title: "P",
    fields: [{ id: "photos", label: "Photos", kind: "image", multiple: true, min: 2, max: 3 }],
  };

  it("keeps the files in the order the person put them", () => {
    const { values, errors } = readPageInput(page, { photos: ["c", "a", "b"] });
    expect(errors).toEqual([]);
    expect(values.photos).toEqual(["c", "a", "b"]);
  });

  it("asks for more below the minimum and for fewer above the maximum", () => {
    expect(readPageInput(page, { photos: ["a"] }).errors.map((e) => e.field)).toEqual(["photos"]);
    expect(readPageInput(page, { photos: ["a", "b", "c", "d"] }).errors).toHaveLength(1);
  });

  it("takes none where the field is not required", () => {
    expect(readPageInput(page, {}).errors).toEqual([]);
  });
});
