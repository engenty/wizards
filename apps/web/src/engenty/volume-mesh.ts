// Closed isosurfaces of 3D Gaussian metaballs. Marching tetrahedra shares the
// same scalar field for the body, hair roots and surface normals on every side.
import type { FurUniforms } from "./fur-renderer";

type Point = [number, number, number];
export interface BodyMesh {
  area: number;
  vertices: Float32Array;
}
const cache = new Map<string, BodyMesh>();
const TETRAHEDRA = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
];

export function bodyMeshKey(u: FurUniforms): string {
  return `${u.blobs.join(",")}:${u.falloff}:${u.inflate}`;
}

function sample(p: Point, u: FurUniforms): { value: number; normal: Point } {
  let value = 0;
  const n: Point = [0, 0, 0];
  for (let i = 0; i < u.blobs.length; i += 4) {
    const rx = u.blobs[i + 2],
      ry = u.blobs[i + 3];
    if (rx <= 0 || ry <= 0) {
      continue;
    }
    const rz = (rx * u.inflate) / 30;
    const x = p[0] - u.blobs[i],
      y = p[1] - u.blobs[i + 1],
      z = p[2];
    const weight = Math.exp(
      -u.falloff *
        ((x * x) / (rx * rx) + (y * y) / (ry * ry) + (z * z) / (rz * rz))
    );
    value += weight;
    n[0] += (weight * x) / (rx * rx);
    n[1] += (weight * y) / (ry * ry);
    n[2] += (weight * z) / (rz * rz);
  }
  const len = Math.hypot(...n) || 1;
  return { value, normal: [n[0] / len, n[1] / len, n[2] / len] };
}

export function bodyMesh(u: FurUniforms): BodyMesh {
  const key = bodyMeshKey(u),
    existing = cache.get(key);
  if (existing) {
    return existing;
  }
  const min: Point = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ],
    max: Point = [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
  for (let i = 0; i < u.blobs.length; i += 4) {
    if (u.blobs[i + 2] <= 0) {
      continue;
    }
    const centre = [u.blobs[i], u.blobs[i + 1], 0];
    const radius = [
      u.blobs[i + 2],
      u.blobs[i + 3],
      (u.blobs[i + 2] * u.inflate) / 30,
    ];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], centre[axis] - radius[axis] * 1.5);
      max[axis] = Math.max(max[axis], centre[axis] + radius[axis] * 1.5);
    }
  }
  // A quarter of the smallest blob's narrower radius, so a thin tip (the drop's, the flame's)
  // gets enough cells to stay round; 2.7 is plenty for the big bodies.
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < u.blobs.length; i += 4) {
    if (u.blobs[i + 2] > 0) {
      smallest = Math.min(smallest, u.blobs[i + 2], u.blobs[i + 3]);
    }
  }
  const step = Math.min(2.7, Math.max(1.4, smallest / 4));
  const [nx, ny, nz] = max.map(
    (value, i) => Math.ceil((value - min[i]) / step) + 1
  );
  const points: Point[] = [];
  const values: number[] = [];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const p: Point = [
          min[0] + x * step,
          min[1] + y * step,
          min[2] + z * step,
        ];
        points.push(p);
        values.push(sample(p, u).value);
      }
    }
  }
  const iso = Math.exp(-u.falloff),
    vertices: number[] = [];
  let area = 0;
  const crossing = (a: number, b: number): Point => {
    const t = (iso - values[a]) / (values[b] - values[a]);
    return [0, 1, 2].map(
      (axis) => points[a][axis] + (points[b][axis] - points[a][axis]) * t
    ) as Point;
  };
  const triangle = (a: Point, b: Point, c: Point) => {
    const ab = b.map((v, i) => v - a[i]),
      ac = c.map((v, i) => v - a[i]);
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const size = Math.hypot(...cross) * 0.5;
    if (size < 1e-9) {
      return;
    }
    const normal = sample(a, u).normal;
    const ordered =
      cross.reduce((v, n, i) => v + n * normal[i], 0) < 0
        ? [a, c, b]
        : [a, b, c];
    for (const point of ordered) {
      vertices.push(...point, ...sample(point, u).normal);
    }
    area += size;
  };
  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const base = x + nx * (y + ny * z),
          layer = nx * ny;
        const cube = [
          base,
          base + 1,
          base + nx + 1,
          base + nx,
          base + layer,
          base + layer + 1,
          base + layer + nx + 1,
          base + layer + nx,
        ];
        if (
          cube.every((i) => values[i] < iso) ||
          cube.every((i) => values[i] >= iso)
        ) {
          continue;
        }
        for (const tetra of TETRAHEDRA) {
          const inside = tetra
            .map((i) => cube[i])
            .filter((i) => values[i] >= iso);
          const outside = tetra
            .map((i) => cube[i])
            .filter((i) => values[i] < iso);
          if (inside.length === 1) {
            triangle(
              ...(outside.map((i) => crossing(inside[0], i)) as [
                Point,
                Point,
                Point,
              ])
            );
          } else if (inside.length === 3) {
            triangle(
              ...(inside.map((i) => crossing(outside[0], i)) as [
                Point,
                Point,
                Point,
              ])
            );
          } else if (inside.length === 2) {
            const ac = crossing(inside[0], outside[0]),
              ad = crossing(inside[0], outside[1]);
            const bc = crossing(inside[1], outside[0]),
              bd = crossing(inside[1], outside[1]);
            triangle(ac, ad, bc);
            triangle(ad, bd, bc);
          }
        }
      }
    }
  }
  const mesh = { vertices: new Float32Array(vertices), area };
  cache.set(key, mesh);
  if (cache.size > 24) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
    }
  }
  return mesh;
}
