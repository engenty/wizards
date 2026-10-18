// SPDX-License-Identifier: CC-BY-4.0
// Flat SVG Halloween costumes. Drawn from the same placement (costume-fit.ts) as the
// volumetric ones in costume-mesh.ts, so small and large engenties wear the same costume.
import { useId } from "react";
import type { EngentyKind } from "./colors";
import { COSTUME_FIT, type EngentyCostume } from "./costume-fit";
import { WING_OUTLINE, WING_TIPS, WING_WRIST } from "./costume-mesh";

const FELT = "#1d1428";
const FELT_EDGE = "#3a2650";
const BAND = "#f7740e";
const GOLD = "#f2b84b";
const WING = "#1f1729";
const BONE = "#55466a";
const PUMPKIN = "#f7740e";
const PUMPKIN_DARK = "#c24d08";
const CANDLE = "#ffd84d";
const STEM = "#56601f";

type Point = [number, number];
const pts = (points: Point[]) => points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L ");

function WitchHat({ kind }: { kind: EngentyKind }) {
  const clip = useId();
  const fit = COSTUME_FIT[kind];
  const brim = 1.15 * fit.head;
  const height = 1.15 * brim;
  const tip: Point = [0.44 * brim, -height];
  const cone = `M ${-0.5 * brim} 0 C ${-0.44 * brim} ${-0.45 * height} ${-0.1 * brim} ${-0.82 * height} ${tip[0]} ${tip[1]} C ${0.08 * brim} ${-0.8 * height} ${0.36 * brim} ${-0.45 * height} ${0.5 * brim} 0 A ${0.5 * brim} ${0.1 * brim} 0 0 1 ${-0.5 * brim} 0 Z`;
  return (
    <g
      className="e-costume"
      transform={`translate(${fit.crown[0]} ${fit.crown[1] + 0.3 * fit.head}) rotate(${fit.tilt})`}
    >
      <defs>
        <clipPath id={clip}>
          <path d={cone} />
        </clipPath>
      </defs>
      <ellipse cx={0} cy={0} fill={FELT} rx={brim} ry={0.22 * brim} stroke={FELT_EDGE} strokeWidth={0.8} />
      <path d={cone} fill={FELT} stroke={FELT_EDGE} strokeWidth={0.8} />
      <g clipPath={`url(#${clip})`}>
        <rect fill={BAND} height={0.16 * height} width={brim * 1.2} x={-0.6 * brim} y={-0.2 * height} />
      </g>
      <rect
        fill="none"
        height={0.14 * height}
        rx={0.02 * brim}
        stroke={GOLD}
        strokeWidth={0.05 * brim}
        width={0.22 * brim}
        x={-0.09 * brim}
        y={-0.19 * height}
      />
      <path
        d={`M ${-0.3 * brim} ${-0.3 * height} Q ${-0.22 * brim} ${-0.6 * height} ${0.05 * brim} ${-0.85 * height}`}
        fill="none"
        opacity={0.35}
        stroke="#8b6bb0"
        strokeLinecap="round"
        strokeWidth={0.04 * brim}
      />
    </g>
  );
}

function DevilHorns({ kind }: { kind: EngentyKind }) {
  const id = useId();
  const fit = COSTUME_FIT[kind];
  const head: Point = [fit.crown[0], fit.crown[1] + fit.head];
  const length = Math.max(0.95 * fit.head, 16);
  const root = Math.max(0.3 * fit.head, 5);
  return (
    <g className="e-costume">
      {[-1, 1].map((side) => {
        const a = side * 0.72;
        const out = [Math.sin(a), -Math.cos(a)] as const;
        const p0: Point = [head[0] + out[0] * fit.head * 0.82, head[1] + out[1] * fit.head * 0.82];
        const p1: Point = [p0[0] + out[0] * length * 0.6, p0[1] + out[1] * length * 0.6];
        const p2: Point = [
          p0[0] + (out[0] * 0.35 - side * 0.25) * length,
          p0[1] + (out[1] * 0.35 - 0.8) * length,
        ];
        const at = (t: number): Point => {
          const m = 1 - t;
          return [
            m * m * p0[0] + 2 * m * t * p1[0] + t * t * p2[0],
            m * m * p0[1] + 2 * m * t * p1[1] + t * t * p2[1],
          ];
        };
        const left: Point[] = [];
        const right: Point[] = [];
        for (let i = 0; i <= 16; i++) {
          const t = i / 16;
          const [x, y] = at(t);
          const [nx, ny] = at(Math.min(1, t + 0.01));
          const [px, py] = at(Math.max(0, t - 0.01));
          const len = Math.hypot(nx - px, ny - py) || 1;
          const r = root * (1 - t) ** 0.8;
          left.push([x - ((ny - py) / len) * r, y + ((nx - px) / len) * r]);
          right.push([x + ((ny - py) / len) * r, y - ((nx - px) / len) * r]);
        }
        const gradient = `${id}${side}`;
        return (
          <g key={side}>
            <defs>
              <linearGradient gradientUnits="userSpaceOnUse" id={gradient} x1={p0[0]} x2={p2[0]} y1={p0[1]} y2={p2[1]}>
                <stop offset="0.2" stopColor="#d4141a" />
                <stop offset="1" stopColor="#4a0408" />
              </linearGradient>
            </defs>
            <path d={`M ${pts([...left, ...right.reverse()])} Z`} fill={`url(#${gradient})`} stroke="#5c0509" strokeWidth={0.6} />
          </g>
        );
      })}
    </g>
  );
}

