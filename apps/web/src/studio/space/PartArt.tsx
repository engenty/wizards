import type { ComponentType } from "react";
import { cn } from "../../ui";

/**
 * The picture at the top of a part's card in Ressourcen › Übersicht: what the part holds, drawn
 * small in the studio's own colours, so it reads in both themes. A part without a drawing of its
 * own (a plugin's) shows its icon, large.
 */

/** Each part's ground and its one colour. */
const TONE: Record<string, { ground: string; ink: string }> = {
  info: { ground: "bg-ember-tint", ink: "text-ember-strong" },
  brand: { ground: "bg-violet-500/10", ink: "text-violet-700 dark:text-violet-300" },
  knowledge: { ground: "bg-cobalt-tint", ink: "text-cobalt" },
  data: { ground: "bg-moss-tint", ink: "text-moss" },
  page: { ground: "bg-amber-tint", ink: "text-amber" },
};

const FALLBACK = { ground: "bg-paper-2", ink: "text-ink-3" };

/** A sheet of paper: the cards' and documents' common shape. */
function Sheet({
  x,
  y,
  w,
  h,
  r = 8,
  rotate = 0,
  className = "fill-paper stroke-border",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  rotate?: number;
  className?: string;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={r}
      strokeWidth={1}
      className={className}
      transform={rotate ? `rotate(${rotate} ${x + w / 2} ${y + h / 2})` : undefined}
    />
  );
}

/** Grey lines of text on a sheet. */
function Lines({
  x,
  y,
  widths,
  gap = 9,
}: {
  x: number;
  y: number;
  widths: number[];
  gap?: number;
}) {
  return (
    <>
      {widths.map((w, i) => (
        <rect key={i} x={x} y={y + i * gap} width={w} height={4} rx={2} className="fill-paper-3" />
      ))}
    </>
  );
}

/** Info: who is behind the wizards, a card with a face, a name and facts. */
function InfoArt() {
  return (
    <>
      <Sheet x={78} y={22} w={110} h={72} rotate={-6} className="fill-paper-2 stroke-border-soft" />
      <Sheet x={66} y={26} w={116} h={74} />
      <circle cx={92} cy={52} r={13} className="fill-current opacity-15" />
      <circle cx={92} cy={48} r={5} className="fill-current" />
      <path d="M83 60a9 7 0 0 1 18 0" className="fill-current" />
      <rect x={113} y={42} width={50} height={6} rx={3} className="fill-current" />
      <Lines x={113} y={55} widths={[56, 40]} />
      <Lines x={78} y={78} widths={[90]} />
      <circle cx={180} cy={92} r={11} className="fill-paper stroke-current" strokeWidth={1.5} />
      <path
        d="M175 92l3.5 3.5L185 88"
        className="stroke-current"
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

/** Brand: colour cards fanned out, the type on the front one. */
function BrandArt() {
  return (
    <>
      <g transform="rotate(-14 120 96)">
        <Sheet x={88} y={20} w={52} h={76} className="fill-ember stroke-none" />
      </g>
      <g transform="rotate(-2 120 96)">
        <Sheet x={96} y={18} w={52} h={78} className="fill-cobalt stroke-none" />
      </g>
      <g transform="rotate(11 120 96)">
        <Sheet x={104} y={18} w={56} h={80} className="fill-paper stroke-border" />
        <text
          x={132}
          y={60}
          textAnchor="middle"
          className="fill-current font-display font-semibold"
          fontSize={24}
        >
          Aa
        </text>
        <circle cx={120} cy={80} r={4} className="fill-moss" />
        <circle cx={132} cy={80} r={4} className="fill-current" />
        <circle cx={144} cy={80} r={4} className="fill-amber" />
      </g>
    </>
  );
}

/** Knowledge: documents stacked, the front one marked. */
function KnowledgeArt() {
  return (
    <>
      <Sheet x={92} y={16} w={64} h={82} rotate={8} className="fill-paper-2 stroke-border-soft" />
      <Sheet x={78} y={20} w={64} h={82} rotate={-5} className="fill-paper stroke-border-soft" />
      <Sheet x={88} y={22} w={66} h={82} />
      <Lines x={98} y={38} widths={[40, 46, 30, 44, 36]} />
      <path d="M136 22h10v20l-5-4-5 4z" className="fill-current" />
      <circle cx={160} cy={88} r={14} className="fill-paper stroke-current" strokeWidth={1.5} />
      <circle cx={158} cy={86} r={5} className="stroke-current" strokeWidth={2} fill="none" />
      <path d="M162 90l4 4" className="stroke-current" strokeWidth={2} strokeLinecap="round" />
    </>
  );
}

/** Memory: what the wizards keep, rows of a table filling up. */
function DataArt() {
  const rows = [0, 1, 2, 3];
  return (
    <>
      <Sheet x={62} y={20} w={124} h={84} />
      <rect x={62} y={20} width={124} height={16} rx={8} className="fill-current opacity-15" />
      <rect x={62} y={28} width={124} height={8} className="fill-current opacity-15" />
      {rows.map((i) => (
        <g key={i}>
          <circle
            cx={76}
            cy={48 + i * 14}
            r={3.5}
            className={i < 3 ? "fill-current" : "fill-paper-3"}
          />
          <rect
            x={86}
            y={46 + i * 14}
            width={i % 2 ? 34 : 46}
            height={4}
            rx={2}
            className="fill-paper-3"
          />
          <rect x={140} y={46 + i * 14} width={30} height={4} rx={2} className="fill-paper-3" />
        </g>
      ))}
      <circle cx={186} cy={98} r={11} className="fill-current" />
      <path
        d="M186 93v10M181 98h10"
        className="stroke-paper"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  );
}

/** The public page: a browser window with a page in it. */
function PageArt() {
  return (
    <>
      <Sheet x={58} y={18} w={132} h={88} />
      <rect x={58} y={18} width={132} height={14} rx={8} className="fill-paper-2" />
      <rect x={58} y={26} width={132} height={6} className="fill-paper-2" />
      <circle cx={68} cy={25} r={2} className="fill-paper-3" />
      <circle cx={75} cy={25} r={2} className="fill-paper-3" />
      <circle cx={82} cy={25} r={2} className="fill-paper-3" />
      <rect x={72} y={42} width={60} height={7} rx={3.5} className="fill-current" />
      <Lines x={72} y={56} widths={[48, 38]} />
      <rect x={72} y={76} width={30} height={10} rx={5} className="fill-current opacity-80" />
      <rect x={144} y={42} width={34} height={44} rx={6} className="fill-current opacity-15" />
    </>
  );
}

const ART: Record<string, ComponentType> = {
  info: InfoArt,
  brand: BrandArt,
  knowledge: KnowledgeArt,
  data: DataArt,
  page: PageArt,
};

export function PartArt({
  id,
  icon: Icon,
  className,
}: {
  id: string;
  icon: ComponentType<{ className?: string }>;
  className?: string;
}) {
  const tone = TONE[id] ?? FALLBACK;
  const Art = ART[id];
  return (
    <span
      aria-hidden
      className={cn("relative block h-32 overflow-hidden", tone.ground, tone.ink, className)}
    >
      {Art ? (
        <svg
          viewBox="44 8 160 104"
          className="absolute inset-x-0 top-3 bottom-1 m-auto h-[calc(100%-1rem)] w-full transition duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
          preserveAspectRatio="xMidYMid meet"
        >
          <Art />
        </svg>
      ) : (
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-16 place-items-center rounded-2xl bg-paper shadow-soft">
            <Icon className="size-8" />
          </span>
        </span>
      )}
    </span>
  );
}
