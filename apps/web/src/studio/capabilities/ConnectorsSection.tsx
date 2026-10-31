import {
  CONNECTION_ACTION_KINDS,
  CONNECTION_AUDIENCES,
  CONNECTION_LIMITS,
  CONNECTION_OUTCOMES,
  type ConnectionActionKind,
  type ConnectionAudience,
  type ConnectionOutcome,
  type ConnectionSignIn,
  type ConnectorView,
  type SpaceConnectionView,
} from "@engenty/wizards-shared/connectors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, LayoutGrid, Plus, UserRound } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { type Key, lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { initialsOf, useCurrentSpace, useIsAdmin } from "../../lib/session";
import { Button, Card, Chip, cn, Empty, Input, Label, Select, Tabs } from "../../ui";
import { scrollRoot } from "../AppFrame";
import { Connectors } from "../Connectors";
import { SignInButtons, SignInPanel, useConnectedMessage, useSignIn } from "../connection-sign-in";
import { MenuGroup, MenuRow, SubMenu, useDetail, useSettingsMenu } from "../settings-menu";
import { Section } from "../space/Section";

/*
 * Fähigkeiten › Connectors (docs/plans/capabilities.md, "Connections"): the space's connections
 * under „Im Space“, the built-in connectors as names, and the imported ones with the registry
 * search below. A connection opens with `?show=<id>`; `?setup=<connector id or domain>` opens the
 * setup with that connector chosen. Admins set up and change; a member reads the connections
 * open to them and signs in where each person does.
 */

const connectionsKey = (spaceId: string) => ["space-connections", spaceId] as const;

interface ConnectionsList {
  connections: SpaceConnectionView[];
}

/** The space's connections, the ones open to this person. */
export function useSpaceConnections(spaceId: string) {
  return useQuery({
    enabled: Boolean(spaceId),
    queryKey: connectionsKey(spaceId),
    queryFn: () => api.get<ConnectionsList>(`/api/studio/spaces/${spaceId}/connections`),
  });
}

/** The connectors a connection can be set up with: built in and imported. */
export function useConnectors(spaceId: string) {
  return useQuery({
    enabled: Boolean(spaceId),
    queryKey: keys.connectors(spaceId),
    queryFn: () => api.get<ConnectorView[]>(`/api/studio/spaces/${spaceId}/connectors`),
  });
}

/** The built-in connectors no connection of the space uses yet: a quiet line of names. */
export function unusedBuiltins(
  connectors: ConnectorView[],
  connections: SpaceConnectionView[],
  unsetConnectors: boolean,
): ConnectorView[] {
  const used = new Set(connections.map((c) => c.connectorId));
  return connectors.filter(
    (c) => c.sourceKind === "builtin" && !used.has(c.id) && (c.usable || unsetConnectors),
  );
}

const AUDIENCE_LABEL: Record<ConnectionAudience, Key> = {
  admins: "connection.audience.admins",
  members: "connection.audience.members",
  all: "connection.audience.all",
};

const AUDIENCE_HINT: Record<ConnectionAudience, Key> = {
  admins: "connection.audience.adminsHint",
  members: "connection.audience.membersHint",
  all: "connection.audience.allHint",
};

const KIND_LABEL: Record<ConnectionActionKind, Key> = {
  read: "connection.kind.read",
  write: "connection.kind.write",
  destructive: "connection.kind.destructive",
  send: "connection.kind.send",
};

const KIND_HINT: Record<ConnectionActionKind, Key> = {
  read: "connection.kind.readHint",
  write: "connection.kind.writeHint",
  destructive: "connection.kind.destructiveHint",
  send: "connection.kind.sendHint",
};

const OUTCOME_LABEL: Record<ConnectionOutcome, Key> = {
  allow: "connection.outcome.allow",
  ask: "connection.outcome.ask",
  deny: "connection.outcome.deny",
};

const SIGN_IN_LABEL: Record<ConnectionSignIn, Key> = {
  space: "connection.signIn.space",
  person: "connection.signIn.person",
};

const SIGN_IN_HINT: Record<ConnectionSignIn, Key> = {
  space: "connection.signIn.spaceHint",
  person: "connection.signIn.personHint",
};

const day = (iso: string) =>
  new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(iso));

/** „vor 2 Stunden“: how long ago, in the largest unit that fits. */
function ago(iso: string): string {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return format.format(0, "minute");
}

