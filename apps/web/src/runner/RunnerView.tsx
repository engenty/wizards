import { RunnerBody as Body, type RunSource } from "@engenty/wizards-runner";

export { initialValues, useDoneSignal } from "@engenty/wizards-runner";

import type { RunView } from "@engenty/wizards-shared/run";
import { useEffect } from "react";
import { useRun } from "./useRun";

export type { RunSource };

/** The runner on one of this runtime's runs: its view comes over the server-sent stream. */
export function RunnerBody({
  runId,
  onNotFound,
  ...rest
}: {
  runId: string;
  compact?: boolean;
  studio?: boolean;
  onRestart?: () => void;
  onView?: (view: RunView | null) => void;
  /** The run isn't there for this browser: the page takes over instead of saying so. */
  onNotFound?: () => void;
  stickyProgress?: boolean;
}) {
  const run = useRun(runId);
  useEffect(() => {
    if (run.notFound) {
      onNotFound?.();
    }
  }, [run.notFound, onNotFound]);
  if (run.notFound && onNotFound) {
    return null;
  }
  return <Body run={run} {...rest} />;
}
