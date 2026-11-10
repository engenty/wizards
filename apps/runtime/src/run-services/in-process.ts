import type { AssetRef } from "@engenty/wizards-shared/run";
import type { schema } from "../db/client.js";
import type { RunResources } from "../engine/resources.js";
import type { StepContext } from "../engine/types.js";
import type { SaveAssetInput } from "../files/storage.js";
import type { CallMeta } from "../models.js";
import type { StoreScope } from "../store/index.js";

export type SpaceRow = typeof schema.space.$inferSelect;
export type SpaceFileRow = typeof schema.spaceFile.$inferSelect;

/**
 * A step's context as the run's services keep it inside the runtime: the step context and the
 * rows and functions of this process that the runtime's own code (tools, media, widgets, share
 * jobs) works with. Step code sees only the step context.
 */
export interface InProcessContext extends StepContext {
  /** What the wizard keeps for the person running it. */
  store: StoreScope;
  /** The wizard's space: its setup (connections, skills, plugins, brand) is what the run uses. */
  space: SpaceRow;
  /** The space's logos, assets and documents that are ready to use. */
  spaceFiles: SpaceFileRow[];
  resources: RunResources;
  /** Run and step every model call of this step is made for. */
  call: CallMeta;
  /** Adds provider cost to the run where the runtime resolves models itself; the gateway books the rest. */
  chargeUsd(usd: number): Promise<void>;
  saveAsset(input: Omit<SaveAssetInput, "runId">): Promise<AssetRef>;
}
