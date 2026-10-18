// SPDX-License-Identifier: CC-BY-4.0
// The Halloween costumes as procedural meshes in the shared 0..120 form space (y down, z toward
// the camera). No model files: each part is a parametric surface whose normals come from its
// own parametrisation. A vertex is 13 floats: position relative to its origin, normal, origin,
// material, motion (0 worn, ±1 a wing's side, 2 the floating lantern) and a surface uv the
// shader paints with.
import type { EngentyKind } from "./colors";
import { COSTUME_FIT, type EngentyCostume } from "./costume-fit";
import type { EngentyCoat } from "./fur-stage";

type V3 = [number, number, number];

export const COSTUME_FLOATS = 13;

/** Material ids the costume shader paints. */
export const COSTUME_MATERIAL = {
  felt: 0,
  band: 1,
  gold: 2,
  horn: 3,
  wing: 4,
  pumpkin: 5,
  stem: 6,
} as const;

export interface CostumeMesh {
  vertices: Float32Array;
  /** Farthest the costume reaches from the form centre (60, 60), flapping and bobbing included. */
  reach: number;
}

interface Part {
  material: number;
  motion: number;
  origin: V3;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: V3): V3 => scale(a, 1 / (Math.hypot(...a) || 1));
const rotX = (p: V3, a: number): V3 => [
  p[0],
  p[1] * Math.cos(a) - p[2] * Math.sin(a),
  p[1] * Math.sin(a) + p[2] * Math.cos(a),
];
const rotY = (p: V3, a: number): V3 => [
  p[0] * Math.cos(a) + p[2] * Math.sin(a),
  p[1],
  -p[0] * Math.sin(a) + p[2] * Math.cos(a),
];
const rotZ = (p: V3, a: number): V3 => [
  p[0] * Math.cos(a) - p[1] * Math.sin(a),
  p[0] * Math.sin(a) + p[1] * Math.cos(a),
  p[2],
];

class Builder {
  readonly data: number[] = [];
  readonly points: V3[] = [];

  vertex(p: V3, n: V3, part: Part, uv: [number, number]) {
    this.data.push(...p, ...n, ...part.origin, part.material, part.motion, ...uv);
    this.points.push(add(part.origin, p));
  }

  /** A parametric surface over u, v in 0..1; normals by central differences of `f`. */
  surface(
    rows: number,
    cols: number,
    f: (u: number, v: number) => V3,
    part: Part,
    uv: (u: number, v: number) => [number, number] = (u, v) => [u, v]
  ) {
    const e = 1e-3;
    const normal = (u: number, v: number): V3 => {
      // At a pole one derivative vanishes; step inward until the cross product is real.
      for (const shift of [0, 0.01, 0.03]) {
        const uu = Math.min(1 - e, Math.max(e, u + (u > 0.5 ? -shift : shift)));
        const vv = Math.min(1 - e, Math.max(e, v));
        const du = sub(f(uu + e, vv), f(uu - e, vv));
        const dv = sub(f(uu, vv + e), f(uu, vv - e));
        const n = cross(du, dv);
        if (Math.hypot(...n) > 1e-9) return normalize(n);
      }
      return [0, 0, 1];
    };
    const grid: { p: V3; n: V3; uv: [number, number] }[][] = [];
    for (let i = 0; i <= rows; i++) {
      const row: { p: V3; n: V3; uv: [number, number] }[] = [];
      for (let j = 0; j <= cols; j++) {
        const u = i / rows;
        const v = j / cols;
        row.push({ p: f(u, v), n: normal(u, v), uv: uv(u, v) });
      }
      grid.push(row);
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const a = grid[i][j];
        const b = grid[i + 1][j];
        const c = grid[i + 1][j + 1];
        const d = grid[i][j + 1];
        for (const q of [a, b, c, a, c, d]) this.vertex(q.p, q.n, part, q.uv);
      }
    }
  }

  /** A tube around a centre curve; `radius` may fall to 0 to close a tip. */
  tube(
    rows: number,
    cols: number,
    centre: (s: number) => V3,
    radius: (s: number) => number,
    part: Part,
    from = 0,
    to = 1
  ) {
    this.surface(
      rows,
      cols,
      (u, v) => {
        const s = from + (to - from) * u;
        const c = centre(s);
        const tangent = normalize(sub(centre(s + 1e-3), centre(s - 1e-3)));
        const side = normalize(cross(tangent, [0, 0, 1]));
        const up = cross(side, tangent);
        const a = v * Math.PI * 2;
        return add(c, scale(add(scale(side, Math.cos(a)), scale(up, Math.sin(a))), radius(s)));
      },
      part,
      (u, v) => [from + (to - from) * u, v]
    );
  }

  /** A flat polygon, fanned from `hub`, drawn in local 2D (a, b) and placed by `place`. */
  fan(outline: [number, number][], hub: [number, number], place: (a: number, b: number) => V3, normal: V3, part: Part) {
    const centre = place(...hub);
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      this.vertex(centre, normal, part, hub);
      this.vertex(place(...a), normal, part, a);
      this.vertex(place(...b), normal, part, b);
    }
  }
}

