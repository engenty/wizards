import type { WizardDefinition } from "@engenty-wizards/shared/definition";
import type { AskInput, AssetRef, RunNote, RunState } from "@engenty-wizards/shared/run";
import type { WorkspaceFile } from "@engenty-wizards/shared/workspace";
import type { schema } from "../db/client.js";
import type { SaveAssetInput } from "../files/storage.js";
import { NotedError } from "../model-errors.js";
import type { CallMeta } from "../models.js";
import type { StoreScope } from "../store/index.js";
import type { AskResult } from "./asks.js";
import type { RunResources } from "./resources.js";
import type { TemplateScope } from "./template.js";

export type ProjectRow = typeof schema.project.$inferSelect;
export type ProjectFileRow = typeof schema.projectFile.$inferSelect;
export type RunRow = typeof schema.run.$inferSelect;

export interface StepContext {
  runId: string;
  tenantId: string;
  /** A test run from the studio: it writes the wizard's memory into a copy of its own. */
  test: boolean;
  /** The current step's id. */
  stepId: string;
  /** What the wizard keeps for the person running it. */
  store: StoreScope;
  def: WizardDefinition;
  /** The language the viewer reads the wizard in, translated on request; null: its own. */
  lang: string | null;
  /** The workspace the run started with. */
  files: WorkspaceFile[];
  state: RunState;
  scope: TemplateScope;
  project: ProjectRow;
  /** The project's logos, assets and documents that are ready to use. */
  projectFiles: ProjectFileRow[];
  signal: AbortSignal;
  resources: RunResources;
  /** Tells the person what the step is doing; `asset` is a picture of the run it is about. */
  emit(type: "tool" | "info", message: string | RunNote, asset?: string): Promise<void>;
  /**
   * Asks the person and waits for the answer. `null` when nobody is there to answer (a run an
   * MCP client drives).
   */
  ask(ask: AskInput): Promise<AskResult | null>;
  /** Run and step every model call of this step is made for. */
  call: CallMeta;
  /** Adds provider cost to the run where the runtime resolves models itself; the gateway books the rest. */
  chargeUsd(usd: number): Promise<void>;
  saveAsset(input: Omit<SaveAssetInput, "runId">): Promise<AssetRef>;
}

/** A step failure the person can read. */
export class StepError extends NotedError {}
