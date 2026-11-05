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
import { Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { type Key, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { initialsOf } from "../lib/session";
import { Button, Chip, cn, Input, Label, Tabs } from "../ui";

/*
 * Weitere Connectors › Per Adresse (docs/plans/capabilities-next.md, piece 1): an admin adds an
 * MCP server or an OpenAPI description the registry does not list. They paste its address,
 * „Prüfen“ reads what answers there, they correct the name, the sign-in and what each action
 * does, and „Importieren“ leads on to „Verbindung hinzufügen“. Such a connector is „nicht
 * geprüft“. `ActionKinds` is also how an imported connector's actions are changed later.
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

export function ConnectorByAddress({
  spaceId,
  taken,
  onDone,
}: {
  spaceId: string;
  /** The ids of the space's connectors: a short name must be a new one. */
  taken: string[];
  /** The connector was imported: „Verbindung hinzufügen“ opens with it. */
  onDone: (connectorId: string) => void;
}) {
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [signIn, setSignIn] = useState<SignIn>("described");
  const [header, setHeader] = useState({ name: "Authorization", scheme: "Bearer", value: "" });
  const [client, setClient] = useState({ id: "", secret: "" });
  /** What the admin said single actions do, where it is not what engenty read. */
  const [kinds, setKinds] = useState<Record<string, ActionKindChoice>>({});

  const headerChoice = (withValue: boolean): SignInChoice => ({
    kind: "header",
    name: header.name.trim(),
    ...(header.scheme.trim() ? { scheme: header.scheme.trim() } : {}),
    ...(withValue && header.value ? { value: header.value } : {}),
  });

  const check = useMutation({
    mutationFn: (withKey: boolean) =>
      api.post<SourcePreview>(`/api/studio/spaces/${spaceId}/connectors/preview`, {
        sourceUrl: addressOf(address),
        ...(withKey ? { signIn: headerChoice(true) } : {}),
      }),
    onSuccess: (found, withKey) => {
      setPreview(found);
      setKinds((old) =>
        Object.fromEntries(
          Object.entries(old).filter(([id]) => found.actions.some((a) => a.id === id)),
        ),
      );
      // Reading again with the key keeps what was already set.
      if (!withKey) {
        setName(found.title ?? found.host);
        setShort(found.suggestedToolPrefix);
        setSignIn(firstSignIn(found));
        setKinds({});
      }
    },
  });

  // An error of reading again with the key shows beside the key, not under the address.
  const readingWithKey = Boolean(preview) && check.variables === true;
  const id = short.replaceAll("_", "-");
  const shortError = !/^[a-z][a-z0-9_]{1,30}$/.test(short)
    ? t("connectors.address.shortInvalid")
    : taken.includes(id)
      ? t("connectors.address.shortTaken")
      : null;
  const needsClient =
    signIn === "described" &&
    preview?.signIn.described === "oauth2" &&
    preview.signIn.needsOAuthClient;

  const run = useMutation({
    mutationFn: (source: SourcePreview) =>
      api.post<{ connector: ConnectorView; warnings: string[] }>(
        `/api/studio/spaces/${spaceId}/connectors`,
        {
          sourceKind: source.sourceKind,
          sourceUrl: addressOf(address),
          id,
          toolPrefix: short,
          name: name.trim() || source.host,
          signIn: signIn === "header" ? headerChoice(true) : { kind: signIn },
          ...(Object.keys(kinds).length ? { actionKinds: kinds } : {}),
          ...(needsClient && client.id && client.secret
            ? { oauthClientId: client.id, oauthClientSecret: client.secret }
            : {}),
        } satisfies ImportRequest,
      ),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: keys.connectors(spaceId) });
      setPreview(null);
      setAddress("");
      setHeader((h) => ({ ...h, value: "" }));
      onDone(result.connector.id);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (address.trim()) {
      run.reset();
      check.mutate(false);
    }
  };

  const actions: ConnectorActionView[] = (preview?.actions ?? []).map((a) => {
    const set = kinds[a.id];
    return set ? { ...a, group: set.kind, recipientField: set.recipientField } : a;
  });
  const signIns: SignIn[] = preview
    ? preview.signIn.described === null
      ? ["header", "none"]
      : preview.signIn.described === "none"
        ? ["none", "header"]
        : ["described", "header", "none"]
    : [];
  const shown = name.trim() || preview?.host || "";

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <p className="text-[0.8125rem] text-ink-3">{t("connectors.address.hint")}</p>
        <div className="flex gap-2">
          <Input
            aria-label={t("connectors.address.label")}
            className="font-mono text-[0.8125rem]"
            value={address}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t("connectors.address.placeholder")}
            onChange={(e) => setAddress(e.target.value)}
          />
          <Button type="submit" variant="secondary" busy={check.isPending && !preview}>
            <Search className="size-4" /> {t("connectors.address.check")}
          </Button>
        </div>
      </form>
      {check.error && !readingWithKey ? (
        <p className="text-[0.8125rem] text-rose">{(check.error as Error).message}</p>
      ) : null}

      {preview ? (
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
              <div className="truncate text-[0.75rem] text-ink-3">
                {t(`connectors.address.kind.${preview.sourceKind}`)} · {preview.host} ·{" "}
                {preview.toolsPending
                  ? t("connectors.address.actions.pending")
                  : t(
                      preview.actions.length === 1
                        ? "connectors.address.actions.one"
                        : "connectors.address.actions.n",
                      { n: preview.actions.length },
                    )}
              </div>
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

          <div className="grid gap-4 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div>
              <Label>{t("connectors.address.name")}</Label>
              <Input
                aria-label={t("connectors.address.name")}
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("connectors.address.short")}</Label>
              <Input
                aria-label={t("connectors.address.short")}
                className="font-mono text-[0.8125rem]"
                value={short}
                maxLength={31}
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => setShort(e.target.value.toLowerCase())}
              />
              <p className={cn("mt-1.5 text-[0.75rem]", shortError ? "text-rose" : "text-ink-3")}>
                {shortError ?? t("connectors.address.shortHint")}
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
                onChange={setSignIn}
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
                      onChange={(e) => setHeader((h) => ({ ...h, name: e.target.value }))}
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
                      onChange={(e) => setHeader((h) => ({ ...h, scheme: e.target.value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[0.75rem] text-ink-3">
                    {t("connectors.address.header.value")}
                    <Input
                      type="password"
                      autoComplete="off"
                      value={header.value}
                      onChange={(e) => setHeader((h) => ({ ...h, value: e.target.value }))}
                    />
                  </label>
                </div>
                {check.error && readingWithKey ? (
                  <p className="text-[0.8125rem] text-rose">{(check.error as Error).message}</p>
                ) : null}
                {preview.sourceKind === "mcp" && preview.signIn.described !== "none" ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      busy={check.isPending}
                      disabled={!(header.name.trim() && header.value)}
                      onClick={() => check.mutate(true)}
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
            {needsClient ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Input
                  aria-label={t("connectors.clientId")}
                  placeholder={t("connectors.clientId")}
                  value={client.id}
                  onChange={(e) => setClient((c) => ({ ...c, id: e.target.value }))}
                />
                <Input
                  aria-label={t("connectors.clientSecret")}
                  type="password"
                  autoComplete="off"
                  placeholder={t("connectors.clientSecret")}
                  value={client.secret}
                  onChange={(e) => setClient((c) => ({ ...c, secret: e.target.value }))}
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
                  onChange={(actionId, choice) => setKinds((k) => ({ ...k, [actionId]: choice }))}
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

          {run.error ? (
            <p className="text-[0.8125rem] text-rose">{(run.error as Error).message}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              busy={run.isPending}
              disabled={
                Boolean(shortError) ||
                preview.blockers.length > 0 ||
                (signIn === "header" && !header.name.trim())
              }
              onClick={() => run.mutate(preview)}
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
