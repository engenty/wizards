import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { AskInput, RunNote, RunState } from "@engenty/wizards-shared/run";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import type { Role } from "../manage.js";
import { NotedError } from "../model-errors.js";
import type { InProcessServices } from "../run-services/index.js";
import type { AskResult } from "./asks.js";
import type { TemplateScope } from "./template.js";

export type { RunRow } from "./run-store.js";

/**
 * Who a run belongs to, as the broker asks it (broker/rwx.ts): a guest on a shared link (the
 * visitor, else the run itself), or a signed-in person with their role in the organization.
 */
export type RunHolder = { kind: "guest"; id: string } | { kind: "person"; id: string; role: Role };

export interface StepContext {
  runId: string;
  tenantId: string;
  /** Who holds the run; with the wizard, who a step reads as. */
  holder: RunHolder;
  /** A test run from the studio: it writes the wizard's memory into a copy of its own. */
  test: boolean;
  /** The current step's id. */
  stepId: string;
  /** The durable turn this step runs in; none: its tool calls have no lasting id (broker/effect.ts). */
  turn?: string;
  def: WizardDefinition;
  /** The language the viewer reads the wizard in, translated on request; null: its own. */
  lang: string | null;
  /** The workspace the run started with. */
  files: WorkspaceFile[];
  state: RunState;
  scope: TemplateScope;
  /**
   * Where the run's data is (docs/plans/client-portal.md): the client space a run was started
   * in, whose Knowledge reaches through to the parent as the rules allow; else the wizard's space.
   */
  dataSpace: { id: string; name: string };
  signal: AbortSignal;
  /** Tells the person what the step is doing; `asset` is a picture of the run it is about. */
  emit(type: "tool" | "info", message: string | RunNote, asset?: string): Promise<void>;
  /**
   * Asks the person and waits for the answer. `null` when nobody is there to answer (a run an
   * MCP client drives).
   */
  ask(ask: AskInput): Promise<AskResult | null>;
  /** A share job's step: the run is done and the person sends its result on (broker/over.ts). */
  share?: boolean;
  /** Writes `state` to the run's row, for what must outlive this process in the middle of a step. */
  saveState(): Promise<void>;
  /**
   * Everything outside the run, as the run's services (docs/plans/runs-on-their-own.md): the
   * runtime's own functions, called in this process.
   */
  services: InProcessServices;
}

/** A step failure the person can read. */
export class StepError extends NotedError {}

/** A fixed step's connection isn't signed in, or the service turned the sign-in down. */
export class SignInNeeded extends StepError {
  constructor(
    readonly service: string,
    said: RunNote,
  ) {
    super(said);
  }
}
