import type { ConnectionActionKind, StepWarning } from "@engenty/wizards-shared/connectors";
import { type Key, t } from "../../lib/i18n";

/*
 * What the editor warns of on a step, in words (docs/plans/capabilities-next.md, 2b). A warning
 * is never an error: the wizard saves and publishes. The runtime sends what it found as data
 * (`StepWarning`: which step, which connection, which kind of action); every word comes from
 * here, so the step's panel and the publish dialog say the same.
 */

/** What an action does, as the connection's page names its rules: Ändern, Senden … */
const KIND_WORDS: Record<ConnectionActionKind, Key> = {
  read: "connection.kind.read",
  write: "connection.kind.write",
  destructive: "connection.kind.destructive",
  send: "connection.kind.send",
};

/** What is the matter: which connection, which rule, and what that does to the step in a run. */
export function warningText(warning: StepWarning): string {
  return t("stepWarning.needsApproval", {
    connection: warning.connection.name,
    kind: t(KIND_WORDS[warning.action.kind]),
  });
}

/** What the reader can do: an admin changes the rule, a member asks the admins. */
export function warningAdvice(admin: boolean): string {
  return t(admin ? "stepWarning.needsApprovalAdmin" : "stepWarning.needsApprovalMember");
}

/** Where the rule is set: the connection's page in Fähigkeiten › Connectors. */
export function warningLink(warning: StepWarning): string {
  return `/capabilities/connectors?show=${encodeURIComponent(warning.connection.id)}`;
}

/** A warning in a list of several steps: the step's title first. */
export function warningOfStep(
  warning: StepWarning,
  steps: { id: string; title: string }[],
): string {
  const step = steps.find((s) => s.id === warning.stepId);
  return t("stepWarning.ofStep", {
    step: step?.title || warning.stepId,
    text: warningText(warning),
  });
}
