import {
  describeStart,
  dueOccurrence,
  lastOccurrence,
  nextRunAt,
  occurrenceKey,
  startSchema,
  type WizardStart,
} from "@engenty/wizards-shared/starts";
import { describe, expect, it } from "vitest";

const vienna = "Europe/Vienna";

describe("nextRunAt", () => {
  it("finds the next full hour", () => {
    const next = nextRunAt(
      { every: "hour", time: "00:00", tz: vienna },
      new Date("2026-10-10T09:17:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-10-10T10:00:00.000Z");
  });

  it("finds the next Monday 08:00 in the zone", () => {
    // Saturday 10 October 2026, summer time (UTC+2)
    const next = nextRunAt(
      { every: "week", weekday: 1, time: "08:00", tz: vienna },
      new Date("2026-10-10T10:00:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-10-12T06:00:00.000Z");
  });

  it("keeps the wall clock across the end of summer time", () => {
    // Summer time ends on 25 October 2026: 08:00 Vienna is then UTC+1.
    const next = nextRunAt(
      { every: "day", time: "08:00", tz: vienna },
      new Date("2026-10-25T07:30:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-10-26T07:00:00.000Z");
  });

  it("takes tomorrow when today's time is exactly now", () => {
    const next = nextRunAt(
      { every: "day", time: "08:00", tz: vienna },
      new Date("2026-10-10T06:00:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-10-11T06:00:00.000Z");
  });

  it("finds the first of the month", () => {
    const next = nextRunAt(
      { every: "month", day: 1, time: "09:00", tz: vienna },
      new Date("2026-10-10T06:00:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });
});

describe("nextRunAt across daylight saving in Europe/Vienna", () => {
  const daily = (time: string) => ({ every: "day" as const, time, tz: vienna });

  it("does not jump the 23-hour day summer time starts on", () => {
    // Saturday 28 March 2026, 23:30 Vienna. A step of 24 hours lands on Monday 00:30.
    const next = nextRunAt(daily("08:00"), new Date("2026-03-28T22:30:00Z"));
    expect(next?.toISOString()).toBe("2026-03-29T06:00:00.000Z");
  });

  it("moves a time the clocks skip to just after the gap, once", () => {
    const first = nextRunAt(daily("02:30"), new Date("2026-03-29T00:00:00Z"));
    expect(first?.toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 03:30 summer time
    const then = nextRunAt(daily("02:30"), first as Date);
    expect(then?.toISOString()).toBe("2026-03-30T00:30:00.000Z"); // 02:30 summer time
  });

  it("takes a time the clocks show twice once", () => {
    const first = nextRunAt(daily("02:30"), new Date("2026-10-24T23:00:00Z"));
    expect(first?.toISOString()).toBe("2026-10-25T01:30:00.000Z"); // the second 02:30
    const then = nextRunAt(daily("02:30"), first as Date);
    expect(then?.toISOString()).toBe("2026-10-26T01:30:00.000Z");
  });

  it("keeps a weekly time on the wall clock on both sides", () => {
    const weekly = { every: "week" as const, weekday: 1, time: "09:00", tz: vienna };
    expect(nextRunAt(weekly, new Date("2026-10-19T08:00:00Z"))?.toISOString()).toBe(
      "2026-10-26T08:00:00.000Z",
    );
    expect(nextRunAt(weekly, new Date("2026-03-23T09:00:00Z"))?.toISOString()).toBe(
      "2026-03-30T07:00:00.000Z",
    );
  });
});

describe("lastOccurrence", () => {
  const weekly = { every: "week" as const, weekday: 1, time: "09:00", tz: vienna };

  it("finds the latest time at or before now", () => {
    expect(lastOccurrence(weekly, new Date("2026-10-15T10:00:00Z"))?.toISOString()).toBe(
      "2026-10-12T07:00:00.000Z",
    );
    expect(lastOccurrence(weekly, new Date("2026-10-12T07:00:00Z"))?.toISOString()).toBe(
      "2026-10-12T07:00:00.000Z",
    );
  });

  it("finds the hour and the month", () => {
    expect(
      lastOccurrence(
        { every: "hour", time: "00:00", tz: vienna },
        new Date("2026-10-10T09:17:00Z"),
      )?.toISOString(),
    ).toBe("2026-10-10T09:00:00.000Z");
    expect(
      lastOccurrence(
        { every: "month", day: 28, time: "09:00", tz: vienna },
        new Date("2026-03-01T10:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-02-28T08:00:00.000Z");
  });

  it("is the same instant for two looks in the same interval", () => {
    const a = lastOccurrence(weekly, new Date("2026-10-12T07:00:05Z")) as Date;
    const b = lastOccurrence(weekly, new Date("2026-10-12T07:00:50Z")) as Date;
    expect(occurrenceKey("s", a)).toBe(occurrenceKey("s", b));
  });
});

describe("dueOccurrence", () => {
  const weekly = {
    every: "week" as const,
    weekday: 1,
    time: "08:00",
    tz: vienna,
    maxLateMinutes: 1440,
  };

  it("is the latest of several missed times, once", () => {
    // Handled four weeks back. Tuesday morning, a day late at most.
    const due = dueOccurrence(
      weekly,
      new Date("2026-09-14T06:00:00Z"),
      new Date("2026-10-13T05:00:00Z"),
    );
    expect(due).toEqual({ at: new Date("2026-10-12T06:00:00Z"), late: false });
    // Once handled, nothing is left of the times before it.
    expect(dueOccurrence(weekly, due?.at as Date, new Date("2026-10-13T05:01:00Z"))).toBeNull();
  });

  it("says when that time is past the limit", () => {
    const due = dueOccurrence(
      weekly,
      new Date("2026-09-14T06:00:00Z"),
      new Date("2026-10-13T06:00:01Z"),
    );
    expect(due).toEqual({ at: new Date("2026-10-12T06:00:00Z"), late: true });
  });

  it("waits for the first time after the start was made", () => {
    const now = new Date("2026-10-10T10:00:00Z");
    expect(dueOccurrence(weekly, now, now)).toBeNull();
    expect(dueOccurrence(weekly, now, new Date("2026-10-12T06:00:00Z"))).toEqual({
      at: new Date("2026-10-12T06:00:00Z"),
      late: false,
    });
  });
});

describe("startSchema", () => {
  it("wants the settings of its kind", () => {
    expect(startSchema.safeParse({ id: "a", kind: "schedule" }).success).toBe(false);
    expect(
      startSchema.safeParse({
        id: "a",
        kind: "schedule",
        schedule: { every: "week", time: "08:00", tz: vienna },
      }).success,
    ).toBe(false);
    const ok = startSchema.parse({
      id: "a",
      kind: "schedule",
      schedule: { every: "week", weekday: 1, time: "08:00", tz: vienna },
    });
    expect(ok.on).toBe(true);
    expect(ok.passReviews).toBe(true);
    expect(ok.allowChanges).toBe(false);
    expect(ok.schedule?.overlap).toBe("skip");
    expect(ok.schedule?.maxLateMinutes).toBe(1440);
  });

  it("refuses a time zone that does not exist", () => {
    expect(
      startSchema.safeParse({
        id: "a",
        kind: "schedule",
        schedule: { every: "day", time: "08:00", tz: "Mars/Olympus" },
      }).success,
    ).toBe(false);
  });

  it("takes literal answers and paths", () => {
    const s = startSchema.parse({
      id: "b",
      kind: "record",
      record: { source: "table:leads", event: "added" },
      answers: { company: { from: "row.Firma" }, region: "Styria" },
    });
    expect(s.answers.company).toEqual({ from: "row.Firma" });
    expect(s.answers.region).toBe("Styria");
  });
});

describe("describeStart", () => {
  const base = {
    id: "x",
    on: true,
    answers: {},
    allowChanges: false,
    passReviews: true,
    failures: 0,
  };

  it("says the schedule", () => {
    const s: WizardStart = {
      ...base,
      kind: "schedule",
      schedule: {
        every: "week",
        weekday: 1,
        time: "08:00",
        tz: vienna,
        overlap: "skip",
        maxLateMinutes: 1440,
      },
    };
    expect(describeStart(s, "de")).toBe("Jeden Montag um 08:00");
    expect(describeStart(s, "en")).toBe("Every Monday at 08:00");
  });

  it("says the record with its label", () => {
    const s: WizardStart = {
      ...base,
      kind: "record",
      record: { source: "table:leads", event: "became", column: "Status", value: "gewonnen" },
    };
    expect(describeStart(s, "de", { source: "Leads" })).toBe(
      "Wenn in Leads „Status“ zu „gewonnen“ wird",
    );
  });
});
