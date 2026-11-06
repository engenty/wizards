import type {
  ActionGroup,
  ActionKindChoice,
  ConnectorActionView,
  ConnectorView,
  ImportRequest,
  SignInChoice,
  SourcePreview,
} from "@engenty/wizards-shared/connectors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Upload } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { type Key, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { initialsOf } from "../lib/session";
import { Button, Chip, cn, Input, Label, Tabs } from "../ui";
import {
  isRepoAddress,
  PluginPreview,
  type PluginSource,
  usePluginPreview,
} from "./PluginByAddress";

/*
 * Weitere Connectors › Per Adresse (docs/plans/capabilities-next.md, piece 1): an admin adds an
 * MCP server or an OpenAPI description the registry does not list. They paste its address,
 * „Prüfen“ reads what answers there, they correct the name, the sign-in and what each action
 * does, and „Importieren“ leads on to „Verbindung hinzufügen“. Such a connector is „nicht
 * geprüft“. `ActionKinds` is also how an imported connector's actions are changed later.
 *
 * The same field takes a repository on GitHub or a zip (piece 4): a plugin for Claude Code or
 * Cursor, read and shown by `PluginByAddress`. `SourceFields` is what an admin corrects about
 * one source, here and for each server a plugin brings.
 */

const GROUPS: ActionGroup[] = ["read", "write", "send", "destructive"];

const GROUP_LABEL: Record<ActionGroup, Key> = {
  read: "connectors.group.read",
  write: "connectors.group.write",
  send: "connectors.group.send",
  destructive: "connectors.group.destructive",
};

/** A select as small as a row of a list. */
function SmallSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  mono?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-8 max-w-full rounded-lg border border-input bg-card px-2 text-[0.8125rem] text-ink outline-none transition focus:border-focus focus:ring-4 focus:ring-focus-glow disabled:opacity-60 coarse:h-10",
        mono && "font-mono text-[0.75rem]",
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Every action with what it does (liest, ändert, sendet, löscht) as a choice, and for „sendet“
 * the input field that holds the recipient. `onChange` gets one action's choice.
 */
