import { z } from "zod";
import type { Lang } from "./definition.js";
import { type Line, type Texts, textOf } from "./texts.js";

/**
 * A start is what begins a run without a person opening the link: a clock, an address another
 * service calls, a row that appears or changes in a table, another wizard that finished. Starts
 * sit on the wizard row of one install, beside how it is shared; the definition does not know
 * them. Plan: `docs/plans/starts.md`.
 */

export const START_KINDS = ["schedule", "webhook", "record", "wizard"] as const;
export type StartKind = (typeof START_KINDS)[number];

export const SCHEDULE_EVERY = ["hour", "day", "week", "month"] as const;
export type ScheduleEvery = (typeof SCHEDULE_EVERY)[number];

export const RECORD_EVENTS = ["added", "changed", "became"] as const;
export type RecordEvent = (typeof RECORD_EVENTS)[number];

/** `start` is reserved on a run's values for what started it; no field may take the id. */
export const START_VALUE_ID = "start";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const scheduleSchema = z
  .object({
    every: z.enum(SCHEDULE_EVERY),
    /** 0 = Sunday … 6 = Saturday; for `week`. */
    weekday: z.number().int().min(0).max(6).optional(),
    /** 1–28, so every month has the day; for `month`. */
    day: z.number().int().min(1).max(28).optional(),
    /** "08:00"; not read for `hour`. */
    time: z.string().regex(TIME),
    /** An IANA zone, "Europe/Vienna". */
    tz: z.string().min(1),
  })
  .refine((s) => s.every !== "week" || s.weekday !== undefined, {
    message: "A weekly schedule names its weekday.",
  })
  .refine((s) => s.every !== "month" || s.day !== undefined, {
    message: "A monthly schedule names its day.",
  });
export type Schedule = z.infer<typeof scheduleSchema>;

/** A field's value a start brings: a literal, or a path into what started the run. */
export const startAnswerSchema = z.union([
  z.object({ from: z.string().min(1) }).strict(),
  z.unknown(),
]);

export const startSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(START_KINDS),
    on: z.boolean().default(true),
    schedule: scheduleSchema.optional(),
    /** The address shows its token once; only the hash stays. */
    webhook: z.object({ tokenHash: z.string().min(1) }).optional(),
    record: z
      .object({
        /** `table:<id>` for a table of the space, `<plugin>:<kind>` for a plugin's records. */
        source: z.string().min(1),
        event: z.enum(RECORD_EVENTS),
        column: z.string().optional(),
        value: z.unknown().optional(),
      })
      .refine((r) => r.event !== "became" || (r.column && r.value !== undefined), {
        message: "A 'became' start names the column and the value.",
      })
      .optional(),
    wizard: z.object({ id: z.string().min(1) }).optional(),
    /** Field id → what fills it. A field left out is asked of the owner when required. */
    answers: z.record(z.string(), startAnswerSchema).default({}),
    /** Confirm asks (a write into a connected service) are answered "done". */
    allowChanges: z.boolean().default(false),
    /** Reviews pass with "Looks good". */
    passReviews: z.boolean().default(true),
    /** Whose runs they are: the person who made the start. Their store, their notices. */
    owner: z.string().optional(),
    /** When the start was made: a schedule waits for its first time after it. */
    createdAt: z.string().optional(),
    lastRunAt: z.string().optional(),
    /** Failed runs in a row; three pause the start. */
    failures: z.number().int().min(0).default(0),
    pausedReason: z.string().optional(),
  })
  .refine((s) => s[s.kind] !== undefined, {
    message: "A start carries the settings of its kind.",
  });
export type WizardStart = z.infer<typeof startSchema>;

export const startsSchema = z.array(startSchema).max(20);

/** How many failed runs in a row pause a start. */
export const START_FAILURES_TO_PAUSE = 3;

/** What began a run, kept on the run: the start, and what it was about (a row, another run). */
export interface StartedBy {
  kind: StartKind;
  startId: string;
  ref?: string;
}

/** What a start brings into the run, read as `{{start.…}}` and by the AI steps. */
export interface StartEvent {
  kind: StartKind;
  /** ISO time the start fired. */
  at: string;
  /** A webhook's body. */
  body?: unknown;
  /** A record's cells, and the cells before the change. */
  row?: Record<string, unknown>;
  before?: Record<string, unknown>;
  /** The run of the wizard that finished: its answers and outputs. */
  run?: { id: string; values: Record<string, unknown>; outputs: Record<string, unknown> };
}

/** A dotted path into the event: "row.Firma", "body.invoice.pdf_url". */
export function readEventPath(event: StartEvent, path: string): unknown {
  let cur: unknown = event;
  for (const key of path.split(".")) {
    cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
  }
  return cur;
}

/** The answers a start brings, resolved against the event: field id → value. */
export function fillOf(start: WizardStart, event: StartEvent): Record<string, unknown> {
  const fill: Record<string, unknown> = {};
  for (const [field, answer] of Object.entries(start.answers)) {
    const value =
      answer && typeof answer === "object" && "from" in answer
        ? readEventPath(event, String((answer as { from: string }).from))
        : answer;
    if (value !== undefined && value !== null && value !== "") {
      fill[field] = value;
    }
  }
  return fill;
}

