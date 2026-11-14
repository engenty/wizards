import { reachedByGuests } from "@engenty/wizards-shared/connectors";
import {
  RWX_ALL,
  RWX_ASK_KINDS,
  RWX_PERMS,
  type RwxAnswer,
  type RwxAskKind,
  type RwxChoices,
  type RwxFlag,
  type RwxPerm,
  type RwxResourceKind,
  type RwxRuleView,
  type RwxSubjectKind,
  rwxAsked,
} from "@engenty/wizards-shared/rwx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, CircleX, Minus, Plug, Plus, ShieldQuestion } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { type Key, t } from "../../lib/i18n";
import { useCurrentSpace, useIsAdmin } from "../../lib/session";
import { Button, Card, Chip, cn, Dialog, Select, Spinner, Switch, Tabs } from "../../ui";
import { Section } from "../space/Section";
import { useSpaceConnections } from "./ConnectorsSection";
import {
  KIND_WORDS,
  originLink,
  originWord,
  PERM_WORDS,
  RIGHTS,
  type RuleWords,
  ruleSentence,
  rulesSentence,
  saysOf,
} from "./rights-words";

/*
 * Fähigkeiten › Rechte (docs/plans/capabilities-next.md, piece 3): the one place where an admin
 * sees and changes who may read, change and run what in a space. On top, what the admins, the
 * members, the guests and the clients may do with everything of a kind: the start set. Below, the
 * exceptions as sentences, each with where it is set: one set here is removed here, one set in
 * Wissen, in Dateien or with „Für Kund:innen sichtbar“ leads there. Connections keep their own
 * rules on their page. Only what the runtime asks can be set (`RWX_ASKED`); it refuses the rest.
 */

type Opened = "ask" | "add";

const rulesKey = (spaceId: string) => ["rwx-rules", spaceId];

/** A subject as the rules name it. */
interface Subject {
  subjectKind: RwxSubjectKind;
  subjectId: string | null;
}

/** The rule about a subject and a resource: a space has at most one. */
const ruleAbout = (rules: RwxRuleView[], s: Subject, kind: RwxResourceKind, id: string) =>
  rules.find(
    (r) =>
      r.subjectKind === s.subjectKind &&
      (r.subjectId ?? null) === s.subjectId &&
      r.resourceKind === kind &&
      r.resourceId === id,
  );

