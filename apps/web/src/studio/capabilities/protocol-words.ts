import type {
  BrokerAnswer,
  BrokerRefusal,
  ConnectionActionKind,
  CriticalKind,
  ProtocolLine,
} from "@engenty/wizards-shared/connectors";
import { type Key, t } from "../../lib/i18n";

/*
 * The broker's log and „Was darf …?“ in plain words (docs/plans/broker.md): who, what, on which
 * connection, where, what came of it and which rule decided. Every refusal, outcome, rule and
 * critical kind the broker has maps to a string here; a value with none is a bug
 * (protocol-words.test.ts).
 */

/** Why a call did not run, after „abgelehnt:“. */
export const REFUSAL_WORDS: Record<BrokerRefusal, Key> = {
  not_connected: "protocol.refused.not_connected",
  no_action: "protocol.refused.no_action",
  not_in_grant: "protocol.refused.not_in_grant",
  denied: "protocol.refused.denied",
  declined: "protocol.refused.declined",
  nobody: "protocol.refused.nobody",
  needs_approval: "protocol.refused.needs_approval",
  ai_step_writes: "protocol.refused.ai_step_writes",
  not_allowed_recipient: "protocol.refused.not_allowed_recipient",
  channel_not_fixed: "protocol.refused.channel_not_fixed",
  run_limit: "protocol.refused.run_limit",
  day_limit: "protocol.refused.day_limit",
  run_ended: "protocol.refused.run_ended",
  paused: "protocol.refused.paused",
};

/** Why a run that is over took no more calls, by the rule the broker logs (`run.<status>`). */
const RUN_OVER_WORDS: Record<string, Key> = {
  "run.cancelled": "protocol.why.runStopped",
  "run.done": "protocol.why.runDone",
  "run.failed": "protocol.why.runFailed",
};

/** What an action does, as a noun: Lesen, Schreiben … */
export const KIND_WORDS: Record<ConnectionActionKind, Key> = {
  read: "protocol.kind.read",
  write: "protocol.kind.write",
  destructive: "protocol.kind.destructive",
  send: "protocol.kind.send",
};

/** What an action does, as the verb of a sentence: lesen, schreiben … */
export const VERB_WORDS: Record<ConnectionActionKind, Key> = {
  read: "protocol.verb.read",
  write: "protocol.verb.write",
  destructive: "protocol.verb.destructive",
  send: "protocol.verb.send",
};

/** The critical kinds, as Work's bell says them. */
export const CRITICAL_WORDS: Record<CriticalKind, Key> = {
  refused_write: "work.critical.refused_write",
  outside_audience: "work.critical.outside_audience",
  host_not_in_grant: "work.critical.host_not_in_grant",
  limit_reached: "work.critical.limit_reached",
  sign_in_failed: "work.critical.sign_in_failed",
  first_use: "work.critical.first_use",
  rule_changed: "work.critical.rule_changed",
};

/** The rules `decide` names (broker/call.ts), and the ones the host and mail paths log. */
export const RULE_WORDS: Record<string, Key> = {
  grant: "protocol.rule.grant",
  audience: "protocol.rule.audience",
  actions: "protocol.rule.actions",
  ai_step_writes: "protocol.rule.ai_step_writes",
  destructive: "protocol.rule.destructive",
  policy: "protocol.rule.policy",
  read: "protocol.rule.read",
  own_job: "protocol.rule.own_job",
  guest_send: "protocol.rule.guest_send",
  run: "protocol.rule.run",
  paused: "protocol.rule.paused",
};

/** Who a connection is for, after „nur für“. */
const AUDIENCE_WORDS: Record<string, Key> = {
  admins: "protocol.audience.admins",
  members: "protocol.audience.members",
  all: "protocol.audience.all",
};

function isKind(kind: string): kind is ConnectionActionKind {
  return kind in KIND_WORDS;
}

export function kindWord(kind: string): string {
  return isKind(kind) ? t(KIND_WORDS[kind]) : kind;
}

export function verbWord(kind: string): string {
  return isKind(kind) ? t(VERB_WORDS[kind]) : kind;
}

