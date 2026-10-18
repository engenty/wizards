// SPDX-License-Identifier: CC-BY-4.0
import type { EngentyKind } from "./colors";

/** Halloween costumes any engenty can wear, flat or fluffy. */
export const ENGENTY_COSTUMES = ["witch", "devil", "bat", "pumpkin"] as const;
export type EngentyCostume = (typeof ENGENTY_COSTUMES)[number];

/**
 * Where a costume sits on each form, in the shared 0..120 space (y down):
 * `crown` the top of the head the hat and horns sit on, `head` that head's radius, `tilt`
 * the hat's lean in degrees (positive leans right), `wings` the left and right wing roots
 * with the wings' span, and `lantern` the jack-o'-lantern's centre and radius beside the body.
 */
export interface CostumeFit {
  crown: [number, number];
  head: number;
  tilt: number;
  wings: { left: [number, number]; right: [number, number]; span: number };
  lantern: [number, number, number];
}

export const COSTUME_FIT: Record<EngentyKind, CostumeFit> = {
  round: {
    crown: [60, 23],
    head: 36,
    tilt: 8,
    wings: { left: [28, 58], right: [92, 58], span: 40 },
    lantern: [14, 88, 18],
  },
  drop: {
    crown: [60, 17],
    head: 20,
    tilt: 6,
    wings: { left: [34, 66], right: [86, 66], span: 36 },
    lantern: [18, 90, 17],
  },
  dome: {
    crown: [60, 18],
    head: 28,
    tilt: 8,
    wings: { left: [32, 60], right: [88, 60], span: 38 },
    lantern: [14, 92, 17],
  },
  flame: {
    crown: [60, 18],
    head: 15,
    tilt: 5,
    wings: { left: [40, 66], right: [80, 66], span: 32 },
    lantern: [22, 92, 16],
  },
  oval: {
    crown: [60, 34],
    head: 30,
    tilt: 8,
    wings: { left: [22, 60], right: [98, 60], span: 38 },
    lantern: [10, 90, 17],
  },
  bean: {
    crown: [76, 32],
    head: 21,
    tilt: 14,
    wings: { left: [26, 72], right: [94, 52], span: 32 },
    lantern: [10, 92, 16],
  },
  pebble: {
    crown: [60, 52],
    head: 22,
    tilt: 6,
    wings: { left: [20, 70], right: [100, 70], span: 32 },
    lantern: [11, 99, 14],
  },
  sprout: {
    crown: [60, 44],
    head: 24,
    tilt: 6,
    wings: { left: [34, 72], right: [86, 72], span: 34 },
    lantern: [16, 94, 16],
  },
  tower: {
    crown: [60, 22],
    head: 14,
    tilt: 5,
    wings: { left: [44, 60], right: [76, 60], span: 30 },
    lantern: [25, 95, 14],
  },
  wedge: {
    crown: [60, 34],
    head: 14,
    tilt: 5,
    wings: { left: [30, 74], right: [90, 74], span: 32 },
    lantern: [13, 97, 14],
  },
};