export function ActionKinds({
  actions,
  onChange,
  disabled,
}: {
  actions: ConnectorActionView[];
  onChange: (id: string, choice: ActionKindChoice) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border-soft">
      {actions.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
          <div className="min-w-0 flex-1 basis-48">
            <div className="truncate font-mono text-[0.75rem] text-ink-2">{a.id}</div>
            {a.summary ? (
              <div className="truncate text-[0.75rem] text-ink-4">{a.summary}</div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {a.group === "send" ? (
              <>
                <span className="text-[0.75rem] text-ink-3">
                  {t("connectors.address.recipient")}
                </span>
                <SmallSelect
                  mono={Boolean(a.recipientField)}
                  label={t("connectors.address.recipientOf", { id: a.id })}
                  value={a.recipientField ?? ""}
                  disabled={disabled}
                  onChange={(field) =>
                    onChange(a.id, { kind: "send", ...(field ? { recipientField: field } : {}) })
                  }
                  options={[
                    { value: "", label: t("connectors.address.recipientNone") },
                    // A field named before the actions were reloaded stays to be seen.
                    ...[...new Set([...(a.fields ?? []), a.recipientField ?? ""])]
                      .filter(Boolean)
                      .map((f) => ({ value: f, label: f })),
                  ]}
                />
              </>
            ) : null}
            <SmallSelect
              label={t("connectors.address.kindOf", { id: a.id })}
              value={a.group}
              disabled={disabled}
              onChange={(kind) => onChange(a.id, { kind: kind as ActionGroup })}
              options={GROUPS.map((g) => ({ value: g, label: t(GROUP_LABEL[g]) }))}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

type SignIn = SignInChoice["kind"];

/** The address as the runtime takes it: with `https://`, or `http://` for this computer. */
function addressOf(typed: string): string {
  const value = typed.trim();
  if (!value || /^https?:\/\//i.test(value)) {
    return value;
  }
  return /^(localhost|\[|\d+\.\d+\.\d+\.\d+)/i.test(value) ? `http://${value}` : `https://${value}`;
}

/** The sign-in to start with: what the source describes, else a key in a header. */
const firstSignIn = (preview: SourcePreview): SignIn =>
  preview.signIn.described === null
    ? "header"
    : preview.signIn.described === "none"
      ? "none"
      : "described";

/** The sentence under the choice of a sign-in. */
function signInSentence(preview: SourcePreview, signIn: SignIn): string {
  const { described, needsOAuthClient, keyIn } = preview.signIn;
  if (signIn === "header") {
    return t("connectors.address.signIn.headerHint");
  }
  if (signIn === "none") {
    return t(
      described === "none"
        ? "connectors.address.signIn.open"
        : "connectors.address.signIn.noneHint",
    );
  }
  if (described === "oauth2") {
    return t(
      needsOAuthClient
        ? "connectors.address.signIn.oauthClient"
        : "connectors.address.signIn.oauth",
    );
  }
  return t("connectors.address.signIn.key", { name: keyIn ?? "" });
}

/** What an admin says about one source before it is imported. */
export interface SourceChoice {
  name: string;
  /** The tool prefix; the connector's id is the same with hyphens. */
  short: string;
  signIn: SignIn;
  header: { name: string; scheme: string; value: string };
  client: { id: string; secret: string };
  /** What the admin said single actions do, where it is not what engenty read. */
  kinds: Record<string, ActionKindChoice>;
}

/** The choice a source starts with: its own name and sign-in, and the header a plugin names. */
export function firstChoice(
  preview: SourcePreview,
  given: { name?: string; keyHeader?: { name: string; scheme?: string } | null } = {},
): SourceChoice {
  return {
    name: given.name ?? preview.title ?? preview.host,
    short: preview.suggestedToolPrefix,
    signIn: firstSignIn(preview),
    header: {
      name: given.keyHeader?.name ?? "Authorization",
      scheme: given.keyHeader ? (given.keyHeader.scheme ?? "") : "Bearer",
      value: "",
    },
    client: { id: "", secret: "" },
    kinds: {},
  };
}

/** The header as the runtime takes it; the key goes along only to read the actions now. */
export function headerChoice(choice: SourceChoice, withValue: boolean): SignInChoice {
  const { header } = choice;
  return {
    kind: "header",
    name: header.name.trim(),
    ...(header.scheme.trim() ? { scheme: header.scheme.trim() } : {}),
    ...(withValue && header.value ? { value: header.value } : {}),
  };
}

export const signInOf = (choice: SourceChoice): SignInChoice =>
  choice.signIn === "header" ? headerChoice(choice, true) : { kind: choice.signIn };

/** The connector's id a short name stands for. */
export const idOf = (short: string) => short.replaceAll("_", "-");

/** Why a short name cannot be taken, or null. */
export function shortError(short: string, taken: string[]): string | null {
  return !/^[a-z][a-z0-9_]{1,30}$/.test(short)
    ? t("connectors.address.shortInvalid")
    : taken.includes(idOf(short))
      ? t("connectors.address.shortTaken")
      : null;
}

/** OAuth the server describes without registering clients itself: the import needs one. */
export const needsClient = (preview: SourcePreview, choice: SourceChoice) =>
  choice.signIn === "described" &&
  preview.signIn.described === "oauth2" &&
  preview.signIn.needsOAuthClient;

/** Whether a source can be imported as it is chosen. */
export const choiceReady = (preview: SourcePreview, choice: SourceChoice, taken: string[]) =>
  !shortError(choice.short, taken) &&
  preview.blockers.length === 0 &&
  !(choice.signIn === "header" && !choice.header.name.trim());

/**
 * What an admin corrects about one source: its name and short name, how it signs in, and what
 * each action does. `onRead` reads the actions again with the key that was typed.
 */
export function SourceFields({
  preview,
  value,
  onChange,
  taken,
  onRead,
  reading,
  readError,
}: {
  preview: SourcePreview;
  value: SourceChoice;
  onChange: (next: SourceChoice) => void;
  /** The ids of the space's connectors: a short name must be a new one. */
  taken: string[];
  onRead: () => void;
  reading: boolean;
  readError: string | null;
}) {
  const set = (patch: Partial<SourceChoice>) => onChange({ ...value, ...patch });
  const { signIn, header, client } = value;
  const error = shortError(value.short, taken);
  const actions: ConnectorActionView[] = preview.actions.map((a) => {
    const said = value.kinds[a.id];
    return said ? { ...a, group: said.kind, recipientField: said.recipientField } : a;
  });
  const signIns: SignIn[] =
    preview.signIn.described === null
      ? ["header", "none"]
      : preview.signIn.described === "none"
        ? ["none", "header"]
        : ["described", "header", "none"];
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <Label>{t("connectors.address.name")}</Label>
          <Input
            aria-label={t("connectors.address.name")}
            value={value.name}
            maxLength={120}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div>
          <Label>{t("connectors.address.short")}</Label>
          <Input
            aria-label={t("connectors.address.short")}
            className="font-mono text-[0.8125rem]"
            value={value.short}
            maxLength={31}
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => set({ short: e.target.value.toLowerCase() })}
          />
          <p className={cn("mt-1.5 text-[0.75rem]", error ? "text-rose" : "text-ink-3")}>
            {error ?? t("connectors.address.shortHint")}
          </p>
        </div>
      </div>

      <div>
        <Label>{t("connectors.address.signIn")}</Label>
        {preview.signIn.described === null ? (
          <p className="mb-2 text-[0.8125rem] text-ink-2">
            {t("connectors.address.signIn.unknown")}
          </p>
        ) : null}
        <div className="max-w-full overflow-x-auto">
          <Tabs
            label={t("connectors.address.signIn")}
            value={signIn}
            onChange={(kind) => set({ signIn: kind })}
            options={signIns.map((kind) => ({
              id: kind,
              label: t(`connectors.address.signIn.${kind}`),
            }))}
          />
        </div>
        <p className="mt-2 text-[0.8125rem] text-ink-3">{signInSentence(preview, signIn)}</p>
        {signIn === "header" ? (
          <div className="mt-3 flex flex-col gap-2">
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-[0.75rem] text-ink-3">
                {t("connectors.address.header.name")}
                <Input
                  className="font-mono text-[0.8125rem]"
                  value={header.name}
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => set({ header: { ...header, name: e.target.value } })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[0.75rem] text-ink-3">
                {t("connectors.address.header.scheme")}
                <Input
                  className="font-mono text-[0.8125rem]"
                  value={header.scheme}
                  placeholder={t("connectors.address.header.schemePlaceholder")}
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => set({ header: { ...header, scheme: e.target.value } })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[0.75rem] text-ink-3">
                {t("connectors.address.header.value")}
                <Input
                  type="password"
                  autoComplete="off"
                  value={header.value}
                  onChange={(e) => set({ header: { ...header, value: e.target.value } })}
                />
              </label>
            </div>
            {readError ? <p className="text-[0.8125rem] text-rose">{readError}</p> : null}
            {preview.sourceKind === "mcp" && preview.signIn.described !== "none" ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  size="sm"
                  variant="secondary"
                  busy={reading}
                  disabled={!(header.name.trim() && header.value)}
                  onClick={onRead}
                >
                  {t("connectors.address.header.read")}
                </Button>
                <span className="min-w-48 flex-1 text-[0.75rem] text-ink-3">
                  {t("connectors.address.header.valueHint")}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
        {needsClient(preview, value) ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Input
              aria-label={t("connectors.clientId")}
              placeholder={t("connectors.clientId")}
              value={client.id}
              onChange={(e) => set({ client: { ...client, id: e.target.value } })}
            />
            <Input
              aria-label={t("connectors.clientSecret")}
              type="password"
              autoComplete="off"
              placeholder={t("connectors.clientSecret")}
              value={client.secret}
              onChange={(e) => set({ client: { ...client, secret: e.target.value } })}
            />
          </div>
        ) : null}
      </div>

      {actions.length ? (
        <div className="flex flex-col gap-2">
          <div>
            <h4 className="font-semibold text-[0.875rem]">{t("connectors.address.kinds")}</h4>
            <p className="mt-0.5 text-[0.8125rem] text-ink-3">
              {t("connectors.address.kindsHint")}
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto rounded-lg bg-card ring-1 ring-border-soft">
            <ActionKinds
              actions={actions}
              onChange={(actionId, choice) =>
                set({ kinds: { ...value.kinds, [actionId]: choice } })
              }
            />
          </div>
          {actions.some((a) => a.group === "send") ? (
            <p className="text-[0.75rem] text-ink-3">{t("connectors.address.recipientHint")}</p>
          ) : null}
          {preview.dropped ? (
            <p className="text-[0.75rem] text-ink-3">
              {t("connectors.address.dropped", { n: preview.dropped })}
            </p>
          ) : null}
        </div>
      ) : preview.toolsPending ? (
        <p className="text-[0.8125rem] text-ink-3">{t("connectors.address.pending")}</p>
      ) : null}
    </>
  );
}

/** A source's line under its name: what answered, where, and how many actions. */
export function sourceLine(preview: SourcePreview): string {
  return [
    t(`connectors.address.kind.${preview.sourceKind}`),
    preview.host,
    preview.toolsPending
      ? t("connectors.address.actions.pending")
      : t(
          preview.actions.length === 1
            ? "connectors.address.actions.one"
            : "connectors.address.actions.n",
          { n: preview.actions.length },
        ),
  ].join(" · ");
}

export function ConnectorByAddress({
  spaceId,
  taken,
  onDone,
  start,
}: {
  spaceId: string;
  /** The ids of the space's connectors: a short name must be a new one. */
  taken: string[];
  /** The connector was imported: „Verbindung hinzufügen“ opens with it. */
  onDone: (connectorId: string) => void;
  /** An address to read at once (`?address=`): a repository Entdecken found. */
  start?: string | null;
}) {
  const qc = useQueryClient();
  const [address, setAddress] = useState(start ?? "");
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [choice, setChoice] = useState<SourceChoice | null>(null);
  const plugin = usePluginPreview(spaceId);
  const zip = useRef<HTMLInputElement>(null);

  const check = useMutation({
    mutationFn: (withKey: boolean) =>
      api.post<SourcePreview>(`/api/studio/spaces/${spaceId}/connectors/preview`, {
        sourceUrl: addressOf(address),
        ...(withKey && choice ? { signIn: headerChoice(choice, true) } : {}),
      }),
    onSuccess: (found, withKey) => {
      setPreview(found);
      // Reading again with the key keeps what was already set.
      setChoice((old) =>
        withKey && old
          ? {
              ...old,
              kinds: Object.fromEntries(
                Object.entries(old.kinds).filter(([id]) => found.actions.some((a) => a.id === id)),
              ),
            }
          : firstChoice(found),
      );
    },
  });

  // An error of reading again with the key shows beside the key, not under the address.
  const readingWithKey = Boolean(preview) && check.variables === true;

  const run = useMutation({
    mutationFn: ({ source, said }: { source: SourcePreview; said: SourceChoice }) =>
      api.post<{ connector: ConnectorView; warnings: string[] }>(
        `/api/studio/spaces/${spaceId}/connectors`,
        {
          sourceKind: source.sourceKind,
          sourceUrl: addressOf(address),
          id: idOf(said.short),
          toolPrefix: said.short,
          name: said.name.trim() || source.host,
          signIn: signInOf(said),
          ...(Object.keys(said.kinds).length ? { actionKinds: said.kinds } : {}),
          ...(needsClient(source, said) && said.client.id && said.client.secret
            ? { oauthClientId: said.client.id, oauthClientSecret: said.client.secret }
            : {}),
        } satisfies ImportRequest,
      ),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: keys.connectors(spaceId) });
      setPreview(null);
      setChoice(null);
      setAddress("");
      onDone(result.connector.id);
    },
  });

  const readPlugin = plugin.read;
  const read = (source: PluginSource) => {
    run.reset();
    check.reset();
    setPreview(null);
    setChoice(null);
    readPlugin(source);
  };
  // An address Entdecken handed over is read at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per address handed over.
  useEffect(() => {
    if (start) {
      setAddress(start);
      read({ address: start });
    }
  }, [start]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!address.trim()) {
      return;
    }
    if (isRepoAddress(address)) {
      read({ address: address.trim() });
      return;
    }
    plugin.reset();
    run.reset();
    check.mutate(false);
  };

  const shown = choice?.name.trim() || preview?.host || "";

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <p className="text-[0.8125rem] text-ink-3">{t("connectors.address.hint")}</p>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={t("connectors.address.label")}
            className="min-w-48 flex-1 font-mono text-[0.8125rem]"
            value={address}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t("connectors.address.placeholder")}
            onChange={(e) => setAddress(e.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            busy={(check.isPending && !preview) || (plugin.pending && !plugin.found)}
          >
            <Search className="size-4" /> {t("connectors.address.check")}
          </Button>
          <Button variant="ghost" onClick={() => zip.current?.click()}>
            <Upload className="size-4" /> {t("connectors.plugin.upload")}
          </Button>
          <input
            ref={zip}
            type="file"
            accept=".zip,.plugin"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) {
                setAddress("");
                read({ file });
              }
            }}
          />
        </div>
      </form>
      {check.error && !readingWithKey ? (
        <p className="text-[0.8125rem] text-rose">{(check.error as Error).message}</p>
      ) : null}
      {plugin.error && !plugin.found ? (
        <p className="text-[0.8125rem] text-rose">{plugin.error}</p>
      ) : null}

      {plugin.found ? (
        <PluginPreview
          spaceId={spaceId}
          taken={taken}
          plugin={plugin}
          onCancel={plugin.reset}
          onDone={(connectorId) => {
            plugin.reset();
            setAddress("");
            if (connectorId) {
              onDone(connectorId);
            }
          }}
        />
      ) : null}

      {preview && choice ? (
        <div className="flex flex-col gap-5 border-border-soft border-t pt-4">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-paper-2 font-semibold text-[0.875rem] text-ink-2"
            >
              {initialsOf(shown) || "?"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display font-semibold text-[0.9375rem]">{shown}</div>
              <div className="truncate text-[0.75rem] text-ink-3">{sourceLine(preview)}</div>
            </div>
            {preview.fromAddress ? (
              <Chip tone="warn" title={t("connectors.uncheckedHint")}>
                {t("connectors.unchecked")}
              </Chip>
            ) : null}
          </div>
          {preview.privateAddress ? (
            <p className="text-[0.8125rem] text-ink-3">{t("connectors.address.private")}</p>
          ) : null}
          {preview.blockers.map((b) => (
            <p key={b} className="text-[0.8125rem] text-rose">
              {b}
            </p>
          ))}

          <SourceFields
            preview={preview}
            value={choice}
            onChange={setChoice}
            taken={taken}
            onRead={() => check.mutate(true)}
            reading={check.isPending}
            readError={check.error && readingWithKey ? (check.error as Error).message : null}
          />

          {run.error ? (
            <p className="text-[0.8125rem] text-rose">{(run.error as Error).message}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              busy={run.isPending}
              disabled={!choiceReady(preview, choice, taken)}
              onClick={() => run.mutate({ source: preview, said: choice })}
            >
              {t("connectors.import")}
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              {t("orgSettings.cancel")}
            </Button>
            <span className="min-w-48 flex-1 text-[0.8125rem] text-ink-3">
              {t("connectors.address.after")}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
