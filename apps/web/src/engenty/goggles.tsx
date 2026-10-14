// SPDX-License-Identifier: CC-BY-4.0
// Flat SVG icon goggles. Volumetric coat goggles live in coat-goggles.ts.
import type { EngentyKind } from "./colors";
import { ENGENTY_FORMS } from "./forms";

const LEATHER = "oklch(40% 0.07 50)";
const LEATHER_DARK = "oklch(30% 0.06 45)";
const BRASS = "oklch(74% 0.12 80)";
const BRASS_DARK = "oklch(55% 0.1 70)";
const GLASS = "oklch(88% 0.05 220 / 0.32)";

/** Where the body's outline crosses row `y`, from the form's blobs. */
function rowExtent(kind: EngentyKind, y: number): [number, number] {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const blob of ENGENTY_FORMS[kind].blobs) {
    const rx = blob.r * (blob.rx ?? 1);
    const ry = blob.r * (blob.ry ?? 1);
    const dy = (y - blob.y) / ry;
    if (Math.abs(dy) >= 1) {
      continue;
    }
    const half = rx * Math.sqrt(1 - dy * dy);
    left = Math.min(left, blob.x - half);
    right = Math.max(right, blob.x + half);
  }
  return [left, right];
}

interface Geometry {
  band: number;
  left: number;
  lens: number;
  outer: number;
  right: number;
  rim: number;
  x: number;
  y: number;
}

function geometry(kind: EngentyKind): Geometry {
  const { x, y, r } = ENGENTY_FORMS[kind].eye;
  const lens = r * 1.45;
  const rim = r * 0.42;
  const [left, right] = rowExtent(kind, y);
  return {
    band: r * 0.95,
    left,
    lens,
    outer: lens + rim / 2,
    right,
    rim,
    x,
    y,
  };
}

function FlatGoggles({ g }: { g: Geometry }) {
  const strap = (from: number, to: number) =>
    to - from > 1 ? (
      <g>
        <rect
          fill={LEATHER}
          height={g.band}
          rx={g.band * 0.3}
          width={to - from}
          x={from}
          y={g.y - g.band / 2}
        />
        <line
          stroke={LEATHER_DARK}
          strokeDasharray="1.6 1.6"
          strokeWidth={0.6}
          x1={from + 1}
          x2={to - 1}
          y1={g.y}
          y2={g.y}
        />
      </g>
    ) : null;
  return (
    <g className="e-goggles">
      {strap(g.left + 1.5, g.x - g.outer + 0.5)}
      {strap(g.x + g.outer - 0.5, g.right - 1.5)}
      <circle cx={g.x} cy={g.y} fill={GLASS} r={g.lens} />
      <circle
        cx={g.x}
        cy={g.y}
        fill="none"
        r={g.lens}
        stroke={BRASS}
        strokeWidth={g.rim}
      />
      <circle
        cx={g.x}
        cy={g.y}
        fill="none"
        r={g.outer}
        stroke={BRASS_DARK}
        strokeWidth={0.7}
      />
      {[45, 135, 225, 315].map((deg) => (
        <circle
          cx={g.x + Math.cos((deg * Math.PI) / 180) * g.lens}
          cy={g.y + Math.sin((deg * Math.PI) / 180) * g.lens}
          fill={BRASS_DARK}
          key={deg}
          r={0.9}
        />
      ))}
      <path
        d={`M ${g.x - g.lens * 0.62} ${g.y - g.lens * 0.2} A ${g.lens * 0.66} ${g.lens * 0.66} 0 0 1 ${g.x - g.lens * 0.1} ${g.y - g.lens * 0.64}`}
        fill="none"
        opacity={0.75}
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth={1.3}
      />
    </g>
  );
}

export function EngentyGoggles({ kind }: { kind: EngentyKind }) {
  return <FlatGoggles g={geometry(kind)} />;
}
