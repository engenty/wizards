import {
  type AudioValue,
  type CardOption,
  type Field,
  isDecidedField,
  isLang,
  isLocationValue,
  type Lang,
  type LocationValue,
  MAX_FILES,
  offeredSlot,
  type PageStep,
  shownFields,
} from "@engenty-wizards/shared/definition";
import { readNumber } from "@engenty-wizards/shared/numbers";
import type { Said } from "@engenty-wizards/shared/run";
import { note, saidText } from "@engenty-wizards/shared/run";

export interface InputError {
  field: string;
  message: Said;
}

/** The field errors in a language, for whoever reads them. */
export function fieldErrorsIn(errors: InputError[], lang: Lang) {
  return errors.map((e) => ({ field: e.field, message: saidText(e.message, lang) }));
}

function empty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function coerce(field: Field, raw: unknown): unknown {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  switch (field.kind) {
    case "number": {
      if (String(raw).trim() === "") {
        return undefined;
      }
      return readNumber(raw) ?? Number.NaN;
    }
    case "toggle":
      return raw === true || raw === "true" || raw === "on";
    case "multiselect":
      return (Array.isArray(raw) ? raw : [raw])
        .map(String)
        .filter((v) => field.options?.includes(v));
    // The offered time as written, also when the answer names the same moment in another offset.
    case "slot": {
      const v = String(raw).trim();
      return v ? (offeredSlot(v, field.options ?? []) ?? v) : undefined;
    }
    case "image":
    case "file": {
      const ids = (Array.isArray(raw) ? raw : [raw])
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .slice(0, MAX_FILES);
      if (!ids.length) {
        return undefined;
      }
      return field.multiple ? ids : ids[0];
    }
    case "signature":
      return typeof raw === "string" && raw ? raw.slice(0, 64) : undefined;
    case "audio":
      return readAudio(raw);
    case "location":
      return readLocation(raw);
    // The account and the list live in the wizard's store, not in the page's answers.
    case "connection":
    case "list":
      return undefined;
    case "items": {
      if (!Array.isArray(raw)) {
        return [];
      }
      const cols = field.columns ?? [];
      return raw
        .filter((r) => r && typeof r === "object")
        .map((r) =>
          Object.fromEntries(
            cols.map((c) => {
              const v = (r as Record<string, unknown>)[c.id];
              if (c.kind === "text") {
                return [c.id, String(v ?? "").slice(0, 2000)];
              }
              return [c.id, readNumber(v) ?? 0];
            }),
          ),
        )
        .filter((r) => Object.values(r).some((v) => v !== "" && v !== 0))
        .slice(0, 200);
    }
    default:
      return String(raw).slice(0, 20_000);
  }
}

function finite(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A position from the device, a typed place, or both. Coordinates outside the globe are dropped,
 * so a step never reads a point that cannot exist.
 */
function readLocation(raw: unknown): LocationValue | undefined {
  if (typeof raw === "string") {
    const label = raw.trim().slice(0, 300);
    return label ? { label } : undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const input = raw as Record<string, unknown>;
  const out: LocationValue = {};
  const lat = finite(input.lat);
  const lng = finite(input.lng);
  if (lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    out.lat = Math.round(lat * 1e6) / 1e6;
    out.lng = Math.round(lng * 1e6) / 1e6;
    const accuracy = finite(input.accuracy);
    if (accuracy !== undefined && accuracy >= 0) {
      out.accuracy = Math.round(accuracy);
    }
  }
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 300) : "";
  if (label) {
    out.label = label;
  }
  return isLocationValue(out) ? out : undefined;
}

/** A recording by its upload id; a transcript the page already shows travels with it. */
function readAudio(raw: unknown): AudioValue | undefined {
  const input = typeof raw === "string" ? { asset: raw } : (raw as Record<string, unknown> | null);
  if (!input || typeof input !== "object" || typeof input.asset !== "string" || !input.asset) {
    return undefined;
  }
  const out: AudioValue = { asset: input.asset.slice(0, 64) };
  const seconds = finite(input.seconds);
  if (seconds !== undefined && seconds >= 0) {
    out.seconds = Math.round(seconds);
  }
  if (typeof input.transcript === "string") {
    out.transcript = input.transcript.slice(0, 20_000);
  }
  if (isLang(input.lang)) {
    out.lang = input.lang;
  }
  return out;
}

/** What a page knows beyond the person's input: earlier answers and outputs, data-driven choices. */
export interface PageContext {
  /** Values the fields' `when` read from before the page. */
  known?: Record<string, unknown>;
  /** Choices from earlier data (`optionsFrom`), by field id. */
  options?: Record<string, string[]>;
  /** The same choices as cards, for fields with `cards`; the view shows them, nothing is checked against them. */
  cards?: Record<string, CardOption[]>;
  /** The decided fields (`ask`, `group`) a decision kept; the others are not asked. */
  decided?: string[];
}

/**
 * Keep only this page's fields that are shown, typed; report what is missing or wrong. A field
 * whose `when` does not hold is not asked: it is neither required nor kept.
 */
export function readPageInput(
  step: PageStep,
  input: Record<string, unknown>,
  context: PageContext = {},
): { values: Record<string, unknown>; errors: InputError[] } {
  const values: Record<string, unknown> = {};
  const errors: InputError[] = [];
  const fields = step.fields
    .filter((f) => !isDecidedField(f) || context.decided?.includes(f.id))
    .map((f) => (context.options?.[f.id]?.length ? { ...f, options: context.options[f.id] } : f));
  const typed = Object.fromEntries(fields.map((f) => [f.id, coerce(f, input[f.id])]));
  for (const field of shownFields(fields, context.known ?? {}, typed)) {
    const v = typed[field.id];
    if (field.kind === "connection" || field.kind === "list") {
      continue;
    }
    if (field.required && empty(v) && field.kind !== "toggle") {
      errors.push({ field: field.id, message: note("fieldRequired") });
      continue;
    }
    if (Array.isArray(v) && (field.kind === "image" || field.kind === "file")) {
      if (field.min && v.length < field.min) {
        errors.push({
          field: field.id,
          message: note("chooseAtLeast", { min: field.min }),
        });
        continue;
      }
      if (field.max && v.length > field.max) {
        errors.push({
          field: field.id,
          message: note("chooseAtMost", { max: field.max }),
        });
        continue;
      }
    }
    if (field.kind === "number" && Number.isNaN(v)) {
      errors.push({
        field: field.id,
        message: note("enterNumber"),
      });
      continue;
    }
    if (field.kind === "select" && !empty(v) && !field.options?.includes(String(v))) {
      errors.push({ field: field.id, message: note("invalidChoice") });
      continue;
    }
    if (field.kind === "slot" && !empty(v) && !field.options?.includes(String(v))) {
      errors.push({
        field: field.id,
        message: note("timeNotOffered"),
      });
      continue;
    }
    if (field.kind === "email" && !empty(v) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) {
      errors.push({
        field: field.id,
        message: note("notValidEmailAddress"),
      });
      continue;
    }
    if (field.kind === "url" && !empty(v)) {
      try {
        new URL(String(v));
      } catch {
        errors.push({
          field: field.id,
          message: note("notValidUrl"),
        });
        continue;
      }
    }
    if (v !== undefined) {
      values[field.id] = v;
    }
  }
  return { values, errors };
}

export function defaultsFor(step: PageStep): Record<string, unknown> {
  return Object.fromEntries(
    step.fields.filter((f) => f.default !== undefined).map((f) => [f.id, f.default]),
  );
}
