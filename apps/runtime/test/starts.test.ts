import {
  describeStart,
  nextRunAt,
  scheduleDue,
  startSchema,
  type WizardStart,
} from "@engenty-wizards/shared/starts";
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

describe("scheduleDue", () => {
  const weekly = { every: "week" as const, weekday: 1, time: "08:00", tz: vienna };
  const made = new Date("2026-09-01T10:00:00Z");

  it("is due once after a restart that missed several turns", () => {
    const last = new Date("2026-09-14T06:00:00Z"); // a Monday, four weeks back
    expect(scheduleDue(weekly, last, made, new Date("2026-10-10T10:00:00Z"))).toBe(true);
  });

  it("is not due again right after it ran", () => {
    const last = new Date("2026-10-12T06:00:00Z");
    expect(scheduleDue(weekly, last, made, new Date("2026-10-12T06:01:00Z"))).toBe(false);
  });

  it("waits for its first time after it was made", () => {
    const now = new Date("2026-10-10T10:00:00Z");
    expect(scheduleDue(weekly, null, now, now)).toBe(false);
    expect(scheduleDue(weekly, null, now, new Date("2026-10-12T06:00:00Z"))).toBe(true);
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
      schedule: { every: "week", weekday: 1, time: "08:00", tz: vienna },
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
