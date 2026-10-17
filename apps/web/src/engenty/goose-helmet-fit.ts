import type { EngentyKind } from "./colors";
import type { FormBlob } from "./forms";
import type { EngentyCoat } from "./fur-stage";

export const GOOSE_HELMET_KINDS = ["round", "dome", "drop"] as const satisfies readonly EngentyKind[];
export type GooseHelmetKind = (typeof GOOSE_HELMET_KINDS)[number];

export function isGooseHelmetKind(kind: EngentyKind): kind is GooseHelmetKind {
  return GOOSE_HELMET_KINDS.some((candidate) => candidate === kind);
}

/**
 * Places the exported helmet (head units, head radius about 1) on each form: `scale` form
 * units per head unit, `x`/`y`/`z` the head centre, and `width`/`height`/`depth` a per-axis
 * stretch. Fur wears a larger helmet than Jelly because its fur halo widens the head.
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

/**
 * Goose under the helmet, as in the character studies: a large eye above the visor's nose
 * notch and, on round, a fuller, slightly squashed body that bulges out under the helmet
 * instead of hiding inside it.
 */
export const GOOSE_FACE: Record<
  GooseHelmetKind,
  { blobs?: FormBlob[]; eye: { x: number; y: number; r: number } }
> = {
  round: {
    blobs: [{ x: 60, y: 64, r: 38, rx: 1.1, ry: 0.92 }],
    eye: { x: 63, y: 50, r: 11 },
  },
  dome: { eye: { x: 61, y: 48, r: 9 } },
  drop: { eye: { x: 61, y: 50, r: 8.5 } },
};

/** Goose's fur, as in the studies: shorter, denser and thicker than an engenty's own. */
export const GOOSE_HAIR = { length: 0.7, density: 1.35, thick: 1.4 };

// The helmet's head centre sits near the eye's height; its scale is 1.1 times the visible head radius.
export const GOOSE_HELMET_FIT: Record<GooseHelmetKind, Record<EngentyCoat, GooseHelmetPlacement>> = {
  round: {
    fur: { scale: 46, x: 60, y: 58, z: 0, width: 1, height: 1, depth: 0.92 },
    jelly: { scale: 44, x: 60, y: 55, z: 0, width: 1, height: 1, depth: 0.8 },
  },
  dome: {
    fur: { scale: 38.5, x: 60, y: 52, z: 0, width: 1, height: 1, depth: 0.92 },
    jelly: { scale: 34.5, x: 60, y: 52, z: 0, width: 1, height: 1, depth: 0.8 },
  },
  drop: {
    fur: { scale: 34.5, x: 60, y: 52, z: 0, width: 1, height: 1.3, depth: 0.92 },
    jelly: { scale: 31, x: 60, y: 52, z: 0, width: 1, height: 1.3, depth: 0.8 },
  },
};
