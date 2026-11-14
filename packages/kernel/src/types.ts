/** One field of an answer: the notation is the definition's, the kernel reads `id` and `required`. */
export type Field = { id: string; kind: string; required?: boolean; [key: string]: unknown };

/** The file: what a wizard needs and may reach, and its map. Nothing about a step is in it. */
export type WizardFile = {
  title: string;
  /** Roles beyond `user` and `operator`. */
  roles?: Record<string, string>;
  /** Every tool and connection action a step may name in an ask. */
  tools?: string[];
  input?: { fields: Field[] };
  /** A finished run's output: a name, and where it is read from as `<step>.<path>`. */
  output?: Record<string, string>;
  start: string;
  /** The ways of each step. The first is taken when the step names none. `"end"` ends the run. */
  edges: Record<string, string[]>;
  /** How often a step may be reached in one run. */
  limits?: Record<string, number>;
};

/** A wizard as the kernel takes it: the file, and each step's code compiled for the sandbox. */
export type Wizard = { file: WizardFile; steps: Record<string, string> };

/** What a step passes to `ask`. It is the old step definition as an object. */
export type Spec = {
  type: string;
  role?: string;
  asks?: string;
  tools?: string[];
  fields?: Field[];
  timeout?: string;
  [key: string]: unknown;
};

/** An ask as it was made, and its answer. */
export type AskRow = Spec & {
  n: number;
  step: string;
  role: string;
  state: "waiting" | "done" | "failed";
  answer?: unknown;
  error?: string;
  by?: string;
  due?: number;
};

/** A step that returned: what it left behind and the way it went. */
export type LeftRow = { n: number; step: string; left: true; value?: unknown; to: string };

export type Row = AskRow | LeftRow;

export type Run = {
  id: string;
  wizard: string;
  input: Record<string, unknown>;
  startedAt: number;
  status: "running" | "waiting" | "done" | "failed";
  /** The step the run stands in. Null once it ended. */
  cursor: string | null;
  /** Where the rows of the current step begin. Null between two steps. */
  open: number | null;
  rows: Row[];
  wakeAt?: number;
  output?: Record<string, unknown>;
  error?: string;
  rev: number;
};

/** What a step sees of the run. All of it is worked out from the rows. */
export type RunView<Input = Record<string, unknown>> = {
  input: Input;
  today: string;
  /** The latest value of each step. */
  steps: Record<string, any>;
  /** The step before this one. */
  last?: { step: string; value?: any; to: string };
  /** How often a step was reached, this time included. */
  count(id: string): number;
};

export type Ask = <Answer = any>(spec: Spec) => Promise<Answer>;

/** The one interface of a step file: `export default` a function of this type. */
export type Step<Input = Record<string, unknown>, To extends string = string> = (
  run: RunView<Input>,
  ask: Ask,
) => Promise<{ value?: unknown; to?: To } | void>;

/** Where runs are kept. `save` refuses a run someone else moved in the meantime. */
export interface Store {
  load(id: string): Promise<Run | undefined>;
  save(run: Run): Promise<void>;
}

/** Answers an ask at once: a model, a tool, a renderer. Asks without one wait for `answer`. */
export type Battery = (row: AskRow, run: Run) => Promise<unknown>;

/** One run of a step's code from its top. */
export type Turn = {
  asks: Spec[];
  end?: { done: { value?: unknown; to?: string } } | { error: string };
};

export type Replay = ({ answer: unknown } | { error: string } | null)[];

export interface Sandbox {
  run(
    source: string,
    view: Omit<RunView, "count"> & { counts: Record<string, number> },
    replay: Replay,
    fixed: { now: number; seed: number },
  ): Promise<Turn>;
}
