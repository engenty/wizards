// Flat SVG icon helmet. The volumetric helmet lives in goose-helmet-geometry.ts; this one is
// drawn from the same placement, so small and large engenties wear the same helmet.
import { useId } from "react";
import type { EngentyKind } from "./colors";
import { GOOSE_HELMET_FIT, isGooseHelmetKind } from "./goose-helmet-fit";

const RED = "#d10d18";
const RED_DARK = "#8f0710";
const BLUE = "#1f3fd9";
const WHITE = "#f7f2e6";
const SEAL = "#11131a";
const SMOKE = "rgba(14, 22, 52, 0.58)";
const CHROME = "#c9ced4";

/** The 3D shell's half-width in head units (scripts/goose-helmet-model.py, RX). */
const SHELL_RADIUS = 1.16;

export function EngentyHelmet({ kind }: { kind: EngentyKind }) {
  const clip = useId();
  if (!isGooseHelmetKind(kind)) {
    return null;
  }
  const fit = GOOSE_HELMET_FIT[kind].jelly;
  const r = SHELL_RADIUS * fit.scale;
  // Unit points: the helmet's centre is 0, its radius 1, y down.
  const p = (u: number, v: number) => `${fit.x + u * r} ${fit.y + v * r * fit.height}`;
  const shell = `M ${p(-0.67, 0.74)} A ${r} ${r * fit.height} 0 1 1 ${p(0.67, 0.74)} L ${p(0.54, 0.74)} L ${p(0.78, 0.34)} L ${p(0.87, -0.19)} Q ${p(0, -0.72)} ${p(-0.87, -0.19)} L ${p(-0.78, 0.34)} L ${p(-0.54, 0.74)} Z`;
  const visor = `M ${p(-0.86, -0.19)} Q ${p(0, -0.72)} ${p(0.86, -0.19)} L ${p(0.88, 0.22)} Q ${p(0.88, 0.34)} ${p(0.76, 0.34)} L ${p(0.2, 0.34)} Q ${p(0.06, 0.16)} ${p(0, 0.16)} Q ${p(-0.06, 0.16)} ${p(-0.2, 0.34)} L ${p(-0.76, 0.34)} Q ${p(-0.88, 0.34)} ${p(-0.88, 0.22)} Z`;
  const brow = `M ${p(-0.87, -0.19)} Q ${p(0, -0.72)} ${p(0.87, -0.19)}`;
  // One "N" each side of the rail, then a stripe down the side.
  const zigzag = (side: number) =>
    `M ${p(side * 0.18, -0.48)} L ${p(side * 0.22, -0.92)} L ${p(side * 0.48, -0.5)} L ${p(side * 0.56, -0.86)} M ${p(side * 0.72, -0.5)} L ${p(side * 0.86, -0.7)}`;
  return (
    <g className="e-helmet">
      <defs>
        <clipPath id={clip}>
          <path d={shell} />
        </clipPath>
      </defs>
      <path d={shell} fill={RED} stroke={RED_DARK} strokeWidth={0.8} />
      <g clipPath={`url(#${clip})`} fill="none" strokeLinejoin="miter">
        {[-1, 1].map((side) => (
          <g key={side}>
            <path d={zigzag(side)} stroke={WHITE} strokeWidth={r * 0.13} />
            <path d={zigzag(side)} stroke={BLUE} strokeWidth={r * 0.075} />
          </g>
        ))}
      </g>
      <path d={visor} fill={SMOKE} />
      <path
        d={`M ${p(-0.62, -0.26)} Q ${p(-0.4, -0.42)} ${p(-0.12, -0.44)}`}
        fill="none"
        opacity={0.55}
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth={r * 0.05}
      />
      <path d={brow} fill="none" stroke={SEAL} strokeLinecap="round" strokeWidth={r * 0.07} />
      <rect
        fill={RED}
        height={r * 0.5}
        rx={r * 0.03}
        stroke={RED_DARK}
        strokeWidth={0.6}
        width={r * 0.14}
        x={fit.x - r * 0.07}
        y={fit.y - r * fit.height * 0.95}
      />
      <rect
        fill={RED}
        height={r * 0.12}
        rx={r * 0.03}
        stroke={RED_DARK}
        strokeWidth={0.6}
        width={r * 0.24}
        x={fit.x - r * 0.12}
        y={fit.y - r * fit.height * 1.06}
      />
      {[-1, 1].map((side) => (
        <g key={side}>
          <circle cx={fit.x + side * r * 0.96} cy={fit.y + r * 0.22} fill={RED} r={r * 0.17} stroke={RED_DARK} strokeWidth={0.6} />
          <circle cx={fit.x + side * r * 0.98} cy={fit.y + r * 0.22} fill={CHROME} r={r * 0.08} />
          <circle cx={fit.x + side * r * 0.74} cy={fit.y + r * 0.58} fill={RED} r={r * 0.1} stroke={RED_DARK} strokeWidth={0.5} />
          <circle cx={fit.x + side * r * 0.75} cy={fit.y + r * 0.58} fill={CHROME} r={r * 0.045} />
        </g>
      ))}
    </g>
  );
}
