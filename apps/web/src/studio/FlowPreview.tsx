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
}

const NODE_W = 208;
const NODE_H = 42;
const GAP = 26;
/** How far a branch swings out to the right of the steps, and the room its words get there. */
const SWING = 22;
const LABEL_W = 132;

type StepData = Pick<PreviewStep, "title" | "icon" | "tone" | "optional">;

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

/** A branch: out to the right of its step, down past the steps it skips, and back in. */
function BranchEdge({ sourceX, sourceY, targetX, targetY, label, markerEnd }: EdgeProps) {
  const x = Math.max(sourceX, targetX) + SWING;
  const r = 8;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `H ${x - r}`,
    `Q ${x} ${sourceY} ${x} ${sourceY + r}`,
    `V ${targetY - r}`,
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
          className="absolute text-[0.6875rem] text-ink-2 leading-snug"
        >
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { step: StepNode };
const edgeTypes = { branch: BranchEdge };

function layout(steps: PreviewStep[]) {
  const arrow = {
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--ink-4)" },
  };
  const nodes: Node<StepData>[] = steps.map((s, i) => ({
    id: s.id,
    type: "step",
    position: { x: 0, y: i * (NODE_H + GAP) },
    data: { title: s.title, icon: s.icon, tone: s.tone, optional: s.optional },
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
    width: NODE_W + (branching ? SWING + 8 + LABEL_W : 0),
    height: steps.length * (NODE_H + GAP) - GAP,
  };
}

/**
 * A wizard's flow as the studio draws it, reduced to what a person choosing a template needs:
 * the steps by name in one column, and where a branch skips some of them. Nothing to click,
 * drag or zoom — it scrolls with the column it is in.
 */
export default function FlowPreview({ steps }: { steps: PreviewStep[] }) {
  const { nodes, edges, width, height } = useMemo(() => layout(steps), [steps]);
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
