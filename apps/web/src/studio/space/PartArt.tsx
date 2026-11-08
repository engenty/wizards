import type { ComponentType, ReactNode } from "react";
import { type EngentyKind, ENGENTY_FILL as F } from "../../engenty/colors";
import { Engenty } from "../../engenty/engenty";
import { cn } from "../../ui";

/**
 * The picture at the top of a part's card in Ressourcen › Übersicht: an engenty with what the part
 * holds, drawn flat in the engenties' own colours. The figures are the studio's own (`Engenty`),
 * never drawn here. A part without a scene of its own (a plugin's) shows its icon, large.
 */

/** Each part's ground. */
const GROUND: Record<string, string> = {
  info: "bg-cobalt-tint",
  brand: "bg-violet-500/10",
  knowledge: "bg-moss-tint",
  data: "bg-amber-tint",
  page: "bg-ember-tint",
};

const PAPER = "var(--color-paper)";
const LINE = "var(--color-paper-3)";
const SHADOW = { fill: "#000", opacity: 0.12 };

/** An engenty standing in the scene: its foot at (x, y), `size` wide. */
function Figure({
  kind,
  x,
  y,
  size = 92,
}: {
  kind: EngentyKind;
  x: number;
  y: number;
  size?: number;
}) {
  // The figure's own frame is 120 wide with its foot near 106: placed so the foot meets `y`.
  const s = size / 120;
  return (
    <g transform={`translate(${x - 60 * s} ${y - 106 * s})`}>
      <Engenty kind={kind} size={size} />
    </g>
  );
}

function Floor({ cx, cy, rx }: { cx: number; cy: number; rx: number }) {
  return <ellipse cx={cx} cy={cy} rx={rx} ry={5} {...SHADOW} />;
}

/** Info: who is behind the wizards. A big name badge on its lanyard, the round one beside it. */
function InfoScene() {
  return (
    <>
      <Floor cx={196} cy={142} rx={48} />
      <path
        d="M180 30 L196 54 L212 30"
        fill="none"
        stroke={F.ember}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <g transform="rotate(6 196 96)">
        <rect x={150} y={50} width={92} height={92} rx={14} fill={PAPER} />
        <rect x={150} y={50} width={92} height={24} rx={14} fill={F.ember} />
        <rect x={150} y={62} width={92} height={12} fill={F.ember} />
        <rect x={188} y={44} width={16} height={12} rx={4} fill={F.slate} />
        <circle cx={174} cy={98} r={14} fill={F.amber} />
        <circle cx={176} cy={96} r={4.5} fill="#fff" />
        <circle cx={177} cy={96} r={2.2} fill="#1d1b19" />
        <rect x={196} y={88} width={34} height={8} rx={4} fill={F.slate} />
        <rect x={196} y={102} width={24} height={6} rx={3} fill={LINE} />
        <rect x={162} y={122} width={68} height={6} rx={3} fill={LINE} />
      </g>
      <Figure kind="round" x={98} y={144} size={124} />
    </>
  );
}

/** Brand: how you look. A palette with its paints and a brush, the tower one beside it. */
function BrandScene() {
  return (
    <>
      <Floor cx={200} cy={142} rx={56} />
      <path
        d="M150 98c0-30 26-52 58-52s50 18 50 40c0 14-10 20-22 18-10-2-16 4-14 14 3 14-6 24-24 24-28 0-48-18-48-44z"
        fill={PAPER}
      />
      <circle cx={180} cy={78} r={10} fill={F.rose} />
      <circle cx={208} cy={64} r={10} fill={F.amber} />
      <circle cx={234} cy={76} r={9} fill={F.moss} />
      <circle cx={172} cy={108} r={10} fill={F.cobalt} />
      <circle cx={204} cy={124} r={6} fill="var(--color-paper-2)" />
      <g transform="rotate(-38 236 112)">
        <rect x={230} y={64} width={12} height={62} rx={6} fill={F.slate} />
        <rect x={229} y={58} width={14} height={12} rx={3} fill="#c9c3bb" />
        <path d="M230 58c0-14 6-22 6-22s6 8 6 22z" fill={F.violet} />
      </g>
      <Figure kind="tower" x={100} y={144} size={124} />
    </>
  );
}

