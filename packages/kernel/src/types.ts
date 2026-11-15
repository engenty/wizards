/** One field of an answer: the notation is the definition's, the kernel reads `id` and `required`. */
export type Field = { id: string; kind: string; required?: boolean; [key: string]: unknown };

/** The file: what a wizard needs and may reach, and its map. Nothing about a step is in it. */
export type WizardFile = {
  version?: "0.3.0";
  title: string;
  description?: string;
  avatar?: string;
  lang?: string;
  /** What the wizard needs from where it runs. An ask that names anything else fails. */
  requires?: {
    /** The model classes an agent ask may name. */
    models?: string[];
    /** Tools that are not a connection's: the sandbox, the browser, a plugin's, the wizard's own. */
    tools?: string[];
    /** Roles beyond `user` and `operator`: an id and a title. */
    roles?: Record<string, string>;
    /** The hosts the HTTP tool may reach. */
    hosts?: string[];
  };
  /**
   * Each connection by its kind, the actions the wizard uses, and for each whether it is allowed
   * or asks the user first. Whose account it is, is bound where the wizard is installed.
   */
  connections?: Record<string, Record<string, "allow" | "ask">>;
  input?: { fields: Field[] };
  /** A finished run's output: a name, and where it is read from as `<step>.<path>`. */
  output?: Record<string, string>;
  start: string;
  /** The ways of each step. The first is taken when the step names none. `"end"` ends the run. */
  edges: Record<string, string[]>;
  /** How often a step may be reached in one run. */
  limits?: Record<string, number>;
};

/**
 * A wizard as the kernel takes it: the file, and each step's function by its id. `evals` holds
 * the evals by what they judge, a step's id or `end`, then by name.
 */
export type Wizard = {
  file: WizardFile;
  /** A step is its function, or its compiled script where it runs in QuickJS. */
  steps: Record<string, Step<any, any> | string>;
  evals?: Record<string, Record<string, Eval<any> | string>>;
};

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
  /** On the row that asks the user's leave for an action: the row of that action. */
  approves?: number;
  /** On a row that belongs to another ask, what an agent did in its turn: that ask's row. */
  parent?: number;
  /** Set where the one who answers said the action needs the user's leave. */
  asksLeave?: boolean;
  /** How often answering it was tried. */
  tries?: number;
};

/** A step that returned: what it left behind and the way it went. */
export type LeftRow = { n: number; step: string; left: true; value?: unknown; to: string };

export type Row = AskRow | LeftRow;

/** What an eval said of one step that returned, or of the finished run. */
export type Score = {
  /** `<step>/<name>`, or `end/<name>`. */
  eval: string;
  /** The row it judged: the one a step left with, or the run's last. */
  row: number;
  score?: number;
  why?: string;
  /** Set where the eval could not judge. */
  error?: string;
  /** What the eval asked a model, with the answers. */
  asks?: AskRow[];
};

export type Run = {
  id: string;
  wizard: string;
  input: Record<string, unknown>;
  startedAt: number;
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  /** The step the run stands in. Null once it ended. */
  cursor: string | null;
  /** Where the rows of the current step begin. Null between two steps. */
  open: number | null;
  rows: Row[];
  wakeAt?: number;
  output?: Record<string, unknown>;
  error?: string;
  scores?: Score[];
  /** What the run may reach, made from the file when it started. */
  grant?: import("./grant.js").Grant;
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
  /** `why`: the way in a person's words, for the map the studio draws. Nothing reads it in a run. */
) => Promise<{ value?: unknown; to?: To; why?: string } | void>;

/**
 * The one interface of an eval file. It is a step that judges and never routes: it sees the run
 * as it stood when the step it judges returned, may ask what answers at once, and gives a score
 * from 0 to 1.
 */
export type Eval<Input = Record<string, unknown>> = (
  run: RunView<Input>,
  ask: Ask,
) => Promise<{ score: number; why?: string }>;

/** Where runs are kept. `save` refuses a run someone else moved in the meantime. */
export interface Store {
  load(id: string): Promise<Run | undefined>;
  save(run: Run): Promise<void>;
}

/**
 * Answers an ask at once: a model, a tool, a renderer. Asks without one wait for `answer`.
 * `note` keeps a row under the ask, for what was done on the way. A battery that throws
 * `NeedsLeave` is called again once the user has allowed the action.
 */
export type Battery = (
  row: AskRow,
  run: Run,
  more: { note(row: Spec & { answer?: unknown }): void },
) => Promise<unknown>;

/** Runs a step or an eval once from its top. The kernel's host chooses which one is used. */
export type TurnFn = (
  source: Step<any, any> | Eval<any> | string,
  seen: Omit<RunView, "count"> & { counts: Record<string, number> },
  replay: Replay,
  patience?: number,
) => Promise<Turn>;

/** One run of a step's code from its top. */
export type Turn = {
  asks: Spec[];
  end?: { done: { value?: unknown; to?: string } } | { error: string };
};

export type Replay = ({ answer: unknown } | { error: string } | null)[];
