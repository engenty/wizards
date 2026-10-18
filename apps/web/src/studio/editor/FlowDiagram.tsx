import dagre from "@dagrejs/dagre";
import {
  type Condition,
  conditionsOf,
  isOtherwise,
  type ResultStep,
  type Step,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import type { BranchDecision, RunEstimate, ShownDecision } from "@engenty/wizards-shared/run";
import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  getBezierPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import {
  AlertCircle,
  Check,
  Link2,
  type LucideIcon,
  Minus,
  Plus,
  Scan,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Mascot } from "../../brand";
import { lang, t } from "../../lib/i18n";
import { TARGET_ICON } from "../../share/icons";
import { cn, Spinner } from "../../ui";
import type { Adding } from "./AddStep";
import { useEstimate } from "./estimate";
import { stepIcon, stepSummary, TYPE_TONE, typeLabel } from "./meta";
import { audiences, type ShareMode, type ShareRow, shareRows, useShareTargets } from "./share";

const NODE_W = 280;
const NODE_H = 92;
/** A result with its share targets under its downloads. */
const RESULT_H = NODE_H + 34;

/** Where a result goes besides its link: what visitors get, only the owner, nobody. */
export interface NodeShare {
  mode: ShareMode;
  visitors: ShareRow[];
  onlyYou: ShareRow[];
  broken: ShareRow[];
}

type StepData = {
  step: Step;
  selected: boolean;
  issue: boolean;
  index: number;
  active: boolean;
  /** Just changed from elsewhere (an MCP client). */
  pulse: boolean;
  /** What the step is expected to cost, in credits. */
  cost: number | null;
  /** A run went through it already. */
  passed: boolean;
  /** Asks for a step after this one; shown under the step while it is selected or hovered. */
  onAddAfter?: () => void;
  /** What a test run does in this step right now, in place of its summary. */
  live?: StepLive | null;
  /** A result's share targets. */
  share?: NodeShare;
};

/** A test run's step in effect: what it does, since when it runs, or why it stopped. */
export interface StepLive {
  step: string;
  text: string;
  /** When the step started working; null while it waits for the person. */
  since: number | null;
  failed: boolean;
}

/** Seconds since `since`, ticking. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="shrink-0 tabular-nums">{Math.max(0, Math.round((now - since) / 1000))} s</span>
  );
}
type StartData = { title: string; avatar: string; selected: boolean };

function StepNode({ data }: NodeProps<Node<StepData>>) {
  const { step, selected, issue, active, pulse, cost, passed, onAddAfter, live, share } = data;
  const Icon = stepIcon(step);
  return (
    <div
      className={cn(
        "group relative w-[280px] cursor-pointer rounded-xl bg-card px-4 py-3 text-left shadow-soft ring-1 transition",
        selected
          ? "shadow-elevated ring-2 ring-ember"
          : live?.failed
            ? "ring-2 ring-rose"
            : active
              ? "ring-2 ring-moss"
              : pulse
                ? "ring-2 ring-ember/60"
                : "ring-border-soft hover:shadow-elevated",
      )}
    >
      {live?.failed ? (
        <span className="-top-1 -right-1 absolute size-3 rounded-full bg-rose" />
      ) : active ? (
        <span className="-top-1 -right-1 absolute size-3 animate-breathe rounded-full bg-moss" />
      ) : pulse ? (
        <span className="-top-1 -right-1 absolute size-3 animate-breathe rounded-full bg-ember" />
      ) : null}
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-md",
            TYPE_TONE[step.type],
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.07em]">
          {typeLabel(step)}
        </span>
        {issue ? (
          <AlertCircle className="ml-auto size-4 text-rose" />
        ) : passed && !active ? (
          <Check className="ml-auto size-4 text-moss" />
        ) : cost !== null ? (
          <span className="ml-auto text-[0.6875rem] text-ink-3 tabular-nums">
            ≈{" "}
            {t("nav.credits", {
              n:
                cost < 10
                  ? cost.toLocaleString(lang, { maximumFractionDigits: 1 })
                  : Math.round(cost),
            })}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 truncate font-display font-semibold text-[0.9375rem] text-ink">
        {step.title}
      </div>
      {live ? (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[0.75rem]",
            live.failed ? "text-rose" : "text-moss",
          )}
        >
          {live.failed ? (
            <AlertCircle className="size-3 shrink-0" />
          ) : live.since !== null ? (
            <Spinner className="size-3 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 truncate" title={live.text}>
            {live.text}
          </span>
          {live.since !== null && !live.failed ? <Elapsed since={live.since} /> : null}
        </div>
      ) : (
        <div className="truncate text-[0.75rem] text-ink-3">{stepSummary(step) || " "}</div>
      )}
      {share ? <ShareLine share={share} /> : null}
      <Handle type="source" position={Position.Bottom} />
      {onAddAfter ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAddAfter();
          }}
          className={cn(
            "nodrag nopan -translate-x-1/2 -translate-y-1/2 absolute top-full left-1/2 z-10 inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-card px-3 text-[0.75rem] text-ember-strong shadow-soft ring-1 ring-ember/40 transition hover:bg-ember-tint focus-visible:opacity-100",
            selected
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
          )}
        >
          <Sparkles className="size-3.5" /> {t("addStep.add")}
        </button>
      ) : null}
    </div>
  );
}

function ShareDot({
  icon: Icon,
  name,
  tone,
}: {
  icon: LucideIcon;
  name: string;
  tone: "on" | "you" | "warn";
}) {
  return (
    <span
      title={name}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full",
        tone === "on" && "bg-paper-2 text-ink-2",
        tone === "you" && "text-ink-3 ring-1 ring-input ring-inset",
        tone === "warn" && "bg-amber-tint text-amber",
      )}
    >
      <Icon className="size-3" />
    </span>
  );
}

/** The result's targets on its node: filled for visitors, a ring for the owner only. */
function ShareLine({ share }: { share: NodeShare }) {
  const { mode, visitors, onlyYou, broken } = share;
  const icon = (row: ShareRow) => TARGET_ICON[row.info?.icon ?? "plug"];
  const text = broken.length
    ? t("flow.notSetUp", { name: broken[0].name })
    : mode === "off"
      ? t("flow.linkOnly")
      : mode === "own"
        ? t("shareEditor.own")
        : [
            t("flow.forVisitors", { n: visitors.length + 1 }),
            onlyYou.length ? t("flow.forYou", { n: onlyYou.length }) : null,
          ]
            .filter(Boolean)
            .join(" · ");
  return (
    <div className="mt-2 flex items-center gap-1 border-border-soft border-t pt-2">
      <ShareDot icon={Link2} name={t("share.link")} tone="on" />
      {visitors.map((row) => (
        <ShareDot key={row.key} icon={icon(row)} name={row.name} tone="on" />
      ))}
      {onlyYou.map((row) => (
        <ShareDot key={row.key} icon={icon(row)} name={row.name} tone="you" />
      ))}
      {broken.map((row) => (
        <ShareDot key={row.key} icon={icon(row)} name={row.name} tone="warn" />
      ))}
      <span
        className={cn(
          "ml-1 flex min-w-0 flex-1 items-center gap-1 text-[0.6875rem]",
          broken.length ? "text-amber" : "text-ink-3",
        )}
      >
        {broken.length ? <TriangleAlert className="size-3 shrink-0" /> : null}
        <span className="truncate">{text}</span>
      </span>
    </div>
  );
}

function StartNode({ data }: NodeProps<Node<StartData>>) {
  return (
    <div
      className={cn(
        "flex w-[280px] cursor-pointer items-center gap-3 rounded-full bg-paper-2 py-1.5 pr-5 pl-2 transition",
        data.selected ? "ring-2 ring-ember" : "hover:bg-paper-3",
      )}
    >
      <Mascot kind={data.avatar} size={40} interactive={false} />
      <span className="truncate font-display font-semibold text-[0.9375rem]">{data.title}</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/** A step the assistant is building, in its place: dashed, until the flow has it. */
function AddingNode({ data }: NodeProps<Node<{ prompt: string }>>) {
  return (
    <div className="w-[280px] rounded-xl border border-ember/50 border-dashed bg-card/70 px-4 py-3 text-left">
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2 text-[0.75rem] text-ember-strong">
        <Spinner className="size-3.5" /> {t("addStep.building")}
      </div>
      <div className="mt-1.5 line-clamp-2 text-[0.8125rem] text-ink-2">{data.prompt}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

type Point = { x: number; y: number };
type BranchData = { points: Point[]; labelX: number; labelY: number };

/**
 * A branch that skips steps, drawn where the layout routed it: beside the steps it passes, with
 * its condition on the line. A straight line between the two steps would run behind them.
 */
function BranchEdge(props: EdgeProps<Edge<BranchData>>) {
  const { data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  const text = {
    label: props.label,
    labelStyle: props.labelStyle,
    labelBgStyle: props.labelBgStyle,
    labelBgPadding: props.labelBgPadding,
    labelBgBorderRadius: props.labelBgBorderRadius,
    style: props.style,
    markerEnd: props.markerEnd,
  };
  if (!data?.points.length) {
    const [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });
    return <BaseEdge path={path} labelX={labelX} labelY={labelY} {...text} />;
  }
  // From the step's handle through the layout's points to the next handle; each stretch leaves
  // and arrives vertically, like the other lines.
  const stops = [{ x: sourceX, y: sourceY }, ...data.points, { x: targetX, y: targetY }];
  const path = stops
    .map((to, i) => {
      const from = stops[i - 1];
      if (!from) {
        return `M ${to.x} ${to.y}`;
      }
      const mid = (from.y + to.y) / 2;
      return `C ${from.x} ${mid} ${to.x} ${mid} ${to.x} ${to.y}`;
    })
    .join(" ");
  return <BaseEdge path={path} labelX={data.labelX} labelY={data.labelY} {...text} />;
}

const nodeTypes = { step: StepNode, start: StartNode, adding: AddingNode };
const edgeTypes = { branch: BranchEdge };
const ADDING = "__adding";
/** A condition longer than this is cut on the line; the step's settings show it whole. */
const BRANCH_LABEL = 34;
const NO_COSTS: RunEstimate["steps"] = {};
const NO_DECISIONS: Record<string, BranchDecision> = {};

/**
 * A test run's decisions for the steps whose branches are still the ones it decided over: after a
 * branch is added, removed or changed, the decision's rule numbers would point at others.
 */
export function currentDecisions(
  def: WizardDefinition,
  decisions: Record<string, ShownDecision> | undefined,
): Record<string, BranchDecision> | undefined {
  if (!decisions) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(decisions).filter(
      ([id, d]) =>
        JSON.stringify(def.steps.find((s) => s.id === id)?.next ?? []) === JSON.stringify(d.over),
    ),
  );
}

/** How probable a decision found an answer, as on a line: "99 %". */
export function percent(p: number): string {
  return `${Math.round(p * 100)} %`;
}

function conditionLabel(rule: NonNullable<Step["next"]>[number]): string {
  const label = rule.ask
    ? t("editor.whenAsk", { text: rule.ask })
    : isOtherwise(rule)
      ? t("editor.otherwise")
      : conditionsOf(rule.when).map(conditionText).join(" · ");
  return rule.max ? `${label} (${t("editor.atMost", { count: rule.max })})` : label;
}

export function conditionText(c: Condition): string {
  const v = Array.isArray(c.value) ? c.value.join(" / ") : String(c.value ?? "");
  switch (c.op) {
    case "equals":
      return `${c.field} = ${v}`;
    case "notEquals":
      return `${c.field} ≠ ${v}`;
    case "in":
      return `${c.field} ∈ ${v}`;
    case "notEmpty":
      return t("editor.whenFilled", { field: c.field });
    case "empty":
      return t("editor.whenEmpty", { field: c.field });
    case "gt":
      return `${c.field} > ${v}`;
    case "lt":
      return `${c.field} < ${v}`;
    case "contains":
      return t("editor.whenContains", { field: c.field, value: v });
  }
}

function layout(
  def: WizardDefinition,
  selected: string | null,
  issueSteps: ReadonlySet<string>,
  activeStep: string | null,
  pulse: string[],
  costs: RunEstimate["steps"],
  passed: ReadonlySet<string>,
  decisions: Record<string, BranchDecision>,
  adding: Adding | null,
  onInsert?: (at: number) => void,
  live?: StepLive | null,
  share?: (step: ResultStep) => NodeShare,
) {
  const heightOf = (s: Step) => (s.type === "result" && share ? RESULT_H : NODE_H);
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 46, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  g.setNode("__start", { width: NODE_W, height: 52 });
  for (const s of def.steps) {
    g.setNode(s.id, { width: NODE_W, height: heightOf(s) });
  }
  const edges: Edge[] = [];
  const edgeStyle = {
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--ink-4)" },
  };
  // The step being added sits between the two it goes between, and the line runs through it.
  if (adding) {
    g.setNode(ADDING, { width: NODE_W, height: NODE_H });
  }
  /** The line from `source` to the step at `at`, through the step being added if it goes there. */
  const nextLine = (id: string, source: string, at: number, extra: Partial<Edge> = {}) => {
    const target = def.steps[at]?.id;
    if (adding?.at === at) {
      g.setEdge(source, ADDING);
      edges.push({ id, source, target: ADDING, ...extra, ...edgeStyle });
      if (target) {
        g.setEdge(ADDING, target);
        edges.push({ id: `${id}-adding`, source: ADDING, target, ...edgeStyle });
      }
      return;
    }
    if (!target) {
      return;
    }
    if (!g.hasEdge(source, target)) {
      g.setEdge(source, target);
    }
    edges.push({ id, source, target, ...extra, ...edgeStyle });
  };
  if (def.steps[0] || adding) {
    nextLine("e-start", "__start", 0);
  }
  def.steps.forEach((s, i) => {
    const next = def.steps[i + 1];
    // One line per step a branch leads to, with all its conditions on it. The branch a test
    // run's decision took is marked, with how probable the decision found it.
    const decision = decisions[s.id];
    const decidedGoto =
      decision && decision.rule !== null ? s.next?.[decision.rule]?.goto : undefined;
    const branches = new Map<string, string[]>();
    for (const rule of s.next ?? []) {
      if (rule.goto === "end" || !def.steps.some((x) => x.id === rule.goto)) {
        continue;
      }
      branches.set(rule.goto, [...(branches.get(rule.goto) ?? []), conditionLabel(rule)]);
    }
    for (const [goto, conditions] of branches) {
      const all = conditions.join(" · ");
      const cut = all.length > BRANCH_LABEL ? `${all.slice(0, BRANCH_LABEL - 1)}…` : all;
      const p = decidedGoto === goto ? decision?.probabilities?.[`r${decision.rule}`] : undefined;
      const taken = decidedGoto === goto;
      const label = taken ? `✓ ${cut}${p === undefined ? "" : ` · ${percent(p)}`}` : cut;
      // The layout keeps room for the label, so the steps beside the line stand clear of it.
      g.setEdge(s.id, goto, { width: label.length * 6.2 + 16, height: 22, labelpos: "c" });
      edges.push({
        id: `b-${s.id}-${goto}`,
        type: "branch",
        source: s.id,
        target: goto,
        label,
        className: "cursor-pointer",
        labelStyle: { fontSize: 11, fill: taken ? "var(--moss)" : "var(--ink-2)" },
        labelBgStyle: { fill: "var(--paper-2)" },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 8,
        style: taken
          ? { strokeDasharray: "5 4", stroke: "var(--moss)", strokeWidth: 2 }
          : { strokeDasharray: "5 4" },
        ...edgeStyle,
      });
    }
    // A step with an "otherwise" branch never just goes on to the next step in the list.
    if ((next || adding?.at === i + 1) && s.type !== "result" && !s.next?.some(isOtherwise)) {
      const none = decision?.rule === null;
      const p = none ? decision?.probabilities?.none : undefined;
      nextLine(`n-${s.id}`, s.id, i + 1, {
        ...(s.next?.length
          ? {
              label: none
                ? `✓ ${t("editor.otherwise")}${p === undefined ? "" : ` · ${percent(p)}`}`
                : t("editor.otherwise"),
              className: "cursor-pointer",
              labelStyle: { fontSize: 11, fill: none ? "var(--moss)" : "var(--ink-3)" },
              labelBgStyle: { fill: "var(--background)" },
              ...(none ? { style: { stroke: "var(--moss)", strokeWidth: 2 } } : {}),
            }
          : {}),
      });
    }
  });
  dagre.layout(g);
  for (const edge of edges) {
    if (edge.type !== "branch") {
      continue;
    }
    const route = g.edge(edge.source, edge.target) as { points?: Point[]; x?: number; y?: number };
    // Without the first and the last point: those are on the steps' borders, the line starts
    // and ends at their handles.
    const points = (route.points ?? []).slice(1, -1);
    if (points.length && route.x !== undefined && route.y !== undefined) {
      edge.data = { points, labelX: route.x, labelY: route.y } satisfies BranchData;
    }
  }
  const nodes: Node[] = [
    {
      id: "__start",
      type: "start",
      position: { x: g.node("__start").x - NODE_W / 2, y: g.node("__start").y - 26 },
      data: { title: def.title, avatar: def.avatar, selected: selected === "__wizard" },
      draggable: false,
    },
    ...def.steps.map((s, index) => {
      const n = g.node(s.id);
      return {
        id: s.id,
        type: "step",
        position: { x: n.x - NODE_W / 2, y: n.y - heightOf(s) / 2 },
        data: {
          step: s,
          selected: selected === s.id,
          issue: issueSteps.has(s.id),
          index,
          active: activeStep === s.id,
          pulse: pulse.includes(s.id),
          cost: costs[s.id]?.credits ?? null,
          passed: passed.has(s.id),
          onAddAfter: onInsert && s.type !== "result" ? () => onInsert(index + 1) : undefined,
          live: live?.step === s.id ? live : null,
          share: s.type === "result" && share ? share(s) : undefined,
        },
        draggable: false,
      } satisfies Node<StepData>;
    }),
    ...(adding
      ? [
          {
            id: ADDING,
            type: "adding",
            position: { x: g.node(ADDING).x - NODE_W / 2, y: g.node(ADDING).y - NODE_H / 2 },
            data: { prompt: adding.prompt },
            draggable: false,
            selectable: false,
          },
        ]
      : []),
  ];
  return { nodes, edges };
}

function ZoomBar() {
  const rf = useReactFlow();
  const btn =
    "inline-flex size-8 items-center justify-center rounded-full text-ink-3 hover:bg-accent hover:text-ink coarse:size-10";
  return (
    // On a phone it stands at the bottom right, under the thumb, its buttons larger for fingers.
    <div className="absolute bottom-4 left-4 z-10 flex items-center gap-0.5 rounded-full bg-card p-1 shadow-soft ring-1 ring-border-soft max-sm:right-3 max-sm:bottom-3 max-sm:left-auto">
      <button
        type="button"
        className={btn}
        onClick={() => rf.zoomOut()}
        aria-label={t("editor.zoomOut")}
      >
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => rf.fitView({ padding: 0.2, duration: 300 })}
        aria-label={t("editor.zoomFit")}
      >
        <Scan className="size-4" />
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => rf.zoomIn()}
        aria-label={t("editor.zoomIn")}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

const MIN_READABLE_ZOOM = 0.8;
const NONE: ReadonlySet<string> = new Set();

interface CanvasProps {
  def: WizardDefinition;
  selected: string | null;
  onSelect: (id: string | null) => void;
  issueSteps: ReadonlySet<string>;
  activeStep: string | null;
  pulse?: string[];
  costs?: RunEstimate["steps"];
  /** Steps a run went through. */
  passed?: ReadonlySet<string>;
  /** How far the first fit may shrink the flow; the studio keeps it readable and scrolls. */
  minFitZoom?: number;
  /** Fit again when this changes (the frame got larger), besides the flow's shape. */
  fitKey?: string;
  /** What a test run's decided branches answered, by step: the branch taken is marked. */
  decisions?: Record<string, BranchDecision>;
  /** A branch line was clicked: the step's branches, from where it leaves. */
  onBranch?: (stepId: string) => void;
  /** The step the assistant is building, shown in its place. */
  adding?: Adding | null;
  /** A step's "step after" asks for a step in that place: before the step at `at`. */
  onInsert?: (at: number) => void;
  /** What a test run does in its step in effect; the diagram keeps that step in view. */
  live?: StepLive | null;
  /** Where a result is sent or published, for its node. */
  share?: (step: ResultStep) => NodeShare;
}

function Inner({
  def,
  selected,
  onSelect,
  issueSteps,
  activeStep,
  pulse,
  costs = NO_COSTS,
  passed = NONE,
  minFitZoom = MIN_READABLE_ZOOM,
  fitKey,
  decisions = NO_DECISIONS,
  onBranch,
  adding = null,
  onInsert,
  live = null,
  share,
}: CanvasProps) {
  const { nodes, edges } = useMemo(
    () =>
      layout(
        def,
        selected,
        issueSteps,
        activeStep,
        pulse ?? [],
        costs,
        passed,
        decisions,
        adding,
        onInsert,
        live,
        share,
      ),
    [
      def,
      selected,
      issueSteps,
      activeStep,
      pulse,
      costs,
      passed,
      decisions,
      adding,
      onInsert,
      live,
      share,
    ],
  );
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const shape = def.steps.map((s) => s.id).join("|") + (adding ? `+${adding.at}` : "");
  // Re-fit when the flow's shape changes (a step added or removed), not on every edit.
  // A long flow is not shrunk into illegibility: it starts readable at the top and scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the flow's shape
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = wrap.current;
      if (!el || !nodes.length) {
        return;
      }
      const xs = nodes.map((n) => n.position.x);
      const ys = nodes.map((n) => n.position.y);
      const bounds = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) + NODE_W - Math.min(...xs),
        height: Math.max(...ys) + NODE_H - Math.min(...ys),
      };
      const fit = Math.min(
        el.clientWidth / (bounds.width * 1.2),
        el.clientHeight / (bounds.height * 1.15),
        1,
      );
      const zoom = Math.max(fit, minFitZoom);
      const x = (el.clientWidth - bounds.width * zoom) / 2 - bounds.x * zoom;
      const y =
        fit >= minFitZoom
          ? (el.clientHeight - bounds.height * zoom) / 2 - bounds.y * zoom
          : 24 - bounds.y * zoom;
      void rf.setViewport({ x, y, zoom }, { duration: 400 });
    });
    return () => cancelAnimationFrame(id);
  }, [shape, fitKey, rf]);
  // The step a run moves on to is brought into view when it lies outside.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the step in effect
  useEffect(() => {
    const el = wrap.current;
    const node = activeStep ? nodes.find((n) => n.id === activeStep) : null;
    if (!(el && node)) {
      return;
    }
    const { x, y, zoom } = rf.getViewport();
    const cx = node.position.x + NODE_W / 2;
    const cy = node.position.y + NODE_H / 2;
    const sx = cx * zoom + x;
    const sy = cy * zoom + y;
    const margin = 40;
    if (
      sx < margin ||
      sx > el.clientWidth - margin ||
      sy < margin ||
      sy > el.clientHeight - margin
    ) {
      void rf.setCenter(cx, cy, { zoom, duration: 400 });
    }
  }, [activeStep, rf]);
  return (
    <div ref={wrap} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => {
          if (n.id !== ADDING) {
            onSelect(n.id === "__start" ? "__wizard" : n.id);
          }
        }}
        onEdgeClick={(_, e) => {
          // A line that leaves a step with branches opens them; a plain "next" line, the step.
          const from = def.steps.find((s) => s.id === (e.source === ADDING ? "" : e.source));
          if (from?.next?.length && onBranch) {
            onBranch(from.id);
          } else if (from) {
            onSelect(from.id);
          }
        }}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        // A double tap or click on the free canvas zooms in, as the + does.
        zoomOnDoubleClick
        minZoom={0.3}
        maxZoom={1.4}
        proOptions={{ hideAttribution: true }}
      >
        <ZoomBar />
      </ReactFlow>
    </div>
  );
}

/** The flow without the studio around it: the flow widget in AI apps draws it too. */
export function FlowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

/** The studio's flow, with what each step is expected to cost. */
export function FlowDiagram({ wizardId, ...props }: CanvasProps & { wizardId: string }) {
  const estimate = useEstimate(wizardId, props.def);
  const targets = useShareTargets(wizardId).data;
  const share = useMemo(
    () =>
      targets
        ? (step: ResultStep): NodeShare => {
            const { mode, rows } = shareRows(step, targets);
            return { mode, ...audiences(mode, rows) };
          }
        : undefined,
    [targets],
  );
  return (
    <FlowCanvas
      {...props}
      costs={estimate.data?.available ? estimate.data.steps : NO_COSTS}
      share={share}
    />
  );
}
