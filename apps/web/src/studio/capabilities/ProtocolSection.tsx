import type {
  BrokerAnswer,
  ProtocolChoices,
  ProtocolLine,
  ProtocolLineDetail,
  ProtocolPage,
} from "@engenty/wizards-shared/connectors";
import type { SpaceNotify } from "@engenty/wizards-shared/spaces";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock,
  History,
  type LucideIcon,
  ShieldAlert,
  ShieldQuestion,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { type Space, useCurrentSpace } from "../../lib/session";
import { Button, Chip, cn, Select, Spinner, Switch, Tabs } from "../../ui";
import { scrollRoot } from "../AppFrame";
import { MenuRow, SubMenu, useDetail, useSettingsMenu } from "../settings-menu";
import { SearchField, Section } from "../space/Section";
import {
  actionWord,
  answerSentence,
  connectionWord,
  criticalWord,
  kindWord,
  outcomeOf,
  ruleWord,
  type Tone,
  whereWord,
  whoWord,
} from "./protocol-words";

/*
 * Fähigkeiten › Protokoll (docs/plans/capabilities.md, B5; docs/plans/broker.md, "The log",
 * "„Was darf …?“"): every call the broker decided in this space, in plain words, with filters and
 * a detail per line; the question an admin asks of the rules before anything runs; how the admins
 * hear of critical lines. For owners and admins: the runtime answers a member with 403, and the
 * section is not in a member's menu (`sections.ts`).
 */

type View = "log" | "ask" | "notify";

const VIEWS: { id: View; label: Parameters<typeof t>[0]; icon: LucideIcon }[] = [
  { id: "log", label: "capabilities.protocol", icon: History },
  { id: "ask", label: "protocol.ask.title", icon: ShieldQuestion },
  { id: "notify", label: "protocol.notify.title", icon: Bell },
];