const quadratic = (a: [number, number], c: [number, number], b: [number, number], steps: number) =>
  Array.from({ length: steps }, (_, i): [number, number] => {
    const t = (i + 1) / steps;
    const m = 1 - t;
    return [m * m * a[0] + 2 * m * t * c[0] + t * t * b[0], m * m * a[1] + 2 * m * t * c[1] + t * t * b[1]];
  });

/** The bat wing's outline in span units, a outward, b up: a leading edge, three scallops. */
export const WING_OUTLINE: [number, number][] = [
  [0, -0.12],
  [0, 0.06],
  [0.22, 0.34],
  [0.5, 0.52],
  [1, 0.64],
  ...quadratic([1, 0.64], [0.8, 0.34], [1.06, 0.12], 6),
  ...quadratic([1.06, 0.12], [0.8, -0.02], [0.84, -0.34], 6),
  ...quadratic([0.84, -0.34], [0.5, -0.1], [0.3, -0.24], 6),
];
/** The wing's wrist and the finger bones from it to each scallop's point. */
export const WING_WRIST: [number, number] = [0.5, 0.52];
export const WING_TIPS: [number, number][] = [
  [1, 0.64],
  [1.06, 0.12],
  [0.84, -0.34],
];

function witchHat(b: Builder, kind: EngentyKind, lift: number) {
  const fit = COSTUME_FIT[kind];
  const brim = 1.15 * (fit.head + lift);
  const base: V3 = [fit.crown[0], fit.crown[1] - lift + 0.3 * fit.head, 0];
  const tilt = (fit.tilt * Math.PI) / 180;
  // Pitched toward the camera, so the brim shows its top and does not read as a line.
  const place = (p: V3): V3 => add(base, rotZ(rotX(p, -0.26), tilt));
  const worn = (material: number): Part => ({ material, motion: 0, origin: [0, 0, 0] });
  const rin = 0.18 * brim;
  const thick = 0.035 * brim;
  b.surface(
    10,
    48,
    (u, v) => {
      const phi = u * Math.PI * 2;
      const theta = v * Math.PI * 2;
      const rho = (rin + brim) / 2 + ((brim - rin) / 2) * Math.cos(phi);
      const edge = (rho - rin) / (brim - rin);
      const wave = 1 + 0.035 * Math.sin(theta * 3 + 0.6);
      return place([
        rho * wave * Math.cos(theta),
        thick * Math.sin(phi) - 0.1 * brim * edge * edge,
        rho * wave * Math.sin(theta),
      ]);
    },
    worn(COSTUME_MATERIAL.felt)
  );
  const cone = 0.5 * brim;
  const height = 1.15 * brim;
  const centre = (s: number): V3 =>
    place([0.42 * brim * Math.max(0, s) ** 2.6 + 0.03 * brim * Math.sin(s * 7), -height * s, -0.2 * brim * s * s]);
  const radius = (s: number) => cone * Math.max(0, 1 - s) ** 1.1 * (1 + 0.035 * Math.sin(s * 15));
  b.tube(28, 24, centre, radius, worn(COSTUME_MATERIAL.felt), -0.04, 1);
  b.tube(4, 24, centre, (s) => radius(s) * 1.07 + 0.01 * brim, worn(COSTUME_MATERIAL.band), 0.03, 0.17);
  // The buckle: a rounded square frame on the band's front.
  const half = 0.12 * brim;
  const front = add(centre(0.1), [0, 0, radius(0.1) * 1.07 + 0.01 * brim]);
  b.surface(
    24,
    8,
    (u, v) => {
      const a = u * Math.PI * 2;
      const shape = (c: number) => Math.sign(c) * Math.abs(c) ** 0.35;
      const ring: V3 = [shape(Math.cos(a)) * half, shape(Math.sin(a)) * half * 0.85, 0];
      const out = normalize([ring[0], ring[1], 0]);
      const t = v * Math.PI * 2;
      const r = 0.028 * brim;
      return add(front, [ring[0] + out[0] * Math.cos(t) * r, ring[1] + out[1] * Math.cos(t) * r, Math.sin(t) * r]);
    },
    worn(COSTUME_MATERIAL.gold)
  );
}