export function criticalWord(kind: string | null): string {
  return kind && kind in CRITICAL_WORDS ? t(CRITICAL_WORDS[kind as CriticalKind]) : "";
}

/** The rule that decided, in words: `rules.write` is the connection's rule for writing. */
export function ruleWord(rule: string | null): string {
  if (!rule) {
    return t("protocol.rule.none");
  }
  if (rule.startsWith("rules.")) {
    return t("protocol.rule.rules", { kind: kindWord(rule.slice(6)) });
  }
  // `policy.<action>`: the wizard's setting for that action.
  const named = RULE_WORDS[rule] ?? RULE_WORDS[rule.split(".")[0] ?? ""];
  return named ? t(named) : rule;
}

/** Why a call was refused: by the refusal where it says more than „denied“, else by the rule. */
export function refusalWord(
  refused: string | null,
  rule: string | null,
  audience?: string | null,
): string {
  // A run that is over: stopped, done or failed, as the rule says.
  if (refused === "run_ended" && rule && rule in RUN_OVER_WORDS) {
    return t(RUN_OVER_WORDS[rule] as Key);
  }
  if (refused && refused !== "denied" && refused in REFUSAL_WORDS) {
    return t(REFUSAL_WORDS[refused as BrokerRefusal]);
  }
  if (rule === "audience") {
    return audience && audience in AUDIENCE_WORDS
      ? t("protocol.why.audienceFor", { audience: t(AUDIENCE_WORDS[audience] as Key) })
      : t("protocol.why.audience");
  }
  if (rule === "actions") {
    return t("protocol.why.actions");
  }
  if (rule === "grant") {
    return t("protocol.refused.not_in_grant");
  }
  if (rule?.startsWith("rules.")) {
    return t("protocol.why.rule");
  }
  return t("protocol.refused.denied");
}

/** A run's state in the detail of a line: stopped says so, the rest as the lists of runs say it. */
const RUN_STATE_WORDS: Record<string, Key> = {
  waiting_input: "runs.status.waiting_input",
  sleeping: "runs.status.sleeping",
  running: "runs.status.running",
  done: "runs.status.done",
  failed: "runs.status.failed",
  cancelled: "protocol.detail.runStopped",
};

export function runStateWord(status: string): string {
  const named = RUN_STATE_WORDS[status];
  return named ? t(named) : status;
}

/** Whether a run still calls: the ones an admin can stop from the audit. */
export function runUnderWay(status: string): boolean {
  return status === "running" || status === "waiting_input" || status === "sleeping";
}

export type Tone = "done" | "refused" | "held" | "failed";

/** What came of a call: done, refused (and why), held for the admins, failed. */
export function outcomeOf(line: Pick<ProtocolLine, "outcome" | "result" | "rule">): {
  tone: Tone;
  text: string;
} {
  const { outcome, result, rule } = line;
  if (result === "ok") {
    return {
      tone: "done",
      text: t(outcome === "ask" ? "protocol.outcome.doneApproved" : "protocol.outcome.done"),
    };
  }
  if (result === "needs_approval") {
    return { tone: "held", text: t("protocol.outcome.held") };
  }
  if (result === "sign_in_failed") {
    return { tone: "failed", text: t("protocol.outcome.signInFailed") };
  }
  if (result === "nobody" || result === "not_connected") {
    return {
      tone: "failed",
      text: t("protocol.outcome.notDone", { why: t(REFUSAL_WORDS[result]) }),
    };
  }
  if (outcome === "deny" || result === "declined") {
    return {
      tone: "refused",
      text: t("protocol.outcome.refused", { why: refusalWord(result, rule) }),
    };
  }
  return { tone: "failed", text: t("protocol.outcome.failed", { error: result ?? "" }) };
}

