import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { type RunState, type StepOutput, shownStatus } from "@engenty/wizards-shared/run";
import { type Pending, ServiceError } from "@engenty/wizards-shared/run-services";
import { describe, expect, it } from "vitest";
import { memoryHost } from "./memory-host.js";

/**
 * A whole step a service works on for long (a film, a video) answers `pending`: the run sleeps
 * with the job, and asks again when it wakes, for the same step, until the job is done.
 */

const def = {
  version: 1,
  title: "Film",
  description: "",
  avatar: "round",
  steps: [
    { id: "film", type: "motion-graphics", title: "Film", brief: "A film.", format: "landscape" },
    {
      id: "after",
      type: "agent",
      title: "After",
      instructions: "Say so.",
      tools: [],
      output: { format: "text" },
    },
    { id: "done", type: "result", title: "Done", deliverables: [] },
  ],
} as unknown as WizardDefinition;

const film: StepOutput = {
  text: "the film",
  assets: [{ id: "a1", kind: "video", mime: "video/mp4", name: "film.mp4" }],
  at: "2026-11-10T09:30:00.000Z",
};

/** The service as a script: one answer per ask, with the job the run asked with. */
function service(...answers: (Pending | StepOutput | Error)[]) {
  const asked: (string | null)[] = [];
  return {
    asked,
    steps: (_step: unknown, state: RunState) => {
      asked.push(state.job?.id ?? null);
      const next = answers.shift();
      if (!next) {
        throw new Error("asked once too often");
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

const pending = (id: string, wakeAt: number | null = null): Pending => ({
  pending: true,
  id,
  wakeAt,
});

const started = (lines: [string | null, string, string][], stepId: string) =>
  lines.filter(([s, type]) => s === stepId && type === "step_started").length;

describe("a step a service works on for long", () => {
  it("sleeps on the job, and goes on with its output when woken", async () => {
    const s = service(pending("job-1"), film);
    const run = memoryHost(def, { steps: s.steps, script: () => "after" });
    await run.start();

    expect(run.row.run.status).toBe("sleeping");
    expect(run.row.run.cursor).toBe("film");
    expect(run.row.run.wakeAt).toBeNull();
    expect(run.row.run.state.job).toEqual({ stepId: "film", id: "job-1" });
    // No time to wake at: the service wakes it.
    expect(run.wakes.at(-1)).toBeNull();
    // Whoever looks sees the step at work.
    expect(shownStatus({ ...run.row.run })).toBe("running");

    await run.wake();
    expect(s.asked).toEqual([null, "job-1"]);
    expect(run.row.run.status).toBe("done");
    expect(run.row.run.state.outputs.film).toEqual(film);
    expect(run.row.run.state.job).toBeUndefined();
    // One visit of the step in the log, as if it had worked in one go.
    expect(started(run.lines, "film")).toBe(1);
    expect(run.lines.filter(([s, type]) => s === "film" && type === "step_done")).toHaveLength(1);
    expect(run.lines.some(([s, type]) => s === "film" && type === "wait")).toBe(false);
  });

  it("looks again at the job's time while it works, and sleeps on", async () => {
    const now = Date.parse("2026-11-10T09:00:00Z");
    const s = service(pending("job-1", now + 120_000), pending("job-1", now + 240_000), film);
    const run = memoryHost(def, { now, steps: s.steps, script: () => "after" });
    await run.start();
    expect(run.row.run.wakeAt).toBe(now + 120_000);
    expect(run.wakes).toContain(now + 120_000);

    await run.wake();
    expect(run.row.run.status).toBe("sleeping");
    expect(run.row.run.wakeAt).toBe(now + 240_000);
    expect(run.row.run.state.job?.id).toBe("job-1");

    await run.wake();
    expect(run.row.run.status).toBe("done");
    expect(s.asked).toEqual([null, "job-1", "job-1"]);
    expect(started(run.lines, "film")).toBe(1);
  });

  it("a service woke it early: the run asks, and the step goes on before its time", async () => {
    const now = Date.parse("2026-11-10T09:00:00Z");
    const s = service(pending("job-1", now + 120_000), film);
    const run = memoryHost(def, { now, steps: s.steps, script: () => "after" });
    await run.start();
    await run.advance({ kind: "woke" });
    expect(run.clock.now).toBe(now);
    expect(run.row.run.status).toBe("done");
  });

  it("a failed job is the step's failure, with its class; the next try starts a new job", async () => {
    const s = service(
      pending("job-1"),
      new ServiceError({ class: "retry", retryAfterMs: null }, "The renderer was not reached."),
      pending("job-2"),
      film,
    );
    const run = memoryHost(def, { steps: s.steps, script: () => "after" });
    await run.start();
    await run.wake();
    expect(run.row.run.status).toBe("sleeping");
    expect(run.row.run.state.pause).toEqual({ kind: "retry" });
    expect(run.row.run.state.job).toBeUndefined();
    expect(shownStatus(run.row.run)).toBe("sleeping");

    await run.wake();
    expect(run.row.run.state.job).toEqual({ stepId: "film", id: "job-2" });
    await run.wake();
    expect(run.row.run.status).toBe("done");
    expect(s.asked).toEqual([null, "job-1", null, "job-2"]);
  });

  it("a final failure fails the run, and leaves no job behind", async () => {
    const s = service(
      pending("job-1"),
      new ServiceError({ class: "final" }, "The film could not be made."),
    );
    const run = memoryHost(def, { steps: s.steps, script: () => "after" });
    await run.start();
    await run.wake();
    expect(run.row.run.status).toBe("failed");
    expect(run.row.run.state.job).toBeUndefined();
  });

  it("a cancel while the job works ends the run where it sleeps", async () => {
    const s = service(pending("job-1"));
    const run = memoryHost(def, { steps: s.steps });
    await run.start();
    await run.advance({ kind: "cancel" });
    expect(run.row.run.status).toBe("cancelled");
    expect(s.asked).toEqual([null]);
  });
});