export function RightsSection() {
  const [params, setParams] = useSearchParams();
  const { space } = useCurrentSpace();
  const admin = useIsAdmin();
  // Clients are in the organization's spaces: both switches.
  const clientSpaces = useFeature("clientSpaces");
  const orgSpaces = useFeature("orgSpaces");
  const clientsOn = clientSpaces && orgSpaces;
  const qc = useQueryClient();
  const spaceId = space?.id ?? "";
  const shown = params.get("show");
  const opened: Opened | null = shown === "ask" || shown === "add" ? shown : null;
  const open = (next: Opened | null) => setParams(next ? { show: next } : {}, { replace: true });

  const rules = useQuery({
    queryKey: rulesKey(spaceId),
    queryFn: () => api.get<{ rules: RwxRuleView[] }>(`/api/studio/spaces/${spaceId}/rules`),
    enabled: Boolean(space) && admin,
  });
  const choices = useQuery({
    queryKey: ["rwx-choices", spaceId],
    queryFn: () => api.get<RwxChoices>(`/api/studio/spaces/${spaceId}/rules/choices`),
    enabled: Boolean(space) && admin && opened !== null,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!(space && admin)) {
    return null;
  }
  const all = rules.data?.rules ?? [];
  const locked = space.readOnly;

  /** One change to one rule, then the list again; `what` marks what waits. */
  const change = async (what: string, run: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await run();
      await qc.invalidateQueries({ queryKey: rulesKey(space.id) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const path = `/api/studio/spaces/${space.id}/rules`;

  /** Sets one flag of the rule about a subject and a resource, as the page's forms do. */
  const setFlag = (
    s: Subject,
    kind: RwxResourceKind,
    id: string,
    perm: RwxPerm,
    flag: RwxFlag | null,
  ) => {
    const rule = ruleAbout(all, s, kind, id);
    if (!rule) {
      return flag
        ? api.post(path, { ...s, resourceKind: kind, resourceId: id, [perm]: flag })
        : Promise.resolve();
    }
    // A rule without a flag is no rule: taking its last one away removes it.
    const rest = RWX_PERMS.some((p) => p !== perm && rule[p] !== null);
    return flag || rest
      ? api.patch(`${path}/${rule.id}`, { [perm]: flag })
      : api.del(`${path}/${rule.id}`);
  };

  return (
    <div className="flex flex-col gap-9 pb-20">
      <Section
        title={t("capabilities.rights")}
        hint={t("rights.hint")}
        action={
          <Button variant="secondary" size="sm" onClick={() => open("ask")}>
            <ShieldQuestion className="size-4" /> {t("protocol.ask.title")}
          </Button>
        }
        plain
      >
        {rules.error ? (
          <p className="text-[0.875rem] text-rose">{(rules.error as Error).message}</p>
        ) : rules.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner className="text-ink-3" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="px-1">
              <h3 className="font-medium text-[0.9375rem] text-ink">{t("rights.start.title")}</h3>
              <p className="mt-0.5 text-[0.8125rem] text-ink-3">{t("rights.start.hint")}</p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {groupsOf(clientsOn).map((group) => (
                <StartGroup
                  key={group.id}
                  group={group}
                  rules={all}
                  locked={locked || busy !== null}
                  onSet={(kind, perm, on) =>
                    void change(`${group.id}:${kind}:${perm}`, () =>
                      setFlag(group.subjects[0], kind, RWX_ALL, perm, on ? "allow" : null),
                    )
                  }
                />
              ))}
            </div>
            <ul className="flex flex-col gap-1 px-1 text-[0.8125rem] text-ink-3 leading-snug">
              <li>{t("rights.ai")}</li>
              <li>{t("rights.note.goose")}</li>
              <li>{t("rights.note.wizard")}</li>
            </ul>
            {error ? <p className="px-1 text-[0.875rem] text-rose">{error}</p> : null}
          </div>
        )}
      </Section>

      {rules.data ? (
        <Section title={t("rights.exceptions.title")} hint={t("rights.exceptions.hint")} plain>
          <div className="flex flex-col gap-3">
            <Exceptions
              rules={all}
              locked={locked}
              busy={busy}
              onRemove={(rule) => void change(rule.id, () => api.del(`${path}/${rule.id}`))}
            />
            {/* Below the list, in its own row: beside the heading it would squeeze the hint on a phone. */}
            {locked ? null : (
              <div>
                <Button variant="secondary" size="sm" onClick={() => open("add")}>
                  <Plus className="size-4" /> {t("rights.exceptions.add")}
                </Button>
              </div>
            )}
          </div>
        </Section>
      ) : null}

      <ConnectionsRow spaceId={space.id} />

      <Dialog
        open={opened === "add"}
        onClose={() => open(null)}
        wide
        title={t("rights.exceptions.add")}
      >
        <AddException
          key={String(opened === "add")}
          choices={choices.data}
          rules={all}
          clients={clientsOn}
          onAdd={async (s, kind, id, perm, flag) => {
            await setFlag(s, kind, id, perm, flag);
            await qc.invalidateQueries({ queryKey: rulesKey(space.id) });
            open(null);
          }}
        />
      </Dialog>
      <Dialog
        open={opened === "ask"}
        onClose={() => open(null)}
        wide
        title={t("protocol.ask.title")}
      >
        <p className="-mt-2 mb-4 text-[0.875rem] text-ink-3">{t("rights.ask.hint")}</p>
        <Ask choices={choices.data} spaceId={space.id} />
      </Dialog>
    </div>
  );
}

// --- who may what -------------------------------------------------------------------------------

interface Group {
  id: "admins" | "members" | "guests" | "clients";
  label: Key;
  hint: Key;
  /** Whom its rules name. The admins are two roles, and may what both may. */
  subjects: Subject[];
  /** Its rights are not changed here. */
  fixed?: boolean;
}

const role = (id: string): Subject => ({ subjectKind: "role", subjectId: id });

function groupsOf(clients: boolean): Group[] {
  return [
    {
      id: "admins",
      label: "rights.group.admins",
      hint: "rights.group.adminsHint",
      subjects: [role("admin"), role("owner")],
      fixed: true,
    },
    {
      id: "members",
      label: "rights.group.members",
      hint: "rights.group.membersHint",
      subjects: [role("member")],
    },
    {
      id: "guests",
      label: "rights.group.guests",
      hint: "audience.guestsHint",
      subjects: [{ subjectKind: "guest", subjectId: null }],
    },
    ...(clients
      ? [
          {
            id: "clients" as const,
            label: "rights.group.clients" as const,
            hint: "audience.clientsHint" as const,
            subjects: [role("client")],
          },
        ]
      : []),
  ];
}

/**
 * What one group may do with everything of a kind: a row per right the runtime asks for it, with
 * a switch where it can be changed. Off is no rule: an exception can still allow it.
 */
function StartGroup({
  group,
  rules,
  locked,
  onSet,
}: {
  group: Group;
  rules: RwxRuleView[];
  locked: boolean;
  onSet: (kind: RwxResourceKind, perm: RwxPerm, on: boolean) => void;
}) {
  const first = group.subjects[0];
  const rows = RIGHTS.filter((r) => rwxAsked(first.subjectKind, r.kind, r.perm, first.subjectId));
  const flagOf = (kind: RwxResourceKind, perm: RwxPerm): RwxFlag | null => {
    const flags = group.subjects.map((s) => ruleAbout(rules, s, kind, RWX_ALL)?.[perm] ?? null);
    return flags.includes("deny") ? "deny" : flags.every((f) => f === "allow") ? "allow" : null;
  };
  return (
    <Card className="p-3.5 sm:p-4">
      <div className="mb-2.5">
        <h4 className="font-medium text-[0.9375rem] text-ink">{t(group.label)}</h4>
        <p className="text-[0.8125rem] text-ink-3 leading-snug">{t(group.hint)}</p>
      </div>
      <ul className="flex flex-col divide-y divide-border-soft">
        {rows.map((row) => {
          const flag = flagOf(row.kind, row.perm);
          const label = t(group.id === "clients" && row.client ? row.client : row.label);
          return (
            <li
              key={`${row.kind}:${row.perm}`}
              className="flex min-h-11 items-center justify-between gap-3 py-1.5"
            >
              <span
                className={cn(
                  "min-w-0 text-[0.875rem] leading-snug",
                  flag === "allow" ? "text-ink" : "text-ink-3",
                )}
              >
                {label}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {flag === "deny" ? (
                  <Chip tone="warn" title={t("rights.neverHint")}>
                    {t("rights.never")}
                  </Chip>
                ) : null}
                {group.fixed ? (
                  flag === "allow" ? (
                    <Check className="size-4 text-moss" aria-hidden />
                  ) : (
                    <Minus className="size-4 text-ink-4" aria-hidden />
                  )
                ) : (
                  <Switch
                    checked={flag === "allow"}
                    disabled={locked}
                    onChange={(on) => onSet(row.kind, row.perm, on)}
                    label={`${t(group.label)}: ${label}`}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// --- the exceptions ----------------------------------------------------------------------------

const ORIGIN_ORDER = ["rights", "folder", "clients", "mount", "start"] as const;

/** One line of the exceptions: a rule, or the rules another place set that say the same about one thing. */
interface Exception {
  rules: RwxRuleView[];
  sentence: string;
}

/**
 * The rules that are not the start set, as sentences with where each is set. A rule set here
 * stands alone, to be removed alone; what Wissen, Dateien or the clients' switch wrote about one
 * thing in the same words is one sentence („Admins, Mitglieder und jeder Wizard dürfen …“). The
 * owners' rule beside the same one for the admins says nothing more, and is left out.
 */
function exceptionsOf(rules: RwxRuleView[]): Exception[] {
  const flags = (r: RwxRuleView) => `${r.r}|${r.w}|${r.x}`;
  const groups = new Map<string, RwxRuleView[]>();
  for (const r of rules) {
    if (r.origin === "start") {
      continue;
    }
    if (r.subjectKind === "role" && r.subjectId === "owner") {
      const admins = ruleAbout(rules, role("admin"), r.resourceKind, r.resourceId);
      if (admins && flags(admins) === flags(r)) {
        continue;
      }
    }
    const key = r.origin === "rights" ? r.id : `${r.origin}\u0000${saysOf(r)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()]
    .map((group) => ({ rules: group, sentence: rulesSentence(group) }))
    .sort(
      (a, b) =>
        ORIGIN_ORDER.indexOf(a.rules[0].origin) - ORIGIN_ORDER.indexOf(b.rules[0].origin) ||
        a.sentence.localeCompare(b.sentence),
    );
}

function Exceptions({
  rules,
  locked,
  busy,
  onRemove,
}: {
  rules: RwxRuleView[];
  locked: boolean;
  busy: string | null;
  onRemove: (rule: RwxRuleView) => void;
}) {
  const shown = exceptionsOf(rules);
  if (!shown.length) {
    return <p className="px-1 py-4 text-[0.9375rem] text-ink-3">{t("rights.exceptions.empty")}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {shown.map(({ rules: [rule], sentence }) => {
        const link = originLink(rule);
        return (
          <li
            key={rule.id}
            className="flex flex-col gap-2.5 rounded-xl bg-card px-3.5 py-3 ring-1 ring-border-soft sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <span className="grid min-w-0 gap-0.5">
              <span className="text-[0.9375rem] text-ink leading-snug">{sentence}</span>
              <span className="text-[0.8125rem] text-ink-3 leading-snug">
                {originWord(rule.origin)}
              </span>
            </span>
            <span className="shrink-0">
              {link ? (
                <LinkButton to={link}>{t("rights.exceptions.change")}</LinkButton>
              ) : locked ? null : (
                <Button
                  variant="quiet"
                  size="sm"
                  busy={busy === rule.id}
                  disabled={busy !== null}
                  onClick={() => onRemove(rule)}
                >
                  {t("rights.exceptions.remove")}
                </Button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** `onPaper`: it stands on a grey box, and takes the card's colour to show. */
function LinkButton({
  to,
  onPaper,
  children,
}: {
  to: string;
  onPaper?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex h-8 items-center rounded-full px-3 font-medium text-[0.8125rem] text-ink transition coarse:h-11 coarse:px-4",
        onPaper ? "bg-card ring-1 ring-border-soft hover:bg-paper" : "bg-paper-2 hover:bg-paper-3",
      )}
    >
      {children}
    </Link>
  );
}

// --- connections -------------------------------------------------------------------------------

/** Connections are not among these rules: how many the space has, how many guests reach, and the way there. */
function ConnectionsRow({ spaceId }: { spaceId: string }) {
  const connections = useSpaceConnections(spaceId).data?.connections;
  const reached = connections?.filter(reachedByGuests).length ?? 0;
  return (
    <Card className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Plug className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <div className="grid min-w-0 gap-0.5">
          <h3 className="font-medium text-[0.9375rem] text-ink">{t("rights.connections.title")}</h3>
          <p className="text-[0.8125rem] text-ink-3 leading-snug">
            {t("rights.connections.hint")}{" "}
            {connections === undefined
              ? ""
              : connections.length === 0
                ? t("rights.connections.none")
                : `${t("rights.connections.count", { n: connections.length })} ${
                    reached
                      ? t("rights.connections.guests", { n: reached })
                      : t("rights.connections.noGuests")
                  }`}
          </p>
        </div>
      </div>
      <span className="shrink-0">
        <LinkButton to="/capabilities/connectors">{t("rights.connections.open")}</LinkButton>
      </span>
    </Card>
  );
}

// --- the forms' parts --------------------------------------------------------------------------

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="font-medium text-[0.8125rem] text-ink-2">{label}</span>
      {children}
    </div>
  );
}

function Waiting() {
  return (
    <div className="flex justify-center py-12">
      <Spinner className="text-ink-3" />
    </div>
  );
}

/** What a form can name of a kind: the space's documents, pages, tables, wizards or skills. */
function itemsOf(choices: RwxChoices, kind: RwxResourceKind) {
  switch (kind) {
    case "document":
      return choices.documents;
    case "page":
      return choices.pages;
    case "table":
      return choices.tables;
    case "wizard":
    case "data":
      return choices.wizards;
    case "skill":
      return choices.skills;
    default:
      return [];
  }
}

/** A resource picked in a form, as a sentence names it. */
function namedResource(
  choices: RwxChoices,
  kind: RwxResourceKind,
  id: string,
): Pick<RuleWords, "resourceKind" | "resourceId" | "resourceName" | "folder"> {
  const item = itemsOf(choices, kind).find((i) => i.id === id);
  return {
    resourceKind: kind,
    resourceId: id,
    resourceName: item?.name ?? null,
    folder: kind === "page" && Boolean(choices.pages.find((p) => p.id === id)?.folder),
  };
}

/** A rule's flags with one of them set, the others unset. */
const oneFlag = (perm: RwxPerm, flag: RwxFlag): Pick<RuleWords, "r" | "w" | "x"> => ({
  r: perm === "r" ? flag : null,
  w: perm === "w" ? flag : null,
  x: perm === "x" ? flag : null,
});

// --- „Ausnahme hinzufügen“ ----------------------------------------------------------------------

/** Whom an exception can be about. The admins' rights are fixed. */
type AddWho = "members" | "guests" | "clients" | "person" | "goose" | "agent" | "wizard" | "plugin";

const ADD_SUBJECT: Record<AddWho, RwxSubjectKind> = {
  members: "role",
  guests: "guest",
  clients: "role",
  person: "person",
  goose: "goose",
  agent: "agent",
  wizard: "wizard",
  plugin: "plugin",
};

const ADD_WHO_WORDS: Record<AddWho, Key> = {
  members: "rights.who.members",
  guests: "rights.who.guests",
  clients: "rights.who.clients",
  person: "rights.subject.person",
  goose: "rights.subject.goose",
  agent: "rights.who.agent",
  wizard: "rights.subject.wizard",
  plugin: "rights.subject.plugin",
};

/** The kinds an exception can name: what one rule decides. A mount's rules are its form's. */
const ADD_KINDS = RWX_ASK_KINDS;

function AddException({
  choices,
  rules,
  clients,
  onAdd,
}: {
  choices: RwxChoices | undefined;
  rules: RwxRuleView[];
  clients: boolean;
  onAdd: (
    s: Subject,
    kind: RwxResourceKind,
    id: string,
    perm: RwxPerm,
    flag: RwxFlag,
  ) => Promise<void>;
}) {
  const [who, setWho] = useState<AddWho | "">("");
  const [whoId, setWhoId] = useState("");
  const [flag, setFlag] = useState<RwxFlag>("deny");
  const [perm, setPerm] = useState<RwxPerm | "">("");
  const [kind, setKind] = useState<RwxAskKind | "">("");
  const [itemId, setItemId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!choices) {
    return <Waiting />;
  }
  const subjectKind = who ? ADD_SUBJECT[who] : null;
  // A role's or the guests' rule on all of a kind is the start set: set above, not here.
  const group = who === "members" || who === "guests" || who === "clients";
  const named =
    who === "person" || who === "goose"
      ? choices.people
      : who === "wizard"
        ? choices.wizards
        : who === "plugin"
          ? choices.plugins
          : null;
  const subject: Subject | null = !subjectKind
    ? null
    : who === "members"
      ? role("member")
      : who === "clients"
        ? role("client")
        : named
          ? whoId
            ? { subjectKind, subjectId: whoId }
            : null
          : { subjectKind, subjectId: null };
  const kindsFor = (p: RwxPerm) =>
    ADD_KINDS.filter(
      (k) =>
        subjectKind &&
        rwxAsked(subjectKind, k, p, who === "clients" ? "client" : null) &&
        !(group && k === "setup"),
    );
  const perms = RWX_PERMS.filter((p) => kindsFor(p).length > 0);
  const kinds = perm ? kindsFor(perm) : [];
  const resourceId = kind === "setup" ? RWX_ALL : itemId;
  const ready = Boolean(subject && perm && kind && resourceId);
  const words: RuleWords | null =
    subject && perm && kind && resourceId
      ? {
          ...subject,
          subjectName: named?.find((n) => n.id === subject.subjectId)?.name ?? null,
          ...namedResource(choices, kind, resourceId),
          ...oneFlag(perm, flag),
        }
      : null;
  const there = subject && kind && resourceId ? ruleAbout(rules, subject, kind, resourceId) : null;

  const add = async () => {
    if (!(subject && perm && kind && resourceId)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd(subject, kind, resourceId, perm, flag);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label={t("rights.add.who")}>
          <Select
            value={who}
            onChange={(v) => {
              setWho(v as AddWho);
              setWhoId("");
              setPerm("");
              setKind("");
              setItemId("");
            }}
            placeholder={t("protocol.ask.choose")}
            options={(Object.keys(ADD_SUBJECT) as AddWho[])
              .filter((w) => clients || w !== "clients")
              .map((w) => ({ value: w, label: t(ADD_WHO_WORDS[w]) }))}
          />
        </Labelled>
        {named ? (
          <Labelled label={t(who === "goose" ? "rights.add.whom" : "rights.add.which")}>
            <Select
              value={whoId}
              onChange={setWhoId}
              placeholder={t("protocol.ask.choose")}
              options={[
                ...(who === "wizard"
                  ? [{ value: RWX_ALL, label: t("rights.who.everyWizard") }]
                  : []),
                ...named.map((n) => ({ value: n.id, label: n.name })),
              ]}
            />
          </Labelled>
        ) : null}
        <div className="sm:col-span-2">
          <Tabs
            value={flag}
            onChange={setFlag}
            label={t("rights.add.allow")}
            options={[
              { id: "deny", label: t("rights.add.mayNot") },
              { id: "allow", label: t("rights.add.may") },
            ]}
          />
        </div>
        <Labelled label={t("rights.add.perm")}>
          <Select
            value={perm}
            onChange={(v) => {
              setPerm(v as RwxPerm);
              setKind("");
              setItemId("");
            }}
            placeholder={t("protocol.ask.choose")}
            options={perms.map((p) => ({ value: p, label: t(PERM_WORDS[p]) }))}
          />
        </Labelled>
        <Labelled label={t("rights.add.kind")}>
          <Select
            value={kind}
            onChange={(v) => {
              setKind(v as RwxAskKind);
              setItemId("");
            }}
            placeholder={t("protocol.ask.choose")}
            options={kinds.map((k) => ({ value: k, label: t(KIND_WORDS[k] as Key) }))}
          />
        </Labelled>
        {kind && kind !== "setup" ? (
          <Labelled label={t("rights.add.item")}>
            <Select
              value={itemId}
              onChange={setItemId}
              placeholder={t("protocol.ask.choose")}
              options={[
                ...(group ? [] : [{ value: RWX_ALL, label: t("rights.add.every") }]),
                ...itemsOf(choices, kind).map((i) => ({ value: i.id, label: i.name })),
              ]}
            />
          </Labelled>
        ) : null}
      </div>
      <div className="rounded-xl bg-paper-2 px-4 py-3.5">
        {words ? (
          <div className="grid gap-1">
            <p className="font-medium text-[0.9375rem] text-ink leading-snug">
              {ruleSentence(words)}
            </p>
            {there ? <p className="text-[0.8125rem] text-ink-3">{t("rights.add.exists")}</p> : null}
          </div>
        ) : (
          <p className="text-[0.875rem] text-ink-3">
            {t(group ? "rights.add.forAll" : "rights.add.pick")}
          </p>
        )}
      </div>
      {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
      <div className="flex justify-end">
        <Button onClick={() => void add()} disabled={!ready} busy={busy}>
          {t("rights.add.save")}
        </Button>
      </div>
    </div>
  );
}

// --- „Was darf …?“ for content ------------------------------------------------------------------

type AskWho = "person" | "guest" | "goose" | "agent" | "wizard" | "plugin";

const ASK_WHO_WORDS: Record<AskWho, Key> = {
  person: "rights.subject.person",
  guest: "rights.subject.guest",
  goose: "rights.subject.goose",
  agent: "rights.subject.agentFor",
  wizard: "rights.subject.wizard",
  plugin: "rights.subject.plugin",
};

/** A wizard's run is held for a guest unless a person is named. */
const GUEST = "guest";

function Ask({ choices, spaceId }: { choices: RwxChoices | undefined; spaceId: string }) {
  const [who, setWho] = useState<AskWho | "">("");
  const [whoId, setWhoId] = useState("");
  const [runFor, setRunFor] = useState(GUEST);
  const [perm, setPerm] = useState<RwxPerm | "">("");
  const [kind, setKind] = useState<RwxAskKind | "">("");
  const [itemId, setItemId] = useState("");

  const needsId = who !== "" && who !== "guest";
  const ready = Boolean(
    choices && who && (!needsId || whoId) && perm && kind && (kind === "setup" || itemId),
  );
  const answer = useQuery({
    queryKey: ["rwx-ask", spaceId, who, whoId, runFor, perm, kind, itemId],
    queryFn: () => {
      const query = new URLSearchParams({ who, resource: kind, perm });
      if (needsId) {
        query.set("id", whoId);
      }
      if (who === "wizard" && runFor !== GUEST) {
        query.set("for", runFor);
      }
      if (kind !== "setup") {
        query.set("resourceId", itemId);
      }
      return api.get<RwxAnswer>(`/api/studio/spaces/${spaceId}/rules/ask?${query}`);
    },
    enabled: ready,
  });

  if (!choices) {
    return <Waiting />;
  }
  const named =
    who === "person" || who === "goose" || who === "agent"
      ? choices.people
      : who === "wizard"
        ? choices.wizards
        : who === "plugin"
          ? choices.plugins
          : null;
  const kindsFor = (p: RwxPerm) => RWX_ASK_KINDS.filter((k) => who && rwxAsked(who, k, p));
  const perms = RWX_PERMS.filter((p) => kindsFor(p).length > 0);
  const kinds = perm ? kindsFor(perm) : [];
  const name = named?.find((n) => n.id === whoId)?.name ?? "";
  const person = choices.people.find((p) => p.id === runFor)?.name ?? "";
  /** Who is asked about, as the answer's sentence starts. */
  const asked =
    who === "guest"
      ? t("protocol.who.guest")
      : who === "goose"
        ? t("rights.who.goose", { name })
        : who === "agent"
          ? t("rights.who.agentFor", { name })
          : who === "wizard"
            ? runFor === GUEST
              ? t("rights.who.runGuest", { name })
              : t("rights.who.runFor", { name, person })
            : who === "plugin"
              ? t("rights.who.pluginJob", { name })
              : name;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label={t("rights.add.who")}>
          <Select
            value={who}
            onChange={(v) => {
              setWho(v as AskWho);
              setWhoId("");
              setPerm("");
              setKind("");
              setItemId("");
            }}
            placeholder={t("protocol.ask.choose")}
            options={(Object.keys(ASK_WHO_WORDS) as AskWho[]).map((w) => ({
              value: w,
              label: t(ASK_WHO_WORDS[w]),
            }))}
          />
        </Labelled>
        {named ? (
          <Labelled
            label={t(who === "goose" || who === "agent" ? "rights.add.whom" : "rights.add.which")}
          >
            <Select
              value={whoId}
              onChange={setWhoId}
              placeholder={t("protocol.ask.choose")}
              options={named.map((n) => ({ value: n.id, label: n.name }))}
            />
          </Labelled>
        ) : null}
        {who === "wizard" ? (
          <Labelled label={t("rights.ask.runFor")}>
            <Select
              value={runFor}
              onChange={setRunFor}
              options={[
                { value: GUEST, label: t("rights.subject.guest") },
                ...choices.people.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </Labelled>
        ) : null}
        <Labelled label={t("rights.add.perm")}>
          <Select
            value={perm}
            onChange={(v) => {
              setPerm(v as RwxPerm);
              setKind("");
              setItemId("");
            }}
            placeholder={t("protocol.ask.choose")}
            options={perms.map((p) => ({ value: p, label: t(PERM_WORDS[p]) }))}
          />
        </Labelled>
        <Labelled label={t("rights.add.kind")}>
          <Select
            value={kind}
            onChange={(v) => {
              setKind(v as RwxAskKind);
              setItemId("");
            }}
            placeholder={t("protocol.ask.choose")}
            options={kinds.map((k) => ({ value: k, label: t(KIND_WORDS[k] as Key) }))}
          />
        </Labelled>
        {kind && kind !== "setup" ? (
          <Labelled label={t("rights.add.item")}>
            <Select
              value={itemId}
              onChange={setItemId}
              placeholder={t("protocol.ask.choose")}
              options={itemsOf(choices, kind).map((i) => ({ value: i.id, label: i.name }))}
            />
          </Labelled>
        ) : null}
      </div>
      <div className="rounded-xl bg-paper-2 px-4 py-3.5">
        {!(ready && who && perm && kind) ? (
          <p className="text-[0.875rem] text-ink-3">{t("rights.ask.pick")}</p>
        ) : answer.error ? (
          <p className="text-[0.875rem] text-rose">{(answer.error as Error).message}</p>
        ) : !answer.data ? (
          <Spinner className="size-4 text-ink-3" />
        ) : (
          <AnswerText
            answer={answer.data}
            job={who === "plugin"}
            sentence={ruleSentence(
              {
                subjectKind: who,
                subjectId: needsId ? whoId : null,
                subjectName: name || null,
                ...namedResource(choices, kind, kind === "setup" ? RWX_ALL : itemId),
                ...oneFlag(perm, answer.data.ok ? "allow" : "deny"),
              },
              { text: asked, many: false },
            )}
          />
        )}
      </div>
      <p className="text-[0.8125rem] text-ink-3">
        <Link to="/capabilities/protocol?show=ask" className="underline underline-offset-2">
          {t("rights.ask.connections")}
        </Link>
      </p>
    </div>
  );
}

/** The answer in a sentence, and the rule that decided with where it is set. */
function AnswerText({
  answer,
  sentence,
  job,
}: {
  answer: RwxAnswer;
  sentence: string;
  /** A plugin's own job, which reads as the runtime itself. */
  job: boolean;
}) {
  const Icon = answer.ok ? CircleCheck : CircleX;
  const link = answer.rule ? originLink(answer.rule) : null;
  return (
    <div className="flex items-start gap-3">
      <Icon className={cn("mt-1 size-4 shrink-0", answer.ok ? "text-moss" : "text-rose")} />
      <div className="grid min-w-0 gap-1.5">
        <p className="font-medium text-[0.9375rem] text-ink leading-snug">{sentence}</p>
        {answer.rule ? (
          <p className="text-[0.8125rem] text-ink-3 leading-snug">
            {t("rights.ask.decided", { rule: ruleSentence(answer.rule) })}{" "}
            {originWord(answer.rule.origin)}
          </p>
        ) : (
          <p className="text-[0.8125rem] text-ink-3 leading-snug">
            {t(answer.ok && job ? "rights.ask.runtime" : "rights.ask.noRule")}
          </p>
        )}
        {link ? (
          <div>
            <LinkButton to={link} onPaper>
              {t("rights.exceptions.change")}
            </LinkButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}