function BatWings({ kind }: { kind: EngentyKind }) {
  const fit = COSTUME_FIT[kind];
  const { span } = fit.wings;
  // Swept back, so a wing shows a little narrower than it is.
  const along = 0.88;
  return (
    <g className="e-costume">
      {[-1, 1].map((side) => {
        const root = side < 0 ? fit.wings.left : fit.wings.right;
        const p = ([a, b]: Point): Point => [side * a * span * along, -b * span];
        return (
          <g key={side} transform={`translate(${root[0]} ${root[1]})`}>
            <g>
              <animateTransform
                attributeName="transform"
                dur="1.4s"
                repeatCount="indefinite"
                type="scale"
                values="1 1;0.78 0.94;1 1"
              />
              <path d={`M ${pts(WING_OUTLINE.map(p))} Z`} fill={WING} stroke={BONE} strokeLinejoin="round" strokeWidth={0.7} />
              <path
                d={[[0, 0.06] as Point, [0.22, 0.34] as Point, WING_WRIST]
                  .map(p)
                  .map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`)
                  .concat(WING_TIPS.map((tip) => `M ${p(WING_WRIST).join(" ")} L ${p(tip).join(" ")}`))
                  .join(" ")}
                fill="none"
                stroke={BONE}
                strokeLinecap="round"
                strokeWidth={1.1}
              />
            </g>
          </g>
        );
      })}
    </g>
  );
}

function Lantern({ kind }: { kind: EngentyKind }) {
  const [x, y, r] = COSTUME_FIT[kind].lantern;
  // The face sits a little toward the body beside it.
  const f = (u: number, v: number): Point => [0.12 * r + u * r, -v * r];
  const eye = (side: number) => pts([f(side * 0.18, 0.1), f(side * 0.52, 0.08), f(side * 0.34, 0.4)]);
  const mouth = pts([
    f(-0.58, -0.12),
    f(-0.3, -0.26),
    f(-0.24, -0.16),
    f(-0.16, -0.28),
    f(0.16, -0.28),
    f(0.24, -0.16),
    f(0.3, -0.26),
    f(0.58, -0.12),
    f(0.36, -0.44),
    f(0.06, -0.5),
    f(0, -0.4),
    f(-0.06, -0.5),
    f(-0.36, -0.44),
  ]);
  return (
    <g className="e-costume" transform={`translate(${x} ${y})`}>
      <g>
        <animateTransform
          attributeName="transform"
          dur="3.4s"
          repeatCount="indefinite"
          type="translate"
          values="0 1;0 -2;0 1"
        />
        <path
          d={`M ${-0.04 * r} ${-0.7 * r} Q ${0.02 * r} ${-1.05 * r} ${0.24 * r} ${-1.1 * r} L ${0.26 * r} ${-0.98 * r} Q ${0.14 * r} ${-0.92 * r} ${0.12 * r} ${-0.7 * r} Z`}
          fill={STEM}
        />
        <ellipse cx={-0.42 * r} cy={0} fill={PUMPKIN_DARK} rx={0.58 * r} ry={0.8 * r} />
        <ellipse cx={0.42 * r} cy={0} fill={PUMPKIN_DARK} rx={0.58 * r} ry={0.8 * r} />
        <ellipse cx={0} cy={0} fill={PUMPKIN} rx={0.6 * r} ry={0.84 * r} />
        <ellipse cx={-0.5 * r} cy={0} fill={PUMPKIN} opacity={0.75} rx={0.38 * r} ry={0.74 * r} />
        <ellipse cx={0.5 * r} cy={0} fill={PUMPKIN} opacity={0.75} rx={0.38 * r} ry={0.74 * r} />
        <g fill={CANDLE}>
          <path d={`M ${eye(-1)} Z`} />
          <path d={`M ${eye(1)} Z`} />
          <path d={`M ${pts([f(-0.07, -0.06), f(0.07, -0.06), f(0, 0.06)])} Z`} />
          <path d={`M ${mouth} Z`} />
          <animate attributeName="opacity" dur="0.9s" repeatCount="indefinite" values="1;0.82;0.95;1" />
        </g>
      </g>
    </g>
  );
}

/** The costume's parts behind the body (`back`) or over it (`front`). */
export function EngentyCostumeLayer({
  costume,
  kind,
  layer,
}: {
  costume: EngentyCostume;
  kind: EngentyKind;
  layer: "back" | "front";
}) {
  if (costume === "bat") return layer === "back" ? <BatWings kind={kind} /> : null;
  if (layer === "back") return null;
  if (costume === "witch") return <WitchHat kind={kind} />;
  if (costume === "devil") return <DevilHorns kind={kind} />;
  return <Lantern kind={kind} />;
}