// --- time ----------------------------------------------------------------------------------

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  weekday: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formats.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall clock of `date` in `tz`. */
export function zonedParts(date: Date, tz: string): Parts {
  const parts: Record<string, string> = {};
  for (const p of formatFor(tz).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    min: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

/** The instant at which `tz` shows this wall clock; a time a DST gap skips lands after it. */
export function zonedDate(y: number, m: number, d: number, h: number, min: number, tz: string) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    if (seen === want) {
      break;
    }
    guess += want - seen;
  }
  return new Date(guess);
}

const DAY_MS = 86_400_000;

/** When the schedule fires next after `after`, or null when no day fits. */
export function nextRunAt(schedule: Schedule, after: Date): Date | null {
  if (schedule.every === "hour") {
    return new Date((Math.floor(after.getTime() / 3_600_000) + 1) * 3_600_000);
  }
  const [h, min] = schedule.time.split(":").map(Number);
  // Walk day by day on the zone's calendar: a month ahead reaches every schedule.
  for (let i = 0; i <= 62; i++) {
    const day = zonedParts(new Date(after.getTime() + i * DAY_MS), schedule.tz);
    const fits =
      schedule.every === "day" ||
      (schedule.every === "week" && day.weekday === schedule.weekday) ||
      (schedule.every === "month" && day.d === schedule.day);
    if (!fits) {
      continue;
    }
    const at = zonedDate(day.y, day.m, day.d, h, min, schedule.tz);
    if (at.getTime() > after.getTime()) {
      return at;
    }
  }
  return null;
}

/**
 * Whether a schedule that last ran at `last` is due at `now`. `last` null: the start was made at
 * `since` and waits for its first time. A runtime that was off runs a missed turn once when it
 * is back, not once per turn it missed.
 */
export function scheduleDue(schedule: Schedule, last: Date | null, since: Date, now: Date) {
  const next = nextRunAt(schedule, last ?? since);
  return next !== null && next.getTime() <= now.getTime();
}

// --- words ---------------------------------------------------------------------------------

type StartTextKey =
  | "hour"
  | "day"
  | "week"
  | "month"
  | "webhook"
  | "added"
  | "became"
  | "changed"
  | "wizard"
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

// Wording: docs/copy-style.md. Check with `pnpm copy:check`.
const STARTS_EN: Record<StartTextKey, Line> = {
  hour: "Every hour",
  day: "Every day at {time}",
  week: "Every {weekday} at {time}",
  month: "On the {day} of each month at {time}",
  webhook: "When something arrives at the address",
  added: "When a row is added to {source}",
  became: "When {column} in {source} becomes “{value}”",
  changed: "When a row in {source} changes",
  wizard: "When {wizard} finishes",
  sunday: "Sunday",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
};

const STARTS_DE: Record<StartTextKey, Line> = {
  hour: "Jede Stunde",
  day: "Jeden Tag um {time}",
  week: "Jeden {weekday} um {time}",
  month: "Am {day}. jedes Monats um {time}",
  webhook: "Wenn etwas an der Adresse eintrifft",
  added: "Wenn eine Zeile zu {source} kommt",
  became: "Wenn in {source} „{column}“ zu „{value}“ wird",
  changed: "Wenn sich eine Zeile in {source} ändert",
  wizard: "Wenn {wizard} fertig ist",
  sunday: "Sonntag",
  monday: "Montag",
  tuesday: "Dienstag",
  wednesday: "Mittwoch",
  thursday: "Donnerstag",
  friday: "Freitag",
  saturday: "Samstag",
};

const STARTS_TEXTS: Texts<StartTextKey> = { en: STARTS_EN, de: STARTS_DE };

const WEEKDAY_KEYS: StartTextKey[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Labels the sentence needs from outside the start: a table's title, a wizard's title. */
export interface StartLabels {
  source?: string;
  wizard?: string;
}

/** The day of the month as the language writes it: "1st", "1." */
function dayText(day: number, lang: Lang) {
  if (lang === "de") {
    return String(day);
  }
  const rest = day % 10;
  const teen = day % 100 >= 11 && day % 100 <= 13;
  return `${day}${teen ? "th" : rest === 1 ? "st" : rest === 2 ? "nd" : rest === 3 ? "rd" : "th"}`;
}

/** One sentence per start, the one the share dialog shows: "Jeden Montag um 08:00". */
export function describeStart(start: WizardStart, lang: Lang, labels: StartLabels = {}) {
  const say = (key: StartTextKey, params?: Record<string, string | number | undefined>) =>
    textOf(STARTS_TEXTS, key, lang, params);
  switch (start.kind) {
    case "schedule": {
      const s = start.schedule;
      if (!s) {
        return "";
      }
      return say(s.every, {
        time: s.time,
        weekday: say(WEEKDAY_KEYS[s.weekday ?? 0] ?? "sunday"),
        day: dayText(s.day ?? 1, lang),
      });
    }
    case "webhook":
      return say("webhook");
    case "record": {
      const r = start.record;
      const source = labels.source ?? r?.source ?? "";
      if (r?.event === "added") {
        return say("added", { source });
      }
      if (r?.event === "became") {
        return say("became", { source, column: r.column, value: String(r.value) });
      }
      return say("changed", { source });
    }
    case "wizard":
      return say("wizard", { wizard: labels.wizard ?? start.wizard?.id ?? "" });
  }
}