function devilHorns(b: Builder, kind: EngentyKind, fur: number) {
  const fit = COSTUME_FIT[kind];
  const head: V3 = [fit.crown[0], fit.crown[1] + fit.head, 0];
  const length = Math.max(0.95 * fit.head, fur + 16);
  const root = Math.max(0.3 * fit.head, 5);
  for (const side of [-1, 1]) {
    const a = side * 0.72;
    const out = normalize([Math.sin(a), -Math.cos(a), 0.25]);
    const p0 = add(head, scale(out, fit.head * 0.9));
    const p1 = add(p0, scale(out, length * 0.6));
    const p2 = add(p0, scale(add(add(scale(out, 0.35), [0, -0.8, 0]), [-side * 0.25, 0, 0.1]), length));
    const centre = (s: number): V3 => {
      const t = Math.max(0, s);
      const m = 1 - t;
      const curve = add(add(scale(p0, m * m), scale(p1, 2 * m * t)), scale(p2, t * t));
      return s < 0 ? add(curve, scale(out, s * length)) : curve;
    };
    b.tube(
      26,
      18,
      centre,
      (s) => root * Math.max(0, 1 - Math.max(0, s)) ** 0.8 * (1 + 0.045 * Math.sin(Math.max(0, s) * 30)),
      { material: COSTUME_MATERIAL.horn, motion: 0, origin: [0, 0, 0] },
      -0.3,
      1
    );
  }
}

function batWings(b: Builder, kind: EngentyKind) {
  const fit = COSTUME_FIT[kind];
  const span = fit.wings.span;
  for (const side of [-1, 1]) {
    const root = side < 0 ? fit.wings.left : fit.wings.right;
    // Hinged behind the body and swept back, so the body hides the root.
    const origin: V3 = [root[0], root[1], -0.32 * fit.head];
    const place = (a: number, v: number): V3 => rotY([side * a * span, -v * span, 0], side * 0.5);
    b.fan(WING_OUTLINE, [0.32, 0.12], place, rotY([0, 0, 1], side * 0.5), {
      material: COSTUME_MATERIAL.wing,
      motion: side,
      origin,
    });
  }
}

function lantern(b: Builder, kind: EngentyKind) {
  const [x, y, r] = COSTUME_FIT[kind].lantern;
  const part = (material: number): Part => ({ material, motion: 2, origin: [x, y, 0.4 * r] });
  // The face turns a little toward the body beside it.
  const facing = 0.32;
  b.surface(
    28,
    48,
    (u, v) => {
      const phi = (u - 0.5) * Math.PI;
      const theta = (v - 0.5) * Math.PI * 2;
      const rib = 1 - 0.07 * (0.5 + 0.5 * Math.cos(8 * theta)) * Math.max(0, Math.cos(phi)) ** 0.5;
      const dimple = 1 - 0.18 * Math.exp(-(((Math.PI / 2 - Math.abs(phi)) * 3) ** 2));
      return rotY(
        [r * rib * Math.cos(phi) * Math.sin(theta), -0.82 * r * Math.sin(phi) * dimple, r * rib * Math.cos(phi) * Math.cos(theta)],
        facing
      );
    },
    part(COSTUME_MATERIAL.pumpkin),
    (u, v) => [(v - 0.5) * Math.PI * 2, (u - 0.5) * Math.PI]
  );
  b.tube(
    8,
    12,
    (s) => [0.2 * r * s * s, -0.68 * r - 0.4 * r * s, 0],
    (s) => 0.13 * r * (1 - 0.3 * s) * Math.sqrt(Math.max(0, 1 - s ** 10)),
    part(COSTUME_MATERIAL.stem),
    0,
    1
  );
}

const cache = new Map<string, CostumeMesh>();

/** The costume's mesh on one form and coat; `fur` is the coat's hair length. */
export function costumeMesh(kind: EngentyKind, costume: EngentyCostume, coat: EngentyCoat, fur: number): CostumeMesh {
  const key = `${kind}:${costume}:${coat}:${fur}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const b = new Builder();
  const lift = coat === "fur" ? fur * 0.6 : 0;
  let margin = 0;
  if (costume === "witch") witchHat(b, kind, lift);
  else if (costume === "devil") devilHorns(b, kind, coat === "fur" ? fur : 0);
  else if (costume === "bat") {
    batWings(b, kind);
    margin = COSTUME_FIT[kind].wings.span * 0.15;
  } else {
    lantern(b, kind);
    margin = 3;
  }
  let reach = 0;
  for (const p of b.points) reach = Math.max(reach, Math.abs(p[0] - 60), Math.abs(p[1] - 60));
  const mesh = { vertices: new Float32Array(b.data), reach: reach + margin };
  cache.set(key, mesh);
  if (cache.size > 48) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return mesh;
}
