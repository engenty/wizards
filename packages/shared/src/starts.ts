import { z } from "zod";

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

export type StartLang = "de" | "en";

/** Labels the sentence needs from outside the start: a table's title, a wizard's title. */
export interface StartLabels {
  source?: string;
  wizard?: string;
}

const DE_WEEKDAYS = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
];
const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function describeSchedule(s: Schedule, de: boolean) {
  switch (s.every) {
    case "hour":
      return de ? "Jede Stunde" : "Every hour";
    case "day":
      return de ? `Jeden Tag um ${s.time}` : `Every day at ${s.time}`;
    case "week": {
      const wd = (de ? DE_WEEKDAYS : EN_WEEKDAYS)[s.weekday ?? 0];
      return de ? `Jeden ${wd} um ${s.time}` : `Every ${wd} at ${s.time}`;
    }
    case "month":
      return de
        ? `Am ${s.day}. jedes Monats um ${s.time}`
        : `On the ${ordinal(s.day ?? 1)} of each month at ${s.time}`;
  }
}

/** One sentence per start, the one the share dialog shows: "Jeden Montag um 08:00". */
export function describeStart(start: WizardStart, lang: StartLang, labels: StartLabels = {}) {
  const de = lang === "de";
  switch (start.kind) {
    case "schedule":
      return start.schedule ? describeSchedule(start.schedule, de) : "";
    case "webhook":
      return de ? "Wenn etwas an der Adresse eintrifft" : "When something arrives at the address";
    case "record": {
      const r = start.record;
      const src = labels.source ?? r?.source ?? "";
      if (r?.event === "added") {
        return de ? `Wenn eine Zeile zu ${src} kommt` : `When a row is added to ${src}`;
      }
      if (r?.event === "became") {
        return de
          ? `Wenn in ${src} „${r.column}“ zu „${String(r.value)}“ wird`
          : `When ${r.column} in ${src} becomes "${String(r.value)}"`;
      }
      return de ? `Wenn sich eine Zeile in ${src} ändert` : `When a row in ${src} changes`;
    }
    case "wizard": {
      const w = labels.wizard ?? start.wizard?.id ?? "";
      return de ? `Wenn ${w} fertig ist` : `When ${w} finishes`;
    }
  }
}

function ordinal(n: number) {
  const rest = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : rest === 1 ? "st" : rest === 2 ? "nd" : rest === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}