/** Knowledge: what the AI looks things up in. The dome one on a stack of books, one open above. */
function KnowledgeScene() {
  const book = (y: number, w: number, color: string, shift = 0) => (
    <g>
      <rect x={128 + shift} y={y} width={w} height={20} rx={4} fill={color} />
      <rect
        x={128 + shift + w - 18}
        y={y + 4}
        width={14}
        height={12}
        rx={2}
        fill={PAPER}
        opacity={0.9}
      />
    </g>
  );
  return (
    <>
      <Floor cx={190} cy={142} rx={68} />
      {book(120, 124, F.cobalt)}
      {book(100, 112, F.rose, 8)}
      {book(80, 118, F.amber, 2)}
      <Figure kind="dome" x={188} y={84} size={100} />
      <g transform="rotate(-8 82 66)">
        <path d="M50 62c12-8 24-8 32 0v34c-8-8-20-8-32 0z" fill={PAPER} />
        <path d="M114 62c-12-8-24-8-32 0v34c8-8 20-8 32 0z" fill={PAPER} />
        <path d="M82 62v34" stroke={LINE} strokeWidth={2} />
        <rect x={56} y={70} width={18} height={4} rx={2} fill={LINE} />
        <rect x={56} y={78} width={14} height={4} rx={2} fill={LINE} />
        <rect x={90} y={70} width={18} height={4} rx={2} fill={LINE} />
        <rect x={90} y={78} width={12} height={4} rx={2} fill={LINE} />
      </g>
      <circle cx={46} cy={40} r={4} fill={F.moss} opacity={0.6} />
      <circle cx={120} cy={34} r={3} fill={F.amber} opacity={0.7} />
    </>
  );
}

/** Memory: what the wizards keep. A card box filling up, the bean one dropping a card in. */
function DataScene() {
  return (
    <>
      <Floor cx={200} cy={142} rx={58} />
      <rect
        x={158}
        y={50}
        width={52}
        height={40}
        rx={6}
        fill={PAPER}
        transform="rotate(-8 184 70)"
      />
      <rect
        x={176}
        y={44}
        width={52}
        height={44}
        rx={6}
        fill={PAPER}
        transform="rotate(6 202 66)"
      />
      <rect
        x={168}
        y={56}
        width={22}
        height={6}
        rx={3}
        fill={F.teal}
        transform="rotate(-8 184 70)"
      />
      <rect
        x={186}
        y={52}
        width={26}
        height={6}
        rx={3}
        fill={F.violet}
        transform="rotate(6 202 66)"
      />
      <rect x={146} y={74} width={108} height={68} rx={12} fill={F.amber} />
      <rect x={146} y={74} width={108} height={14} rx={7} fill="#000" opacity={0.08} />
      <rect x={184} y={104} width={32} height={10} rx={5} fill="#000" opacity={0.14} />
      <g transform="rotate(-14 112 40)">
        <rect x={94} y={26} width={40} height={28} rx={5} fill={PAPER} />
        <rect x={100} y={34} width={22} height={5} rx={2.5} fill={F.ember} />
        <rect x={100} y={43} width={14} height={4} rx={2} fill={LINE} />
      </g>
      <Figure kind="bean" x={90} y={144} size={120} />
    </>
  );
}

/** The public page: a window onto the web, the sprout one in front of it. */
function PageScene() {
  return (
    <>
      <Floor cx={196} cy={142} rx={60} />
      <rect x={136} y={30} width={122} height={106} rx={14} fill={PAPER} />
      <rect x={136} y={30} width={122} height={20} rx={10} fill="var(--color-paper-2)" />
      <circle cx={150} cy={40} r={3.5} fill={F.rose} />
      <circle cx={161} cy={40} r={3.5} fill={F.amber} />
      <circle cx={172} cy={40} r={3.5} fill={F.moss} />
      <rect x={150} y={62} width={56} height={10} rx={5} fill={F.ember} />
      <rect x={150} y={80} width={70} height={6} rx={3} fill={LINE} />
      <rect x={150} y={92} width={48} height={6} rx={3} fill={LINE} />
      <rect x={150} y={108} width={40} height={14} rx={7} fill={F.cobalt} />
      <circle cx={232} cy={102} r={16} fill={F.teal} opacity={0.85} />
      <Figure kind="sprout" x={96} y={144} size={120} />
    </>
  );
}

const SCENE: Record<string, ComponentType> = {
  info: InfoScene,
  brand: BrandScene,
  knowledge: KnowledgeScene,
  data: DataScene,
  page: PageScene,
};

export function PartArt({
  id,
  icon: Icon,
  className,
}: {
  id: string;
  icon: ComponentType<{ className?: string }>;
  className?: string;
}): ReactNode {
  const Scene = SCENE[id];
  return (
    <span
      aria-hidden
      className={cn("relative block h-36 overflow-hidden", GROUND[id] ?? "bg-paper-2", className)}
    >
      {Scene ? (
        <svg
          viewBox="20 10 280 140"
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="xMidYMax meet"
          overflow="visible"
        >
          <Scene />
        </svg>
      ) : (
        <span className="absolute inset-0 grid place-items-center text-ink-3">
          <span className="grid size-16 place-items-center rounded-2xl bg-paper shadow-soft">
            <Icon className="size-8" />
          </span>
        </span>
      )}
    </span>
  );
}