/** What it is: the connector's name, and the connection's where it says more. */
function titleOf(c: SpaceConnectionView): string {
  const connector = c.connector?.name ?? c.connectorId;
  return c.name === connector ? c.name : `${connector} · ${c.name}`;
}

/** How it signs in, in a few words: as the space with its account, or how many people did. */
function signInLine(c: SpaceConnectionView): string {
  if (c.signIn === "space") {
    return c.account
      ? t("connection.asSpaceAccount", { label: c.account.label })
      : t("connection.asSpaceNotYet");
  }
  return t("connection.eachPersonCount", { n: c.signedIn });
}

function lastUse(c: SpaceConnectionView): string {
  return c.lastUsedAt
    ? t("connection.lastUsed", { when: ago(c.lastUsedAt) })
    : t("connection.neverUsed");
}

/** The second label of a domain: `hubspot` in `api.hubspot.com`. */
function serviceOf(domain: string): string {
  const parts = domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(".");
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

/**
 * What `?setup=` names: a connector by its id, an imported one by its domain, a built-in one by
 * the service in the domain (`hubspot.com` → HubSpot); else the registry's service to import.
 */
function resolveSetup(
  value: string,
  connectors: ConnectorView[],
): { connectorId: string } | { domain: string } | null {
  if (!value) {
    return null;
  }
  const byId = connectors.find((c) => c.id === value);
  if (byId) {
    return { connectorId: byId.id };
  }
  const byDomain = connectors.find((c) => c.domain && c.domain === value.toLowerCase());
  if (byDomain) {
    return { connectorId: byDomain.id };
  }
  const service = serviceOf(value);
  const builtin = connectors.find(
    (c) =>
      c.sourceKind === "builtin" &&
      (c.id === service || c.id.endsWith(`-${service}`) || c.name.toLowerCase() === service),
  );
  if (builtin) {
    return { connectorId: builtin.id };
  }
  return value.includes(".") ? { domain: value } : null;
}

/** The connector's initials in a square, as the person's menu draws them. */
function Logo({ name, large }: { name: string; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-paper-2 font-semibold text-ink-2",
        large ? "size-12 text-[0.9375rem]" : "size-9 text-[0.75rem]",
      )}
    >
      {initialsOf(name) || "?"}
    </span>
  );
}

export function ConnectorsSection() {
  const [params, setParams] = useSearchParams();
  const { space } = useCurrentSpace();
  const admin = useIsAdmin();
  const { narrow } = useSettingsMenu();
  const qc = useQueryClient();
  const spaceId = space?.id ?? "";
  const show = params.get("show");
  const setup = params.get("setup");
  const writable = admin && !space?.readOnly;
  const connections = useSpaceConnections(spaceId);
  const connectors = useConnectors(spaceId);
  const list = connections.data?.connections ?? [];
  const picked = list.find((c) => c.id === show) ?? null;
  useDetail(picked ? titleOf(picked) : null);
  useConnectedMessage(
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["space-connections"] });
      void qc.invalidateQueries({ queryKey: ["person-sign-ins"] });
    }, [qc]),
  );

  // What is picked takes the page's place: it starts at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pick is what scrolls up.
  useEffect(() => {
    if (!narrow) {
      scrollRoot().scrollTo({ top: 0 });
    }
  }, [narrow, show]);

  // On a phone a step deeper, beside the menu in place.
  const pick = (id: string) =>
    narrow
      ? setParams({ show: id })
      : setParams(id === "all" ? {} : { show: id }, { replace: true });
  const startSetup = (connectorId: string) => {
    setParams({ setup: connectorId }, { replace: !narrow });
    if (!narrow) {
      scrollRoot().scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <>
      <SubMenu>
        <ul className="flex flex-col gap-0.5">
          <MenuRow
            icon={LayoutGrid}
            label={t("capabilities.connectors.all")}
            selected={!(narrow || show)}
            onPick={() => pick("all")}
          />
          {list.map((c) => (
            <MenuRow
              key={c.id}
              icon={c.signIn === "space" ? Building2 : UserRound}
              label={titleOf(c)}
              selected={!narrow && show === c.id}
              onPick={() => pick(c.id)}
            />
          ))}
        </ul>
        {writable ? (
          <MenuGroup label={t("capabilities.connectors.more")}>
            <MenuRow
              icon={Plus}
              label={t("capabilities.connectors.add")}
              selected={false}
              onPick={() => startSetup("")}
            />
          </MenuGroup>
        ) : null}
      </SubMenu>
      {space ? (
        <div className="flex flex-col gap-9 pb-20">
          {picked ? (
            <ConnectionPage
              key={picked.id}
              connection={picked}
              connector={connectors.data?.find((c) => c.id === picked.connectorId)}
              writable={writable}
              onGone={() => pick("all")}
            />
          ) : (
            <Overview
              spaceId={space.id}
              connections={list}
              loading={connections.isPending}
              error={connections.error as Error | null}
              connectors={connectors.data ?? []}
              writable={writable}
              setup={setup}
              onOpen={pick}
              onSetUp={startSetup}
              onSetUpDone={() => setParams({}, { replace: true })}
            />
          )}
        </div>
      ) : null}
    </>
  );
}