/** Who called, as the line starts: a guest, a person by name, Goose for a person, a fixed step for … */
export function whoWord(who: ProtocolLine["who"]): string {
  switch (who.kind) {
    case "guest":
      return t("protocol.who.guest");
    case "person":
      return who.name ?? t("protocol.who.person");
    case "admin":
      return who.name ? t("protocol.who.adminNamed", { name: who.name }) : t("protocol.who.admin");
    case "goose":
      return who.name ? t("protocol.who.gooseFor", { name: who.name }) : t("protocol.who.goose");
    case "plugin":
      return t("protocol.who.plugin", { name: who.id ?? "" });
    case "step":
      if (!who.for) {
        return t("protocol.who.step");
      }
      return who.for.kind === "guest"
        ? t("protocol.who.stepForGuest")
        : t("protocol.who.stepFor", { name: who.for.name ?? t("protocol.who.person") });
    default:
      return who.kind;
  }
}

/** Where the call was made: a run of a wizard, a Work chat, Goose, a plugin's own job. */
export function whereWord(
  line: Pick<ProtocolLine, "runId" | "chatId" | "wizardName" | "runMode" | "chatTitle" | "who">,
): string {
  if (line.runId) {
    if (!line.wizardName) {
      return t("protocol.where.run");
    }
    return t(line.runMode === "test" ? "protocol.where.testRunOf" : "protocol.where.runOf", {
      wizard: line.wizardName,
    });
  }
  if (line.chatId) {
    return line.chatTitle
      ? t("protocol.where.chatNamed", { title: line.chatTitle })
      : t("protocol.where.chat");
  }
  if (line.who.kind === "goose") {
    return t("protocol.where.goose");
  }
  if (line.who.kind === "plugin") {
    return t("protocol.where.plugin");
  }
  return "";
}

/** The connection by its name; the server's mail, a host, the rights for the ids that are no connection. */
export function connectionWord(
  line: Pick<ProtocolLine, "connectionId" | "connectionName" | "connectorName">,
): string {
  const { connectionId: id } = line;
  if (line.connectionName) {
    return line.connectorName && !line.connectionName.includes(line.connectorName)
      ? `${line.connectorName} · ${line.connectionName}`
      : line.connectionName;
  }
  if (id.startsWith("host:")) {
    return t("protocol.connection.host", { host: id.slice(5) });
  }
  if (id === "mail:server") {
    return t("protocol.connection.serverMail");
  }
  if (id === "rwx") {
    return t("protocol.connection.rwx");
  }
  return line.connectorName ? `${line.connectorName} · ${id}` : id;
}

/**
 * The action by the connector's name for it; the broker's own actions in words. A changed rule
 * that paused or resumed a connection says so: its input is the one field `paused`.
 */
export function actionWord(
  line: Pick<ProtocolLine, "actionId" | "actionName"> & { input?: ProtocolLine["input"] },
): string {
  switch (line.actionId) {
    case "change_rules":
      if (line.input?.fields && "paused" in line.input.fields) {
        return t(
          line.input.sample === "paused: yes"
            ? "protocol.action.paused"
            : "protocol.action.resumed",
        );
      }
      return t("protocol.action.changeRules");
    case "http_request":
      return t("protocol.action.request");
    case "read_secret":
      return t("protocol.action.readSecret");
    case "send_message":
      return line.actionName ?? t("protocol.action.sendMail");
    default:
      return line.actionName ?? line.actionId;
  }
}

/** „Was darf …?“'s answer in one sentence. */
export function answerSentence(
  answer: Pick<BrokerAnswer, "outcome" | "rule" | "refused" | "admins" | "action">,
  names: { who: string; connection: string; audience?: string | null },
): string {
  const vars = {
    who: names.who,
    connection: names.connection,
    verb: verbWord(answer.action.kind),
  };
  if (answer.outcome === "allow") {
    return t("protocol.ask.allow", vars);
  }
  if (answer.outcome === "ask") {
    return t(answer.admins ? "protocol.ask.askAdmins" : "protocol.ask.askPerson", vars);
  }
  return t("protocol.ask.deny", {
    ...vars,
    why: refusalWord(answer.refused ?? null, answer.rule, names.audience),
  });
}

/** What the answer holds only under: a guest's post goes to the channel its step fixes. Else null. */
export function answerCondition(answer: Pick<BrokerAnswer, "fixedChannel">): string | null {
  return answer.fixedChannel ? t("protocol.ask.fixedChannel") : null;
}
