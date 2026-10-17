import { RunnerBody as Body, type RunSource } from "@engenty-wizards/runner";

export { initialValues, useDoneSignal } from "@engenty-wizards/runner";

import type { RunView } from "@engenty-wizards/shared/run";
import { useRun } from "./useRun";

export type { RunSource };

/** The runner on one of this runtime's runs: its view comes over the server-sent stream. */
export function RunnerBody({
  runId,
  ...rest
}: {
  runId: string;
  compact?: boolean;
  studio?: boolean;
  onRestart?: () => void;
  onView?: (view: RunView | null) => void;
  stickyProgress?: boolean;
}) {
  const run = useRun(runId);
  return <Body run={run} {...rest} />;
}
