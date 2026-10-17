import type { EngentyKind } from "./colors";
import type { EngentyCoat } from "./fur-stage";

export const GOOSE_HELMET_KINDS = ["round", "dome", "drop"] as const satisfies readonly EngentyKind[];
export type GooseHelmetKind = (typeof GOOSE_HELMET_KINDS)[number];

export function isGooseHelmetKind(kind: EngentyKind): kind is GooseHelmetKind {
  return GOOSE_HELMET_KINDS.some((candidate) => candidate === kind);
}

/**
 * Places the exported helmet (head units, head radius about 1) on each form: `scale` form
 * units per head unit, `x`/`y`/`z` the head centre, and `width`/`height`/`depth` a per-axis
 * stretch. Fur wears a slightly larger helmet than Jelly for its fur.
 */
export interface GooseHelmetPlacement {
  scale: number;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

// The helmet's head centre sits near the eye's height; its scale is 1.1 times the visible head radius.
export const GOOSE_HELMET_FIT: Record<GooseHelmetKind, Record<EngentyCoat, GooseHelmetPlacement>> = {
  round: {
    fur: { scale: 40, x: 60, y: 57, z: 0, width: 1, height: 1, depth: 0.8 },
    jelly: { scale: 38.5, x: 60, y: 57, z: 0, width: 1, height: 1, depth: 0.8 },
  },
  dome: {
    fur: { scale: 35, x: 60, y: 56, z: 0, width: 1, height: 1.12, depth: 0.8 },
    jelly: { scale: 33.5, x: 60, y: 56, z: 0, width: 1, height: 1.12, depth: 0.8 },
  },
  drop: {
    fur: { scale: 31, x: 60, y: 54, z: 0, width: 1, height: 1.3, depth: 0.8 },
    jelly: { scale: 30, x: 60, y: 54, z: 0, width: 1, height: 1.3, depth: 0.8 },
  },
};
