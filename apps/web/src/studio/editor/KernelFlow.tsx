import type { KernelFile } from "@engenty/wizards-shared/definition";
import { FileCode2 } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { kernelFlow } from "./kernel-flow";

const FlowPreview = lazy(() => import("../FlowPreview"));

/**
 * The map of a wizard in version 2: read from its file, so it is whole before any run. Each node
 * is a step file of the wizard; its code is under Files, as `steps/<id>.ts`.
 */
export function KernelFlow({ file }: { file: KernelFile }) {
  const steps = useMemo(
    () =>
      kernelFlow(file).map((step) => ({
        id: step.id,
        title: step.limit ? `${step.id} · ${step.limit}×` : step.id,
        icon: FileCode2,
        tone: "bg-paper-2 text-ink-2",
        optional: false,
        flowsOn: step.flowsOn,
        branches: step.branches.map((b) => ({ to: b.to, when: b.when })),
      })),
    [file],
  );
  return (
    <div className="flex h-full flex-col items-center gap-4 overflow-auto px-6 py-8">
      <Suspense fallback={null}>
        <FlowPreview steps={steps} />
      </Suspense>
    </div>
  );
}
