import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { cn } from "../ui";

/** A step as the preview draws it: an icon, its name, and where the flow may go on instead. */
export interface PreviewStep {
  id: string;
  title: string;
  icon: LucideIcon;
  /** The colours of the step's type, as the studio's diagram uses them. */
  tone: string;
  /** Only runs when no branch jumps over it. */
  optional: boolean;
  /** `to` is a step's id or `end`. */
  branches?: { to: string; when: string }[];
  /** False where the step below is not where this one goes on: no line joins the two. */
  flowsOn?: boolean;
  /** On a card: the kind of step above its title, one line below it, and a note beside the kind. */
  kind?: string;
  summary?: string;
  note?: string;
}

const NODE_W = 208;
const NODE_H = 42;
/** A card: the step with its kind and one line of what it does, as the editor's diagram has it. */
const CARD_W = 280;
const CARD_H = 88;
const GAP = 26;
/** How far a branch swings out to the right of the steps, and the room its words get there. */
const SWING = 22;
const LABEL_W = 132;

type StepData = Pick<
  PreviewStep,
  "title" | "icon" | "tone" | "optional" | "kind" | "summary" | "note"
> & { selected?: boolean; onSelect?: () => void };

function CardNode({ data }: NodeProps<Node<StepData>>) {
  const Icon = data.icon;
  return (
    <button
      type="button"
      onClick={data.onSelect}
      style={{ width: CARD_W, height: CARD_H }}
      className={cn(
        "nodrag nopan pointer-events-auto block cursor-pointer rounded-xl bg-card px-4 py-3 text-left shadow-soft ring-1 transition",
        data.selected
          ? "shadow-elevated ring-2 ring-ember"
          : "ring-border-soft hover:shadow-elevated",
      )}
    >
      <Handle type="target" position={Position.Top} />
      <Handle type="target" id="in" position={Position.Right} />
      <span className="flex items-center gap-2">
        <span
          className={cn("inline-flex size-6 items-center justify-center rounded-md", data.tone)}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="truncate font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.07em]">
          {data.kind}
        </span>
        {data.note ? (
          <span className="ml-auto shrink-0 text-[0.6875rem] text-ink-3 tabular-nums">
            {data.note}
          </span>
        ) : null}
      </span>
      <span className="mt-1.5 block truncate font-display font-semibold text-[0.9375rem] text-ink">
        {data.title}
      </span>
      <span className="block truncate text-[0.75rem] text-ink-2">{data.summary}</span>
      <Handle type="source" position={Position.Bottom} />
      <Handle type="source" id="out" position={Position.Right} />
    </button>
  );
}

function StepNode({ data }: NodeProps<Node<StepData>>) {
  const Icon = data.icon;
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-xl px-2.5",
        data.optional ? "border border-ink-4 border-dashed" : "bg-paper-2 ring-1 ring-border-soft",
      )}
    >
      <Handle type="target" position={Position.Top} />
      <Handle type="target" id="in" position={Position.Right} />
      <span
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
          data.tone,
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="truncate font-medium text-[0.8125rem] text-ink">{data.title}</span>
      <Handle type="source" position={Position.Bottom} />
      <Handle type="source" id="out" position={Position.Right} />
    </div>
  );
}

/** A branch: out to the right of its step, past the steps it skips or goes back over, and back in. */
function BranchEdge({ sourceX, sourceY, targetX, targetY, label, markerEnd }: EdgeProps) {
  const x = Math.max(sourceX, targetX) + SWING;
  const r = 8;
  // A way back leads up: its corners turn the other way.
  const up = targetY < sourceY ? -1 : 1;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `H ${x - r}`,
    `Q ${x} ${sourceY} ${x} ${sourceY + up * r}`,
    `V ${targetY - up * r}`,
    `Q ${x} ${targetY} ${x - r} ${targetY}`,
    `H ${targetX}`,
  ].join(" ");
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ strokeDasharray: "5 4" }} />
      <EdgeLabelRenderer>
        <div
          style={{
            width: LABEL_W,
            transform: `translate(${x + 8}px, ${(sourceY + targetY) / 2}px) translateY(-50%)`,
          }}
          className="absolute line-clamp-3 whitespace-pre-line break-words text-[0.6875rem] text-ink-2 leading-snug"
          title={typeof label === "string" ? label : undefined}
        >
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { step: StepNode, card: CardNode };
const edgeTypes = { branch: BranchEdge };

function layout(
  steps: PreviewStep[],
  cards: boolean,
  selected?: string,
  onSelect?: (id: string) => void,
) {
  const w = cards ? CARD_W : NODE_W;
  const h = cards ? CARD_H : NODE_H;
  const arrow = {
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--ink-4)" },
  };
  const nodes: Node<StepData>[] = steps.map((s, i) => ({
    id: s.id,
    type: cards ? "card" : "step",
    position: { x: 0, y: i * (h + GAP) },
    data: {
      title: s.title,
      icon: s.icon,
      tone: s.tone,
      optional: s.optional,
      kind: s.kind,
      summary: s.summary,
      note: s.note,
      selected: s.id === selected,
      onSelect: onSelect ? () => onSelect(s.id) : undefined,
    },
    draggable: false,
  }));
  const edges: Edge[] = [];
  let branching = false;
  steps.forEach((s, i) => {
    const next = steps[i + 1];
    for (const [j, b] of (s.branches ?? []).entries()) {
      if (steps.some((x) => x.id === b.to)) {
        branching = true;
        edges.push({
          id: `b-${s.id}-${j}`,
          type: "branch",
          source: s.id,
          sourceHandle: "out",
          target: b.to,
          targetHandle: "in",
          label: b.when,
          ...arrow,
        });
      }
    }
    if (next && s.flowsOn !== false) {
      edges.push({ id: `n-${s.id}`, type: "straight", source: s.id, target: next.id, ...arrow });
    }
  });
  return {
    nodes,
    edges,
    width: w + (branching ? SWING + 8 + LABEL_W : 0),
    height: steps.length * (h + GAP) - GAP,
  };
}

/**
 * A wizard's flow as the studio draws it, reduced to what a person choosing a template needs:
 * the steps by name in one column, and where a branch skips some of them. Nothing to click,
 * drag or zoom — it scrolls with the column it is in.
 *
 * `cards`: each step as a card with its kind and one line below its title, and a click chooses it.
 */
export default function FlowPreview({
  steps,
  cards = false,
  selected,
  onSelect,
}: {
  steps: PreviewStep[];
  cards?: boolean;
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  const { nodes, edges, width, height } = useMemo(
    () => layout(steps, cards, selected, onSelect),
    [steps, cards, selected, onSelect],
  );
  if (!steps.length) {
    return null;
  }
  return (
    <div className="max-w-full" style={{ width, height: height + 4 }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultViewport={{ x: 1, y: 2, zoom: 1 }}
          minZoom={1}
          maxZoom={1}
          nodesConnectable={false}
          nodesDraggable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
    </div>
  );
}
