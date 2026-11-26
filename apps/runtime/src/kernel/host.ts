import {
  type AskRow,
  begin,
  createKernel,
  quickjsTurn,
  type Row,
  type Run,
  type Score,
} from "@engenty/wizards-kernel";
import { type Field, type KernelFile, shownFields } from "@engenty/wizards-shared/definition";
import { kernelOf } from "@engenty/wizards-shared/kernel-file";
import type { RunStatus } from "@engenty/wizards-shared/run";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { RunRow, SpaceRow } from "../engine/types.js";
import { env } from "../env.js";
import { managed } from "../manage.js";
import { kernelBatteries, type MakeContext } from "./batteries.js";
import { kernelOutline } from "./outline.js";
import { signalFor } from "./signals.js";
import { stepTitles } from "./still.js";
import { kernelStore, loadKernelRun } from "./store.js";
import { KernelCompileError, kernelWizard, type StepMode } from "./wizard.js";

/**
 * The runtime as the kernel's host (docs/plans/kernel.md): a run of a wizard in version 0.3.0 is
 * created, put in line, claimed and woken as every run is. Where today's engine would walk the
 * definition's steps, the kernel moves the run instead; where a person answers, the answer goes
 * into a row.
 */
export type KernelDeps = {
  loadRun(runId: string): Promise<RunRow | undefined>;
  updateRun(
    runId: string,
    patch: Partial<typeof schema.run.$inferInsert>,
    seen?: { rev: number } | "open",
  ): Promise<boolean>;
  loadSpace(run: RunRow): Promise<SpaceRow>;
  makeContext: MakeContext;
  kick(runId: string): void;
};

export class KernelRunError extends Error {}

/**
 * How a step's code runs here (docs/plans/kernel.md, decision 6). As ordinary code only where
 * this runner is one tenant's, or the runtime is one person's own install, and the wizard is not
 * someone else's. In QuickJS everywhere else. `KERNEL_STEPS` says it outright, for tests.
 */
export function stepMode(wizard?: { starter: string | null } | null): StepMode {
  const told = process.env.KERNEL_STEPS;
  if (told === "native" || told === "quickjs") {
    return told;
  }
  const ownRunner = Boolean(env.runner.tenant) || !managed;
  return ownRunner && !wizard?.starter ? "native" : "quickjs";
}

/** The share of finished runs whose evals judge them, 0 to 1. */
const evalShare = () => Math.min(1, Math.max(0, Number(process.env.KERNEL_EVALS ?? 0) || 0));

const quickjs = quickjsTurn();

/** Where the run's wizard comes from: one made from a marketplace entry is someone else's code. */
const wizardOf = (row: RunRow) =>
  db.query.wizard.findFirst({
    where: eq(schema.wizard.id, row.wizardId),
    columns: { starter: true },
  });
const isAsk = (row: Row): row is AskRow => !("left" in row);

export type KernelRunView = {
  id: string;
  status: RunStatus;
  cursor: string | null;
  rows: Row[];
  /** The rows that wait for somebody, or for a signal or a time. */
  waiting: AskRow[];
  scores: Score[];
  output?: Record<string, unknown>;
  error?: string;
  rev: number;
  /** Each step's title and working line as its file writes them, for a step with no ask yet. */
  titles?: Record<string, { title?: string; working?: string }>;
};