export function ProtocolSection() {
  const [params, setParams] = useSearchParams();
  const { space } = useCurrentSpace();
  const { narrow } = useSettingsMenu();
  const shown = params.get("show");
  const view: View = shown === "ask" || shown === "notify" ? shown : "log";
  const current = VIEWS.find((v) => v.id === view);
  useDetail(view === "log" ? null : current ? t(current.label) : null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view is what scrolls up.
  useEffect(() => {
    if (!narrow) {
      scrollRoot().scrollTo({ top: 0 });
    }
  }, [narrow, view]);

  const pick = (id: View) =>
    narrow
      ? setParams({ show: id })
      : setParams(id === "log" ? {} : { show: id }, { replace: true });

  const choices = useQuery({
    queryKey: ["broker-choices", space?.id],
    queryFn: () => api.get<ProtocolChoices>(`/api/studio/spaces/${space?.id}/broker/choices`),
    enabled: Boolean(space),
  });

  return (
    <>
      <SubMenu>
        <ul className="flex flex-col gap-0.5">
          {VIEWS.map((v) => (
            <MenuRow
              key={v.id}
              icon={v.icon}
              label={t(v.label)}
              selected={!narrow && view === v.id}
              onPick={() => pick(v.id)}
            />
          ))}
        </ul>
      </SubMenu>
      {space ? (
        <div className="flex flex-col gap-9 pb-20">
          {view === "log" ? <Log spaceId={space.id} choices={choices.data} /> : null}
          {view === "ask" ? <Ask choices={choices.data} spaceId={space.id} /> : null}
          {view === "notify" ? <Notify space={space} /> : null}
        </div>
      ) : null}
    </>
  );
}

// --- the log ------------------------------------------------------------------------------------

type OutcomeFilter = "all" | "refused" | "critical" | "held";
type Range = "hour" | "day" | "week" | "month" | "all";

const RANGE_MS: Record<Exclude<Range, "all">, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

const WHO_KINDS = ["guest", "person", "admin", "goose", "plugin", "step"] as const;

/** Lines per page. */
const PAGE = 50;

/** The text a moment after the person stopped typing. */
function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Log({ spaceId, choices }: { spaceId: string; choices: ProtocolChoices | undefined }) {
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [who, setWho] = useState("");
  const [connection, setConnection] = useState("");
  const [range, setRange] = useState<Range>("week");
  const [text, setText] = useState("");
  const q = useSettled(text).trim();
  const [open, setOpen] = useState<string | null>(null);

  const filters = { outcome, who, connection, range, q };
  const log = useInfiniteQuery({
    queryKey: ["broker-log", spaceId, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (outcome === "refused") {
        query.set("refused", "true");
      } else if (outcome === "critical") {
        query.set("critical", "true");
      } else if (outcome === "held") {
        query.set("result", "needs_approval");
      }
      if (who) {
        query.set("who", who);
      }
      if (connection) {
        query.set("connection", connection);
      }
      if (range !== "all") {
        query.set("since", new Date(Date.now() - RANGE_MS[range]).toISOString());
      }
      if (q) {
        query.set("q", q);
      }
      if (pageParam) {
        query.set("cursor", pageParam);
      }
      return api.get<ProtocolPage>(`/api/studio/spaces/${spaceId}/broker/log?${query}`);
    },
    getNextPageParam: (last) => last.next,
  });
  const lines = log.data?.pages.flatMap((p) => p.lines) ?? [];
  const filtered =
    outcome !== "all" || who !== "" || connection !== "" || range !== "all" || q !== "";
  const spaceConnections = new Set(choices?.connections.map((c) => c.id));

  return (
    <Section title={t("capabilities.protocol")} hint={t("protocol.hint")} plain>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={outcome}
            onChange={setOutcome}
            label={t("protocol.filter.outcome")}
            options={[
              { id: "all", label: t("protocol.filter.all") },
              { id: "refused", label: t("protocol.filter.refused") },
              { id: "critical", label: t("protocol.filter.critical") },
              { id: "held", label: t("protocol.filter.held") },
            ]}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Select
            value={who}
            onChange={setWho}
            placeholder={t("protocol.filter.everyone")}
            options={WHO_KINDS.map((kind) => ({
              value: kind,
              label: t(`protocol.filter.who.${kind}`),
            }))}
          />
          <Select
            value={connection}
            onChange={setConnection}
            placeholder={t("protocol.filter.everyConnection")}
            options={(choices?.connections ?? []).map((c) => ({
              value: c.id,
              label: c.connector ? `${c.connector.name} · ${c.name}` : c.name,
            }))}
          />
          <Select
            value={range}
            onChange={(v) => setRange(v as Range)}
            options={(["hour", "day", "week", "month", "all"] as const).map((r) => ({
              value: r,
              label: t(`protocol.range.${r}`),
            }))}
          />
        </div>
        <SearchField
          value={text}
          onChange={setText}
          placeholder={t("protocol.search")}
          busy={log.isFetching && !log.isFetchingNextPage}
        />

        {log.error ? (
          <p className="text-[0.875rem] text-rose">{(log.error as Error).message}</p>
        ) : log.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner className="text-ink-3" />
          </div>
        ) : lines.length === 0 ? (
          <p className="py-12 text-center text-[0.9375rem] text-ink-3">
            {t(filtered ? "protocol.emptyFiltered" : "protocol.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((line) => (
              <li key={line.id}>
                <LogLine
                  line={line}
                  spaceId={spaceId}
                  open={open === line.id}
                  onToggle={() => setOpen(open === line.id ? null : line.id)}
                  ofSpace={spaceConnections.has(line.connectionId)}
                />
              </li>
            ))}
          </ul>
        )}
        {log.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="quiet"
              size="sm"
              busy={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              {t("protocol.more")}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

const TONE_ICON: Record<Tone, LucideIcon> = {
  done: CircleCheck,
  refused: CircleX,
  held: Clock,
  failed: TriangleAlert,
};

const TONE_CLASS: Record<Tone, string> = {
  done: "text-moss",
  refused: "text-rose",
  held: "text-ember",
  failed: "text-ink-3",
};

function time(at: string, long = false): string {
  return new Date(at).toLocaleString(lang, {
    dateStyle: long ? "medium" : "short",
    timeStyle: long ? "medium" : "short",
  });
}

/** One call: who, what, on which connection, where, what came of it; a click opens the detail. */
function LogLine({
  line,
  spaceId,
  open,
  onToggle,
  ofSpace,
}: {
  line: ProtocolLine;
  spaceId: string;
  open: boolean;
  onToggle: () => void;
  ofSpace: boolean;
}) {
  const result = outcomeOf(line);
  const Icon = TONE_ICON[result.tone];
  const where = whereWord(line);
  const loud = line.critical || result.tone === "refused";
  return (
    <div
      className={cn(
        "rounded-xl bg-card ring-1 transition",
        line.critical
          ? "ring-ember/50"
          : result.tone === "refused"
            ? "ring-rose/40"
            : "ring-border-soft",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3.5 py-3 text-left"
      >
        <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_CLASS[result.tone])} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[0.9375rem] text-ink leading-snug">
            <b className="font-medium">{whoWord(line.who)}</b>
            {" · "}
            {kindWord(line.kind)}: {actionWord(line)}
            {" · "}
            {connectionWord(line)}
          </span>
          <span className="text-[0.8125rem] text-ink-3 leading-snug">
            {time(line.at)}
            {where ? ` · ${where}` : ""}
            {" · "}
            <span className={cn(loud && TONE_CLASS[result.tone], loud && "font-medium")}>
              {result.text}
            </span>
          </span>
        </span>
        {line.critical ? (
          <span className="shrink-0">
            <Chip
              tone="ember"
              icon={<ShieldAlert className="size-3" />}
              title={criticalWord(line.criticalKind)}
            >
              {t("protocol.critical")}
            </Chip>
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "mt-0.5 size-4 shrink-0 text-ink-4 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? <LineDetail line={line} spaceId={spaceId} ofSpace={ofSpace} /> : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-[0.8125rem] text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-[0.875rem] text-ink-2">{children}</dd>
    </div>
  );
}

/** What a line holds beyond its words: sizes, the rule, the run's grant, where to go. */
function LineDetail({
  line,
  spaceId,
  ofSpace,
}: {
  line: ProtocolLine;
  spaceId: string;
  ofSpace: boolean;
}) {
  const detail = useQuery({
    queryKey: ["broker-line", spaceId, line.id],
    queryFn: () =>
      api.get<ProtocolLineDetail>(`/api/studio/spaces/${spaceId}/broker/log/${line.id}`),
  });
  const run = detail.data?.run;
  const input = line.input;
  const fields = Object.keys(input?.fields ?? {});
  const host = line.connectionId.startsWith("host:");
  return (
    <div className="border-border-soft border-t px-3.5 py-3">
      <dl className="grid gap-2">
        <Fact label={t("protocol.detail.when")}>
          {time(line.at, true)} · {t("protocol.detail.duration", { ms: line.durationMs })}
        </Fact>
        {line.critical ? (
          <Fact label={t("protocol.critical")}>{criticalWord(line.criticalKind)}</Fact>
        ) : null}
        <Fact label={t("protocol.detail.input")}>
          {fields.length
            ? t("protocol.detail.inputFields", {
                fields: fields.join(", "),
                size: input?.size ?? 0,
              })
            : t("protocol.detail.inputEmpty")}
          {input?.sample ? (
            <span className="mt-0.5 block font-mono text-[0.8125rem] text-ink-3">
              {input.sample}
            </span>
          ) : null}
        </Fact>
        <Fact label={t("protocol.detail.result")}>
          {line.resultSize === null
            ? t("protocol.detail.resultNone")
            : t("protocol.detail.resultSize", { size: line.resultSize })}
        </Fact>
        <Fact label={t("protocol.detail.rule")}>
          {ruleWord(line.rule)}
          {line.reason ? (
            <span className="mt-0.5 block text-[0.8125rem] text-ink-3">{line.reason}</span>
          ) : null}
        </Fact>
        {line.runId ? (
          <Fact label={t("protocol.detail.grant")}>
            {detail.isPending ? (
              <Spinner className="size-4 text-ink-3" />
            ) : ofSpace ? (
              t("protocol.detail.grantSpace")
            ) : !run?.grant ? (
              t("protocol.detail.grantNone")
            ) : host ? (
              run.grant.hosts.length ? (
                t("protocol.detail.grantHosts", { hosts: run.grant.hosts.join(", ") })
              ) : (
                t("protocol.detail.grantNoHosts")
              )
            ) : run.grant.actions?.length ? (
              t("protocol.detail.grantActions", { actions: run.grant.actions.join(", ") })
            ) : (
              t("protocol.detail.grantNoActions")
            )}
          </Fact>
        ) : null}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {line.runId && line.wizardId ? (
          <LinkButton to={`/edit/${line.wizardId}?run=${line.runId}`}>
            {t("protocol.detail.openRun")}
          </LinkButton>
        ) : null}
        {line.chatId ? (
          <LinkButton to={`/work/c/${line.chatId}`}>{t("protocol.detail.openChat")}</LinkButton>
        ) : null}
        {ofSpace ? (
          <LinkButton to={`/capabilities/connectors?show=${line.connectionId}`}>
            {t("protocol.detail.openConnection")}
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}

function LinkButton({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex h-8 items-center rounded-full bg-paper-2 px-3 font-medium text-[0.8125rem] text-ink transition hover:bg-paper-3 coarse:h-11 coarse:px-4"
    >
      {children}
    </Link>
  );
}

// --- „Was darf …?“ ------------------------------------------------------------------------------

/** Who the question is about: a person by id, or one of the callers without a name. */
type Asked = `person:${string}` | "guest" | "goose" | "step:guest" | "step:person";

function askParams(asked: Asked, choices: ProtocolChoices): { who: string; for?: string } {
  if (asked.startsWith("person:")) {
    const person = choices.people.find((p) => `person:${p.id}` === asked);
    return { who: person && person.role !== "member" ? "admin" : "person" };
  }
  if (asked.startsWith("step:")) {
    return { who: "step", for: asked.slice(5) };
  }
  return { who: asked };
}

function askedName(asked: Asked, choices: ProtocolChoices): string {
  if (asked.startsWith("person:")) {
    return choices.people.find((p) => `person:${p.id}` === asked)?.name ?? "";
  }
  return t(
    asked === "guest"
      ? "protocol.ask.who.guest"
      : asked === "goose"
        ? "protocol.ask.who.goose"
        : "protocol.ask.who.step",
  );
}

function Ask({ choices, spaceId }: { choices: ProtocolChoices | undefined; spaceId: string }) {
  const [asked, setAsked] = useState<Asked | "">("");
  const [connectionId, setConnectionId] = useState("");
  const [actionId, setActionId] = useState("");
  const [where, setWhere] = useState<"run" | "chat">("run");
  const connection = choices?.connections.find((c) => c.id === connectionId);
  const action = connection?.actions.find((a) => a.id === actionId);
  // A fixed step only calls in a run.
  const place = asked.startsWith("step:") ? "run" : where;
  const ready = Boolean(choices && asked && connection && action);

  const answer = useQuery({
    queryKey: ["broker-ask", spaceId, asked, connectionId, actionId, place],
    queryFn: () => {
      const query = new URLSearchParams({
        ...askParams(asked as Asked, choices as ProtocolChoices),
        resource: connectionId,
        action: actionId,
        in: place,
      });
      return api.get<BrokerAnswer>(`/api/studio/spaces/${spaceId}/broker/ask?${query}`);
    },
    enabled: ready,
  });

  if (!choices) {
    return (
      <div className="flex justify-center py-12">
        <Spinner className="text-ink-3" />
      </div>
    );
  }
  const whoOptions = [
    ...choices.people.map((p) => ({
      value: `person:${p.id}`,
      label: p.role === "member" ? p.name : t("protocol.who.adminNamed", { name: p.name }),
    })),
    { value: "guest", label: t("protocol.ask.who.guest") },
    { value: "goose", label: t("protocol.ask.who.goose") },
    { value: "step:guest", label: t("protocol.ask.who.stepGuest") },
    { value: "step:person", label: t("protocol.ask.who.stepPerson") },
  ];

  return (
    <Section title={t("protocol.ask.title")} hint={t("protocol.ask.hint")}>
      {choices.connections.length === 0 ? (
        <p className="text-[0.875rem] text-ink-3">{t("protocol.ask.noConnections")}</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labelled label={t("protocol.ask.who")}>
              <Select
                value={asked}
                onChange={(v) => setAsked(v as Asked)}
                placeholder={t("protocol.ask.choose")}
                options={whoOptions}
              />
            </Labelled>
            <Labelled label={t("protocol.ask.connection")}>
              <Select
                value={connectionId}
                onChange={(v) => {
                  setConnectionId(v);
                  setActionId("");
                }}
                placeholder={t("protocol.ask.choose")}
                options={choices.connections.map((c) => ({
                  value: c.id,
                  label: c.connector ? `${c.connector.name} · ${c.name}` : c.name,
                }))}
              />
            </Labelled>
            <Labelled label={t("protocol.ask.action")}>
              <Select
                value={actionId}
                onChange={setActionId}
                placeholder={t("protocol.ask.choose")}
                options={(connection?.actions ?? []).map((a) => ({
                  value: a.id,
                  label: `${a.name} (${kindWord(a.kind)})`,
                }))}
              />
            </Labelled>
            <Labelled label={t("protocol.ask.where")}>
              <Select
                value={place}
                onChange={(v) => setWhere(v as "run" | "chat")}
                options={[
                  { value: "run", label: t("protocol.ask.inRun") },
                  {
                    value: "chat",
                    label: t("protocol.ask.inChat"),
                    disabled: asked.startsWith("step:"),
                  },
                ]}
              />
            </Labelled>
          </div>
          <div className="rounded-xl bg-paper-2 px-4 py-3.5">
            {!ready ? (
              <p className="text-[0.875rem] text-ink-3">{t("protocol.ask.pick")}</p>
            ) : answer.error ? (
              <p className="text-[0.875rem] text-rose">{(answer.error as Error).message}</p>
            ) : !answer.data ? (
              <Spinner className="size-4 text-ink-3" />
            ) : (
              <AnswerText
                answer={answer.data}
                who={askedName(asked as Asked, choices)}
                connection={
                  connection
                    ? connection.connector
                      ? `${connection.connector.name} · ${connection.name}`
                      : connection.name
                    : ""
                }
                audience={connection?.audience}
              />
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function AnswerText({
  answer,
  who,
  connection,
  audience,
}: {
  answer: BrokerAnswer;
  who: string;
  connection: string;
  audience: string | undefined;
}) {
  const tone: Tone =
    answer.outcome === "allow" ? "done" : answer.outcome === "ask" ? "held" : "refused";
  const Icon = TONE_ICON[tone];
  return (
    <div className="flex items-start gap-3">
      <Icon className={cn("mt-1 size-4 shrink-0", TONE_CLASS[tone])} />
      <div className="grid min-w-0 gap-1.5">
        <p className="font-medium text-[0.9375rem] text-ink leading-snug">
          {answerSentence(answer, { who, connection, audience })}
        </p>
        <p className="text-[0.8125rem] text-ink-3">
          {t("protocol.ask.rule", { rule: ruleWord(answer.rule) })}
        </p>
        <div>
          <LinkButton to={`/capabilities/connectors?show=${answer.connection.id}`}>
            {t("protocol.ask.change")}
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="font-medium text-[0.8125rem] text-ink-2">{label}</span>
      {children}
    </div>
  );
}

// --- notifications -----------------------------------------------------------------------------

/** The space's `notify` setting (A7a): Work's bell and the hourly mail, changed in place. */
function Notify({ space }: { space: Space }) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notify = space.notify ?? { bell: true, mail: "hourly" };
  const save = async (next: SpaceNotify) => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/studio/spaces/${space.id}`, { notify: next });
      await qc.invalidateQueries({ queryKey: keys.spaces() });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const locked = space.readOnly || saving;
  return (
    <Section title={t("protocol.notify.title")} hint={t("protocol.notify.hint")}>
      <div className="flex flex-col gap-4">
        <NotifyRow
          label={t("protocol.notify.bell")}
          hint={t("protocol.notify.bellHint")}
          checked={notify.bell}
          disabled={locked}
          onChange={(bell) => void save({ ...notify, bell })}
        />
        <NotifyRow
          label={t("protocol.notify.mail")}
          hint={t("protocol.notify.mailHint")}
          checked={notify.mail === "hourly"}
          disabled={locked}
          onChange={(on) => void save({ ...notify, mail: on ? "hourly" : "off" })}
        />
        {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
      </div>
    </Section>
  );
}

function NotifyRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="font-medium text-[0.9375rem] text-ink">{label}</div>
        <div className="mt-0.5 text-[0.8125rem] text-ink-3">{hint}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}
