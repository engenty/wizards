/**
 * `transition()` as a test's build of the Worker has it (local-edge.ts, `probe`): each move the
 * flow makes is written to the object's log as "event ⇒ command → status", with its wizard's
 * title, for the test to compare with the pinned runs' moves.
 */
import {
  type FlowEvent,
  type FlowResult,
  transition as flowTransition,
} from "@engenty/wizards-shared/transition";

export * from "@engenty/wizards-shared/transition";

/** The line a move is written as. */
export const MOVE_LINE = "[probe] move ";

const eventOf = (e: FlowEvent) => `${e.kind}${"stepId" in e ? ` ${e.stepId}` : ""}`;

function commandOf({ command, run }: FlowResult): string {
  switch (command.kind) {
    case "run":
    case "ask":
      return `${command.kind} ${command.step.id}`;
    case "decide":
      return `decide ${command.stepId} [${command.rules.join(",")}]`;
    case "fail":
      return `fail ${command.stepId}`;
    case "waitSignal":
      return `waitSignal ${command.name}:${command.key}`;
    case "sleep":
      return `sleep ${run.cursor}${run.state.pause ? ` (${run.state.pause.kind})` : ""}`;
    default:
      return `${command.kind} ${run.cursor}`;
  }
}

export function transition(...args: Parameters<typeof flowTransition>): FlowResult {
  const [def, , event] = args;
  const result = flowTransition(...args);
  console.log(
    `${MOVE_LINE}${JSON.stringify({
      wizard: def.title,
      move: `${eventOf(event)} ⇒ ${commandOf(result)} → ${result.run.status}`,
    })}`,
  );
  return result;
}