export function kernelHost(deps: KernelDeps) {
  const fileOf = (run: RunRow): KernelFile => {
    const file = kernelOf(run.definition);
    if (!file) {
      throw new KernelRunError("This run is not of a wizard in version 0.3.0.");
    }
    return file;
  };

  /** For a person's write: it holds only on the run as it was read. */
  const personal = () =>
    createKernel({
      store: kernelStore(deps.loadRun, deps.updateRun),
      wizards: () => {
        throw new KernelRunError("A person's write does not move the run.");
      },
      // A page asks for what it shows: a required field its `when` hides is not missing.
      check: (fields, value) => {
        const page = (value ?? {}) as Record<string, unknown>;
        const lacks = shownFields((fields ?? []) as Field[], {}, page).find(
          (field) => field.required && (page[field.id] == null || page[field.id] === ""),
        );
        return lacks && `"${lacks.id}" is missing.`;
      },
    });

  /** Sets the run to work and puts it in line: the next drive moves it. */
  async function goOn(runId: string) {
    const row = await deps.loadRun(runId);
    if (row && row.status !== "running") {
      await deps.updateRun(runId, { status: "running", wakeAt: null }, { rev: row.rev });
    }
    deps.kick(runId);
  }

  return {
    /** Moves a claimed run to its next wait. Called by the engine's drive in place of its own loop. */
    async drive(row: RunRow, signal: AbortSignal): Promise<void> {
      const file = fileOf(row);
      const mode = stepMode(await wizardOf(row));
      const store = kernelStore(deps.loadRun, (id, patch) => deps.updateRun(id, patch), true);
      let wizard: Awaited<ReturnType<typeof kernelWizard>>;
      try {
        wizard = await kernelWizard(file, row.files, mode);
      } catch (err) {
        if (!(err instanceof KernelCompileError)) {
          throw err;
        }
        await deps.updateRun(row.id, { status: "failed", error: err.message, wakeAt: null });
        return;
      }
      const kept = row.state.kernel;
      if (!kept) {
        throw new KernelRunError(`Run ${row.id} has nothing of the kernel's.`);
      }
      // The run's first drive: it begins, and asks for its input where it was given none.
      if (
        kept.status === "running" &&
        kept.open === null &&
        !(await store.load(row.id))?.rows.length
      ) {
        const first = await loadKernelRun(
          { ...row, state: { ...row.state, kernel: { ...kept, input: kept.input ?? {} } } },
          true,
        );
        if (first) {
          const began = begin(
            wizard.file,
            { id: row.id, wizard: row.id, startedAt: kept.startedAt },
            kept.input ?? undefined,
          );
          Object.assign(first, { rows: began.rows, input: began.input, cursor: began.cursor });
          await store.save(first);
        }
      }
      const space = await deps.loadSpace(row);
      const kernel = createKernel({
        store,
        wizards: () => wizard,
        batteries: kernelBatteries(row, space, signal, deps.makeContext),
        ...(mode === "quickjs" ? { turn: quickjs } : {}),
      });
      // A signal for the row the run waits at answers it; the row says so with `came`.
      const takeSignal = async () => {
        const run = await store.load(row.id);
        const found = run && (await signalFor(row, space.id, run.rows));
        if (found) {
          await kernel.record(row.id, found.n, found.answer, "signal");
        }
        return Boolean(found);
      };
      // A signal that came while the run waited is taken before the clock is asked: where both
      // are there, the signal ends the wait.
      await takeSignal();
      // A row whose time has come is answered with a timeout; then the run moves.
      await kernel.wake(row.id);
      let moved = await kernel.move(row.id);
      // The run came to a wait for a signal: one sent before it got there is taken now.
      while (await takeSignal()) {
        moved = await kernel.move(row.id);
      }
      if (
        moved.status === "done" &&
        Object.keys(wizard.evals ?? {}).length &&
        Math.random() < evalShare()
      ) {
        await kernel.judge(row.id);
      }
    },

    /** A person's, a signal's or another run's answer to a waiting row. The run goes on in line. */
    async answer(runId: string, n: number, value: unknown, by?: string): Promise<void> {
      await personal().record(runId, n, value, by);
      await goOn(runId);
    },

    /** Back to row `n`: asked again, or with a value answered differently. */
    async rewind(runId: string, n: number, value?: unknown): Promise<void> {
      await personal().back(runId, n, value);
      await goOn(runId);
    },

    /** The evals that have not judged yet, now, whatever the share of runs that are judged. */
    async judge(row: RunRow, signal: AbortSignal): Promise<Score[]> {
      const mode = stepMode(await wizardOf(row));
      const wizard = await kernelWizard(fileOf(row), row.files, mode);
      const kernel = createKernel({
        store: kernelStore(deps.loadRun, deps.updateRun),
        wizards: () => wizard,
        batteries: kernelBatteries(row, await deps.loadSpace(row), signal, deps.makeContext),
        ...(mode === "quickjs" ? { turn: quickjs } : {}),
      });
      return (await kernel.judge(row.id)).scores ?? [];
    },

    async view(row: RunRow): Promise<KernelRunView> {
      const run = (await loadKernelRun(row)) as Run | undefined;
      const rows = run?.rows ?? [];
      return {
        id: row.id,
        status: row.status,
        cursor: row.cursor,
        rows,
        waiting: rows.filter(isAsk).filter((r) => r.state === "waiting"),
        scores: run?.scores ?? [],
        output: run?.output,
        error: row.error ?? undefined,
        rev: row.rev,
        titles: stepTitles(await kernelOutline(row.files ?? [])),
      };
    },
  };
}

export type KernelHost = ReturnType<typeof kernelHost>;
