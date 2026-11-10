/**
 * What the engine asks of whoever hosts a run (docs/plans/runs-on-their-own.md, "The engine and
 * what it needs from its host"). `advance(host, event)` takes the run from one event to its next
 * wait or its end; everything it cannot do itself is a call on this. The runtime is one host (its
 * runner, from package 2.3), `wizards run` and an isolated object are others.
 *
 * Left to the host: the line, the claim and the heartbeat; credits; notices that go with a status;
 * the label, the result's data and the row's other columns; who may answer.
 */
import type {
  FormStep,
  ReviewStep,
  Step,
  Who,
  WizardDefinition,
} from "@engenty/wizards-shared/definition";
import type { RunEventType, RunState, Said, StepOutput } from "@engenty/wizards-shared/run";
import type { FlowCommand, FlowFailure, FlowRun } from "@engenty/wizards-shared/transition";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import type { StepContext, StepServices, TurnStore } from "./types.js";

/** A write of the run, as the engine hands it to its host's store. */
export interface Move {
  run: FlowRun;
  /**
   * What the run does next, as the flow said. Null: the state changed where the run stands (a
   * visit counted, a turn's id, a page's fields picked) or a step's turn stopped for a person.
   */
  command: FlowCommand | null;
  /** The run failed: what its error line says, and the error itself where there was one. */
  failed?: { said: Said; err?: unknown };
}

/** The run moved under a write: another write came first. A host's store throws it, or its own. */
export class RunMoved extends Error {
  constructor() {
    super("The run moved under this write.");
    this.name = "RunMoved";
  }
}

/** How a step's error counts, as the host sorts it. */
export type StepFailure =
  /** `acted`: it may have done something out there, so it is not started again by itself. */
  | { kind: "failed"; failure: FlowFailure; acted: boolean; said: Said }
  /** A turn stopped to ask the person; its conversation is in the state, the run waits. */
  | { kind: "asked"; question: string };

/**
 * Credits for the run's next steps. `unsure`: whoever holds them is out of reach; on a wake the
 * time stays due and the clock tries again, before a step the step goes on.
 */
export type Hold = "held" | "refused" | "unsure";

/** A signal stored for the run's wait. `id`: its delivery, taken once. */
export interface SignalCame {
  id: string;
  data: Record<string, unknown> | null;
}

/** The start a run came from, with nobody there to answer its pages. */
export interface RunStart {
  /** Its setting passes a review (never an approval). */
  passReviews: boolean;
}

export interface RunHost {
  runId: string;
  def: WizardDefinition;
  /** The workspace the run started with. */
  files: WorkspaceFile[];

  /** The run's state, with its revision. */
  store: {
    load(): Promise<{ run: FlowRun; rev: number }>;
    /**
     * Writes the move, held on `rev` and on whatever else the host holds (the runtime: its drive's
     * claim). The new revision. Throws when the run moved.
     */
    save(move: Move, rev: number): Promise<number>;
  };

  /**
   * The run's agent turns, saved after every model call and every tool call. The steps' contexts
   * (`context`) carry the same store.
   */
  turns: TurnStore;

  /** The clock: now, and the wake. */
  clock: {
    now(): number;
    /** Wake the run then; null: nothing due. Set before the write that needs it. */
    wakeAt(at: number | null): Promise<void>;
  };

  /** A line of the run's log. */
  event(stepId: string | null, type: RunEventType, said: Said): Promise<void>;

  /** The run stands at a person's step: whoever it waits for hears of it. */
  ask(step: FormStep | ReviewStep, who: Who, remindAt: number | null): Promise<void>;

  /** The signals a run's wait listens for. */
  signals: {
    /** Registers the wait (again) and gives a signal stored for it, if one came first. */
    watch(stepId: string, name: string, key: string): Promise<SignalCame | null>;
    /** The run left its wait. */
    drop(): Promise<void>;
  };

  credits: {
    /** Holds what the run needs to go on: on a wake, and before a step after a long wait. */
    hold(): Promise<Hold>;
    /** Whether a step that costs may run now. */
    canSpend(): Promise<boolean>;
  };

  /** The start the run came from with nobody there; null: a person runs it. */
  start(): Promise<RunStart | null>;

  /** The context a step's code runs with: `state` is the step's working copy. */
  context(step: Step, state: RunState, signal: AbortSignal): Promise<StepContext>;
  /** Checks on what goes into a step and what comes out of it (the runtime's guest checks). */
  guard?: {
    before(ctx: StepContext): Promise<void>;
    after(ctx: StepContext, output: StepOutput): Promise<void>;
  };
  /**
   * How a step's error counts. `acted`: the run's state says the step's turn acted already. Throws
   * what is no step's failure (a lost claim).
   */
  failure(err: unknown, stepId: string, acted: boolean): Promise<StepFailure>;
  /** Does a step's or a decision's work, under the host's deadline for `kind` (a step type, or "decision"). */
  within<T>(kind: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** A step or a decision did its work: the host books what it cost, before its move is written. */
  spent?(stepId: string, kind: "step" | "decision"): Promise<void>;

  /** Stops the run's work; nothing more is written once it is aborted. */
  signal: AbortSignal;
  services: StepServices;
  switches: {
    /** Durable runs: deadlines on a person's step, retries and `onFail` (`FlowHost.durable`). */
    durable: boolean;
    /** Acting calls are recorded by their effect ids: a fixed step's visits, an agent turn's calls. */
    effects: boolean;
    /** How often a run that waits for a person looks whether they acted. */
    lookAgainMs: number;
  };
}