function Overview({
  spaceId,
  connections,
  loading,
  error,
  connectors,
  writable,
  setup,
  onOpen,
  onSetUp,
  onSetUpDone,
}: {
  spaceId: string;
  connections: SpaceConnectionView[];
  loading: boolean;
  error: Error | null;
  connectors: ConnectorView[];
  writable: boolean;
  setup: string | null;
  onOpen: (id: string) => void;
  onSetUp: (connectorId: string) => void;
  onSetUpDone: () => void;
}) {
  const unsetConnectors = useFeature("unsetConnectors");
  const more = useRef<HTMLDivElement>(null);
  const resolved = setup && connectors.length ? resolveSetup(setup, connectors) : null;
  const domain = resolved && "domain" in resolved ? resolved.domain : null;
  // A service still to import: the registry's part below opens it.
  useEffect(() => {
    if (domain) {
      more.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [domain]);
  const builtin = unusedBuiltins(connectors, connections, unsetConnectors);
  return (
    <>
      <Section
        title={t("capabilities.connectors")}
        hint={t("capabilities.connectors.hint")}
        plain
        action={
          writable && setup === null ? (
            <Button size="sm" onClick={() => onSetUp("")}>
              <Plus className="size-4" /> {t("capabilities.connectors.add")}
            </Button>
          ) : null
        }
      >
        {writable && setup !== null ? (
          <SetupCard
            key={resolved && "connectorId" in resolved ? resolved.connectorId : "new"}
            spaceId={spaceId}
            connectors={connectors}
            initial={resolved && "connectorId" in resolved ? resolved.connectorId : ""}
            onCancel={onSetUpDone}
            onDone={onOpen}
          />
        ) : null}
        <h3 className="px-1 pt-2 font-display font-semibold text-base">
          {t("capabilities.inSpace")}
        </h3>
        {error ? (
          <p className="px-1 text-[0.875rem] text-rose">{error.message}</p>
        ) : connections.length ? (
          <Card className="flex flex-col divide-y divide-border-soft p-0">
            {connections.map((c) => (
              <ConnectionRow key={c.id} connection={c} onOpen={() => onOpen(c.id)} />
            ))}
          </Card>
        ) : loading ? null : (
          <Card>
            <Empty>
              {writable
                ? t("capabilities.connectors.noneAdmin")
                : t("capabilities.connectors.none")}
            </Empty>
          </Card>
        )}
      </Section>

      {builtin.length ? (
        <div className="flex flex-col gap-2 px-1">
          <h3 className="font-semibold text-[0.875rem]">{t("capabilities.connectors.builtin")}</h3>
          <p className="text-[0.8125rem] text-ink-3">
            {writable
              ? t("capabilities.connectors.builtinHint")
              : t("capabilities.connectors.builtinHintMember")}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {builtin.map((c) => (
              <li key={c.id}>
                {writable && c.usable ? (
                  <button
                    type="button"
                    onClick={() => onSetUp(c.id)}
                    title={t("capabilities.connectors.setUpNamed", { name: c.name })}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-2 transition hover:bg-paper-3 hover:text-ink"
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    {c.name}
                  </button>
                ) : (
                  <span
                    title={c.missingSetup ?? undefined}
                    className={cn(
                      "inline-flex h-8 items-center rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-3",
                      !c.usable && "opacity-60",
                    )}
                  >
                    {c.name}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div ref={more} className="scroll-mt-6">
        <Section
          title={t("capabilities.connectors.more")}
          hint={t("capabilities.connectors.moreHint")}
        >
          <Connectors
            spaceId={spaceId}
            readOnly={!writable}
            embedded
            onSetUp={writable ? onSetUp : undefined}
            domain={domain}
          />
        </Section>
      </div>
    </>
  );
}

/** A connection in the list: what it is, how it signs in, who may use it; a member's own sign-in. */
export function ConnectionRow({
  connection: c,
  onOpen,
}: {
  connection: SpaceConnectionView;
  onOpen: () => void;
}) {
  const qc = useQueryClient();
  const s = useSignIn(`/api/studio/connections/${encodeURIComponent(c.id)}/my-sign-in`, () =>
    qc.invalidateQueries({ queryKey: connectionsKey(c.spaceId) }),
  );
  const asks = Object.values(c.rules).includes("ask");
  const person = c.signIn === "person";
  return (
    <div className="px-3.5 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="-my-1 -ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left transition hover:bg-paper-2"
        >
          <Logo name={c.connector?.name ?? c.connectorId} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[0.9375rem]">{titleOf(c)}</div>
            <div className="flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
              {person ? (
                <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">
                {signInLine(c)} · {lastUse(c)}
              </span>
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 max-sm:hidden">
            {asks ? <Chip tone="warn">{t("connection.outcome.ask")}</Chip> : null}
            <Chip>{t(AUDIENCE_LABEL[c.audience])}</Chip>
          </span>
        </button>
        {person ? (
          <SignInButtons s={s} auth={c.connector?.auth} signedIn={Boolean(c.mySignIn)} />
        ) : null}
      </div>
      {person ? (
        <SignInPanel
          s={s}
          fields={c.connector?.fields ?? []}
          signedIn={Boolean(c.mySignIn)}
          confirmText={t("konto.connectionSignOutConfirm", { name: titleOf(c) })}
          className="ml-12"
        />
      ) : null}
    </div>
  );
}

/** Setting up a connection: the connector, its name, how it signs in and who may use it. */
function SetupCard({
  spaceId,
  connectors,
  initial,
  onCancel,
  onDone,
}: {
  spaceId: string;
  connectors: ConnectorView[];
  initial: string;
  onCancel: () => void;
  onDone: (id: string) => void;
}) {
  const qc = useQueryClient();
  const offered = connectors.filter((c) => c.usable);
  const [connectorId, setConnectorId] = useState(
    offered.some((c) => c.id === initial) ? initial : "",
  );
  const connector = offered.find((c) => c.id === connectorId);
  const [name, setName] = useState(connector?.name ?? "");
  const [signIn, setSignIn] = useState<ConnectionSignIn>(
    connector?.auth === "oauth2" ? "person" : "space",
  );
  const [audience, setAudience] = useState<ConnectionAudience>("members");
  const create = useMutation({
    mutationFn: () =>
      api.post<SpaceConnectionView>(`/api/studio/spaces/${spaceId}/connections`, {
        connectorId,
        name: name.trim() || connector?.name,
        signIn,
        audience,
      }),
    onSuccess: async (view) => {
      await qc.invalidateQueries({ queryKey: connectionsKey(spaceId) });
      await qc.invalidateQueries({ queryKey: ["person-sign-ins"] });
      onDone(view.id);
    },
  });
  const choose = (id: string) => {
    const next = offered.find((c) => c.id === id);
    // The name follows the connector until someone wrote their own.
    if (!name.trim() || name === connector?.name) {
      setName(next?.name ?? "");
    }
    setConnectorId(id);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (connectorId) {
      create.mutate();
    }
  };
  return (
    <Card className="p-3.5 sm:p-5">
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div>
          <h3 className="font-display font-semibold text-base">
            {t("capabilities.connectors.add")}
          </h3>
          <p className="mt-1 text-[0.8125rem] text-ink-3">{t("connection.setupHint")}</p>
        </div>
        <div>
          <Label>{t("connection.connector")}</Label>
          <Select
            value={connectorId}
            onChange={choose}
            placeholder={t("connection.connectorPick")}
            options={offered.map((c) => ({ value: c.id, label: c.name }))}
          />
        </div>
        <div>
          <Label hint={t("connection.nameHint")}>{t("connection.name")}</Label>
          <Input
            value={name}
            maxLength={CONNECTION_LIMITS.name}
            placeholder={t("connection.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label hint={t(SIGN_IN_HINT[signIn])}>{t("connection.signIn")}</Label>
          <Tabs
            label={t("connection.signIn")}
            value={signIn}
            onChange={setSignIn}
            options={(["space", "person"] as const).map((id) => ({
              id,
              label: t(SIGN_IN_LABEL[id]),
            }))}
          />
          <p className="mt-2 text-[0.75rem] text-ink-3">{t("connection.signInFixed")}</p>
        </div>
        <div>
          <Label hint={t(AUDIENCE_HINT[audience])}>{t("connection.audience")}</Label>
          <Tabs
            label={t("connection.audience")}
            value={audience}
            onChange={setAudience}
            options={CONNECTION_AUDIENCES.map((id) => ({ id, label: t(AUDIENCE_LABEL[id]) }))}
          />
        </div>
        {create.error ? (
          <p className="text-[0.8125rem] text-rose">{(create.error as Error).message}</p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" busy={create.isPending} disabled={!connectorId}>
            {t("capabilities.connectors.setUp")}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("orgSettings.cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** One connection: its name, how it signs in, who may use it, what each kind of action may do. */
function ConnectionPage({
  connection: c,
  connector,
  writable,
  onGone,
}: {
  connection: SpaceConnectionView;
  connector: ConnectorView | undefined;
  writable: boolean;
  onGone: () => void;
}) {
  const qc = useQueryClient();
  const key = connectionsKey(c.spaceId);
  const reload = () => qc.invalidateQueries({ queryKey: key });
  const [name, setName] = useState(c.name);
  const [removing, setRemoving] = useState(false);
  const base = `/api/studio/connections/${encodeURIComponent(c.id)}`;
  const patch = useMutation({
    mutationFn: (body: Partial<Pick<SpaceConnectionView, "name" | "audience" | "rules">>) =>
      api.patch<SpaceConnectionView>(base, body),
    onSuccess: (view) => {
      qc.setQueryData<ConnectionsList>(key, (old) =>
        old ? { connections: old.connections.map((x) => (x.id === view.id ? view : x)) } : old,
      );
      void qc.invalidateQueries({ queryKey: ["person-sign-ins"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(base),
    onSuccess: async () => {
      await reload();
      void qc.invalidateQueries({ queryKey: ["person-sign-ins"] });
      onGone();
    },
  });
  const asSpace = useSignIn(`${base}/sign-in`, reload);
  const mine = useSignIn(`${base}/my-sign-in`, reload);
  const saveName = () => {
    const next = name.trim();
    if (next && next !== c.name) {
      patch.mutate({ name: next });
    } else {
      setName(c.name);
    }
  };
  const connectorName = c.connector?.name ?? c.connectorId;
  const fields = c.connector?.fields ?? [];
  const setUp = c.setUpByName
    ? t("konto.connectionSetUpBy", { name: c.setUpByName, when: day(c.setUpAt) })
    : t("konto.connectionSetUpAt", { when: day(c.setUpAt) });
  const actionsOf = (kind: ConnectionActionKind) =>
    (connector?.actions ?? [])
      .filter((a) => a.group === kind)
      .filter((a) => !c.actions.length || c.actions.includes(a.id));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4 px-1">
        <Logo name={connectorName} large />
        <div className="min-w-0">
          <h2 className="font-display font-semibold text-lg leading-tight">{connectorName}</h2>
          {c.connector?.description ? (
            <p className="mt-1 line-clamp-2 text-[0.875rem] text-ink-3">
              {c.connector.description}
            </p>
          ) : null}
        </div>
      </div>

      <Card className="flex flex-col gap-5 p-3.5 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {writable ? (
            <Input
              aria-label={t("connection.name")}
              className="max-w-sm font-semibold"
              value={name}
              maxLength={CONNECTION_LIMITS.name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveName();
                }
              }}
            />
          ) : (
            <b className="text-[0.9375rem]">{c.name}</b>
          )}
          <span className="text-[0.8125rem] text-ink-3">
            {writable ? setUp : t("connection.adminsManage")}
          </span>
        </div>

        <Row label={t("connection.signIn")}>
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[0.875rem]">
              {c.signIn === "space" ? (
                <Building2 className="size-4 text-ink-3" aria-hidden="true" />
              ) : (
                <UserRound className="size-4 text-ink-3" aria-hidden="true" />
              )}
              {t(SIGN_IN_LABEL[c.signIn])}
            </span>
            <span className="text-[0.8125rem] text-ink-3">{t(SIGN_IN_HINT[c.signIn])}</span>
          </div>
        </Row>

        {c.signIn === "space" ? (
          <Row label={t("connection.account")}>
            <div className="flex flex-col">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-[0.875rem]">
                  {c.account
                    ? t("connection.accountSignedIn", { label: c.account.label })
                    : writable
                      ? t("connection.accountNotYetAdmin")
                      : t("connection.accountNotYet")}
                </span>
                {writable ? (
                  <SignInButtons
                    s={asSpace}
                    auth={c.connector?.auth}
                    signedIn={Boolean(c.account)}
                  />
                ) : null}
              </div>
              {writable ? (
                <SignInPanel
                  s={asSpace}
                  fields={fields}
                  signedIn={Boolean(c.account)}
                  confirmText={t("connection.signOutSpaceConfirm", { name: titleOf(c) })}
                />
              ) : null}
            </div>
          </Row>
        ) : (
          <Row label={t("connection.people")}>
            <div className="flex flex-col">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-[0.875rem]">
                  {t("connection.peopleSignedIn", { n: c.signedIn })}
                  {" · "}
                  {c.mySignIn
                    ? t("connection.youSignedIn", { label: c.mySignIn.label })
                    : t("connection.youNotYet")}
                </span>
                <SignInButtons s={mine} auth={c.connector?.auth} signedIn={Boolean(c.mySignIn)} />
              </div>
              <SignInPanel
                s={mine}
                fields={fields}
                signedIn={Boolean(c.mySignIn)}
                confirmText={t("konto.connectionSignOutConfirm", { name: titleOf(c) })}
              />
            </div>
          </Row>
        )}

        <Row label={t("connection.audience")}>
          <div className="flex flex-col gap-1.5">
            {writable ? (
              <div>
                <Tabs
                  label={t("connection.audience")}
                  value={c.audience}
                  onChange={(audience) => patch.mutate({ audience })}
                  options={CONNECTION_AUDIENCES.map((id) => ({
                    id,
                    label: t(AUDIENCE_LABEL[id]),
                  }))}
                />
              </div>
            ) : (
              <span>
                <Chip>{t(AUDIENCE_LABEL[c.audience])}</Chip>
              </span>
            )}
            <span className="text-[0.8125rem] text-ink-3">{t(AUDIENCE_HINT[c.audience])}</span>
          </div>
        </Row>

        <div className="border-border-soft border-t" />

        <div className="flex flex-col gap-4">
          <h3 className="font-semibold text-[0.875rem]">{t("connection.rules")}</h3>
          {CONNECTION_ACTION_KINDS.map((kind) => {
            const actions = actionsOf(kind);
            return (
              <div
                key={kind}
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <div className="font-medium text-[0.875rem]">{t(KIND_LABEL[kind])}</div>
                  <div className="text-[0.8125rem] text-ink-3">{t(KIND_HINT[kind])}</div>
                  {actions.length ? (
                    <div className="mt-0.5 truncate font-mono text-[0.6875rem] text-ink-4">
                      {actions.map((a) => a.id).join(" · ")}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0">
                  {writable ? (
                    <Tabs
                      label={t(KIND_LABEL[kind])}
                      value={c.rules[kind]}
                      onChange={(outcome) =>
                        patch.mutate({ rules: { ...c.rules, [kind]: outcome } })
                      }
                      options={CONNECTION_OUTCOMES.map((id) => ({
                        id,
                        label: t(OUTCOME_LABEL[id]),
                      }))}
                    />
                  ) : (
                    <Chip tone={c.rules[kind] === "ask" ? "warn" : "neutral"}>
                      {t(OUTCOME_LABEL[c.rules[kind]])}
                    </Chip>
                  )}
                </div>
              </div>
            );
          })}
          <p className="text-[0.8125rem] text-ink-3">
            {writable ? t("connection.askHint") : t("connection.askHintMember")}
          </p>
        </div>
        {patch.error ? (
          <p className="text-[0.8125rem] text-rose">{(patch.error as Error).message}</p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-1 p-3.5 sm:p-5">
        <Row label={t("connection.use")}>
          <span className="text-[0.875rem]">{lastUse(c)}</span>
        </Row>
      </Card>

      {writable ? (
        <div className="px-1">
          {removing ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-paper p-3 text-[0.875rem] ring-1 ring-border-soft">
              <p className="min-w-48 flex-1">
                {t("connection.removeConfirm", { name: titleOf(c) })}
              </p>
              <Button variant="ghost" onClick={() => setRemoving(false)}>
                {t("orgSettings.cancel")}
              </Button>
              <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
                {t("connection.remove")}
              </Button>
            </div>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setRemoving(true)}>
              {t("connection.remove")}
            </Button>
          )}
          {remove.error ? (
            <p className="mt-2 text-[0.8125rem] text-rose">{(remove.error as Error).message}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A label on the left, its value on the right; one under the other on a phone. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <span className="pt-0.5 text-[0.8125rem] text-ink-3">{label}</span>
      {children}
    </div>
  );
}
