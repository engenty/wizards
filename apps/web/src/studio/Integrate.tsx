import { featureOn } from "@engenty-wizards/shared/features";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  ArrowRight,
  Check,
  ChevronRight,
  Cloud,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Link2,
  Lock,
  MessageCircle,
  Monitor,
  Plus,
  Text,
  Trash2,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { type Me, useCurrentProject, useMe, type WizardSummary } from "../lib/session";
import { Button, Card, Chip, cn, IconButton } from "../ui";
import { LinkStatus, useAccountLink } from "./Account";
import { openExternal } from "./LocalRuntime";
import {
  MenuGroup,
  MenuRow,
  type MenuTone,
  SubMenu,
  useDetail,
  useSettingsMenu,
} from "./settings-menu";

/** The name the server gets in every client's config. */
const NAME = "engenty-wizards";
/** The name a person gives the connector in claude.ai, ChatGPT or Claude Desktop. */
const CONNECTOR_NAME = "engenty wizards";
/** The variable Codex reads the key from. */
const KEY_VAR = "ENGENTY_WIZARDS_KEY";

interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: string;
  lastRequest: string | null;
}

/** An AI app on this computer, as `wizards connect` sees it. */
interface LocalApp {
  id: string;
  name: string;
  widgets: boolean;
  where: string;
  installed: boolean;
  connected: boolean;
}

/** What a client did with the MCP server since the runtime started. */
interface Seen {
  at: number;
  toolAt: number | null;
  widgetAt: number | null;
}

type Outcome = { ok: boolean; message: string; snippet?: string };

/**
 * The AI apps the wizards go into. `widgets`: it shows MCP Apps, so a run shows the wizard itself.
 * `oauth`: it connects from its maker's servers and signs in over OAuth — a public, managed server.
 * `connector`: the same for Claude Desktop's connectors, though the app also runs on this computer.
 */
type Client = { id: string; name: string; widgets: boolean; oauth?: boolean; connector?: boolean };

const CLIENTS: Client[] = [
  { id: "claude-desktop", name: "Claude Desktop", widgets: true, connector: true },
  { id: "claude-code", name: "Claude Code", widgets: false },
  { id: "codex", name: "Codex · ChatGPT app", widgets: false },
  { id: "cursor", name: "Cursor", widgets: true },
  { id: "vscode", name: "VS Code (Copilot)", widgets: true },
  { id: "windsurf", name: "Windsurf", widgets: false },
  { id: "antigravity", name: "Antigravity", widgets: false },
  { id: "goose", name: "Goose", widgets: true },
  { id: "openclaw", name: "OpenClaw", widgets: false },
  { id: "lm-studio", name: "LM Studio", widgets: false },
  { id: "claude-ai", name: "claude.ai", widgets: true, oauth: true },
  { id: "chatgpt", name: "ChatGPT", widgets: true, oauth: true },
];

/** Where a person adds a connector, and the host the sign-in goes back to. */
const WEB_APPS: Record<string, { open?: string; where: Key; host: string }> = {
  "claude-ai": {
    open: "https://claude.ai/settings/connectors",
    where: "integrate.claudeAiWhere",
    host: "claude.ai",
  },
  "claude-desktop": { where: "integrate.desktopWhere", host: "claude.ai" },
  chatgpt: { where: "integrate.chatgptWhere", host: "chatgpt.com" },
};

export function CopyLine({ text, muted }: { text: string; muted?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg bg-paper-2 p-3",
        muted && "text-ink-3 opacity-80",
      )}
    >
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[0.75rem] leading-relaxed">
        {text}
      </code>
      <IconButton
        label={copied ? t("settings.copied") : t("settings.copy")}
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </IconButton>
    </div>
  );
}

/** Claude Code fetches no plugin archive from a local host, and claude.ai cannot reach one. */
function isPublicHttps(href: string): boolean {
  try {
    const url = new URL(href);
    return (
      url.protocol === "https:" &&
      !/(^|\.)localhost$/.test(url.hostname) &&
      !/^(127\.|10\.|192\.168\.|\[::1\])/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[0.875rem] text-ink-3 leading-relaxed">{children}</p>;
}

/** A heading of the panel, with its hint below. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-border-soft border-t pt-5 first:border-t-0 first:pt-0">
      <h3 className="font-medium text-[0.9375rem]">{title}</h3>
      {children}
    </section>
  );
}

/** Where the WordPress plugin is downloaded: the latest release of its own repository. */
const WORDPRESS_ZIP =
  "https://github.com/engenty/engenty-wizards-wp-plugin/releases/latest/download/engenty-wizards.zip";

/**
 * WordPress: the plugin "engenty wizards" puts published wizards on a WordPress site. It connects
 * to an account on engenty.ai (sign-up or sign-in from the WordPress admin), so a local install
 * gets there by publishing to its linked account.
 */
function WordPressPanel({ managed }: { managed: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-display font-semibold text-[1.375rem] leading-tight tracking-tight">
          WordPress
        </h2>
        <p className="mt-1 text-[0.9375rem] text-ink-2">{t("integrate.wpIntro")}</p>
      </div>
      <Card className="flex flex-col gap-5 p-5">
        <Part title={t("integrate.wpInstall")}>
          <Hint>{t("integrate.wpInstallHint")}</Hint>
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(WORDPRESS_ZIP, "_blank")}
            >
              {t("integrate.wpDownload")}
            </Button>
          </div>
        </Part>
        <Part title={t("integrate.wpConnect")}>
          <Hint>{t(managed ? "integrate.wpConnectHint" : "integrate.wpConnectLocal")}</Hint>
        </Part>
        <Part title={t("integrate.wpPlace")}>
          <Hint>{t("integrate.wpPlaceHint")}</Hint>
          <CopyLine
            text={`[engenty_wizard id="ID" mode="modal" label="${t("integrate.wpSampleLabel")}"]`}
          />
        </Part>
        <Part title={t("integrate.wpPro")}>
          <Hint>{t("integrate.wpProHint")}</Hint>
        </Part>
        <Part title={t("integrate.wpLocal")}>
          <Hint>{t("integrate.wpLocalHint")}</Hint>
        </Part>
      </Card>
    </div>
  );
}

/** A JSON file entry with the server at its address. */
function jsonEntry(at: string, entry: Record<string, unknown>) {
  return JSON.stringify({ [at]: { [NAME]: entry } }, null, 2);
}

/**
 * How a client adds the server at its address. Alone, the client signs in with an API key that
 * goes right into the command; managed, it signs in over OAuth at the Manage-App on first use.
 */
function AddByAddress({ id, url, apiKey }: { id: string; url: string; apiKey?: string }) {
  const bearer = apiKey ? `Authorization: Bearer ${apiKey}` : null;
  const headers = apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {};
  switch (id) {
    case "claude-code": {
      const plugin = url.replace(/\/api\/mcp$/, "/api/claude-plugin");
      return (
        <>
          <Hint>{t("mcp.terminal")}</Hint>
          <CopyLine
            text={`claude mcp add --transport http --scope user ${NAME} ${url}${bearer ? ` --header "${bearer}"` : ""}`}
          />
          {!apiKey && isPublicHttps(url) ? (
            <>
              <Hint>{t("mcp.ccPlugin")}</Hint>
              <CopyLine text={`claude plugin marketplace add ${plugin}/marketplace.json`} />
              <CopyLine text={`claude plugin install ${NAME}@engenty`} />
            </>
          ) : null}
        </>
      );
    }
    case "codex":
      return apiKey ? (
        <>
          <Hint>{t("mcp.codexKey")}</Hint>
          <CopyLine text={`echo 'export ${KEY_VAR}=${apiKey}' >> ~/.zshrc && source ~/.zshrc`} />
          <CopyLine text={`codex mcp add ${NAME} --url ${url} --bearer-token-env-var ${KEY_VAR}`} />
        </>
      ) : (
        <>
          <Hint>{t("mcp.terminal")}</Hint>
          <CopyLine text={`codex mcp add ${NAME} --url ${url}`} />
          <CopyLine text={`codex mcp login ${NAME}`} />
        </>
      );
    case "antigravity":
      return (
        <>
          <Hint>{t("mcp.terminal")}</Hint>
          <CopyLine text={`agy mcp add${bearer ? ` -H "${bearer}"` : ""} ${NAME} ${url}`} />
        </>
      );
    case "cursor":
      return (
        <>
          <Hint>{t("integrate.file", { file: "~/.cursor/mcp.json" })}</Hint>
          <CopyLine text={jsonEntry("mcpServers", { url, ...headers })} />
        </>
      );
    case "vscode":
      return (
        <>
          <Hint>{t("integrate.vscode")}</Hint>
          <CopyLine text={jsonEntry("servers", { type: "http", url, ...headers })} />
        </>
      );
    case "windsurf":
      return (
        <>
          <Hint>{t("integrate.file", { file: "~/.codeium/windsurf/mcp_config.json" })}</Hint>
          <CopyLine text={jsonEntry("mcpServers", { serverUrl: url, ...headers })} />
        </>
      );
    case "lm-studio":
      return (
        <>
          <Hint>{t("integrate.file", { file: "~/.lmstudio/mcp.json" })}</Hint>
          <CopyLine text={jsonEntry("mcpServers", { url, ...headers })} />
        </>
      );
    case "claude-desktop":
    case "claude-ai":
      return (
        <>
          <Hint>{t("mcp.claudeAi")}</Hint>
          <CopyLine text={url} />
        </>
      );
    case "chatgpt":
      return (
        <>
          <Hint>{t("integrate.chatgpt")}</Hint>
          <CopyLine text={url} />
        </>
      );
    default:
      return (
        <>
          <Hint>{t("integrate.generic")}</Hint>
          <CopyLine text={url} />
          {bearer ? <CopyLine text={bearer} /> : null}
        </>
      );
  }
}

/** The keys this runtime has handed out; each one signs one client in. */
function KeyList() {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.get<ApiKeyRow[]>("/api/studio/api-keys"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/studio/api-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
  if (!keys.data?.length) {
    return null;
  }
  return (
    <section>
      <h2 className="font-display font-semibold text-lg">{t("mcp.keys")}</h2>
      <p className="mt-1 mb-4 text-[0.875rem] text-ink-3">{t("mcp.keysHint")}</p>
      <Card className="flex flex-col gap-2 p-3">
        {keys.data.map((k) => (
          <div key={k.id} className="flex items-center gap-3 rounded-lg px-3 py-2">
            <KeyRound className="size-4 shrink-0 text-ink-4" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.875rem]">{k.name}</div>
              <div className="font-mono text-[0.6875rem] text-ink-4">
                {k.start}… ·{" "}
                {k.lastRequest
                  ? t("settings.lastUsed", { when: new Date(k.lastRequest).toLocaleString(lang) })
                  : t("settings.neverUsed")}
              </div>
            </div>
            <IconButton
              label={t("settings.revoke")}
              onClick={() => revoke.mutate(k.id)}
              className="hover:text-rose"
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
      </Card>
    </section>
  );
}

// --- where an app stands --------------------------------------------------------

type Standing = "works" | "added" | "none";

/** Works once it called a tool; added once it is entered here or checked in. */
function standingOf(local: LocalApp | undefined, seen: Seen | undefined): Standing {
  if (seen?.toolAt) {
    return "works";
  }
  return local?.connected || seen ? "added" : "none";
}

const TONE: Record<Standing, MenuTone | undefined> = {
  works: "done",
  added: "on",
  none: undefined,
};

const STANDING_LABEL = {
  works: "integrate.stateWorks",
  added: "integrate.stateAdded",
  none: "integrate.stateNone",
} as const;

/** The dot a menu row shows, drawn the same for the legend. */
function Dot({ standing }: { standing: Standing }) {
  return standing === "none" ? (
    <span className="w-2 text-center text-ink-4 leading-none">–</span>
  ) : (
    <span
      className={cn("size-2 shrink-0 rounded-full", standing === "works" ? "bg-moss" : "bg-ember")}
    />
  );
}

/** What the dots in the menu mean. */
function Legend() {
  return (
    <div className="mt-5 flex flex-col gap-1.5 rounded-lg bg-paper-2 px-3 py-2.5 text-[0.75rem] text-ink-3">
      {(["works", "added", "none"] as const).map((s) => (
        <span key={s} className="flex items-center gap-2.5">
          <Dot standing={s} />
          {t(STANDING_LABEL[s])}
        </span>
      ))}
    </div>
  );
}

/** What a person gets in the app, in their words: the run in the chat, the wizard as a window. */
function Outcomes({ client, signIn }: { client: Client; signIn?: boolean }) {
  const chip = (icon: ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[0.8125rem] text-ink-2 ring-1 ring-border-soft">
      {icon}
      {label}
    </span>
  );
  const done = <Check className="size-3.5 text-moss" strokeWidth={3} />;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {chip(done, t("integrate.outRun"))}
      {client.widgets
        ? chip(done, t("integrate.outWidget"))
        : chip(<Text className="size-3.5 text-ink-3" />, t("integrate.outText"))}
      {signIn ? chip(<Lock className="size-3.5 text-ink-3" />, t("integrate.outSignIn")) : null}
    </div>
  );
}

function PanelHead({
  client,
  works,
  children,
}: {
  client: Client;
  works: boolean;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-display font-semibold text-[1.375rem] leading-tight tracking-tight">
          {client.name}
        </h2>
        {works ? (
          <Chip tone="live" icon={<Check className="size-3.5" strokeWidth={3} />}>
            {t("integrate.works")}
          </Chip>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// --- steps ------------------------------------------------------------------------

/**
 * One numbered step. `done`: ticked; `now`: the one to do, marked; `todo`: to do, in any order;
 * `later`: ahead, shown faint so the person sees how it ends.
 */
function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: "done" | "now" | "todo" | "later";
  title: string;
  children?: ReactNode;
}) {
  return (
    <li
      aria-current={state === "now" ? "step" : undefined}
      className={cn(
        "grid grid-cols-[28px_minmax(0,1fr)] gap-x-3.5 rounded-xl px-3 py-3",
        state === "now" && "bg-ember-tint/40 ring-1 ring-ember-strong/25",
      )}
    >
      <span
        className={cn(
          "grid size-7 place-items-center rounded-full font-semibold text-[0.8125rem]",
          state === "done" && "bg-moss text-white",
          (state === "now" || state === "todo") && "bg-primary text-primary-foreground",
          state === "later" && "bg-paper text-ink-3 ring-1 ring-border",
        )}
      >
        {state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : n}
      </span>
      <div className="flex min-w-0 flex-col gap-2 pt-1">
        <span className={cn("font-medium text-[0.9375rem]", state === "later" && "text-ink-2")}>
          {title}
        </span>
        {children ? (
          <div className={cn("flex flex-col gap-2", state === "later" && "opacity-70")}>
            {children}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <Card className="p-3 sm:p-4">
      <h3 className="px-3 pt-2 pb-2 font-medium text-[0.9375rem]">{t("integrate.steps")}</h3>
      <ol className="flex flex-col gap-1">{children}</ol>
    </Card>
  );
}

/** A line under a step: waiting for the app to show up, no spinner — nothing for the person to wait on. */
function Waiting({ app }: { app: string }) {
  return (
    <p className="flex items-center gap-2 text-[0.8125rem] text-ember-strong">
      <span className="size-2 rounded-full bg-ember" />
      {t("integrate.waiting", { app })}
    </p>
  );
}

/** The three checks of an app that connects from afar: connected, a tool, the wizard shown. */
function Checks({ client, seen }: { client: Client; seen: Seen | undefined }) {
  const row = (done: boolean, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      {done ? (
        <Check className="size-3.5 text-moss" strokeWidth={3} />
      ) : (
        <span className="size-2.5 rounded-full ring-2 ring-ink-4 ring-inset" />
      )}
      {label}
    </span>
  );
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-ink-2">
      {row(Boolean(seen), t("integrate.checkSeen"))}
      {row(Boolean(seen?.toolAt), t("integrate.checkTool"))}
      {client.widgets ? row(Boolean(seen?.widgetAt), t("integrate.checkWidget")) : null}
    </p>
  );
}

/** A wizard of the space to name in the first prompts: a published one, if there is one. */
function useExampleWizard(): WizardSummary | null {
  const me = useMe().data;
  const { project } = useCurrentProject();
  const wizards = useQuery({
    queryKey: ["wizards", project?.id, Boolean(me?.account)],
    queryFn: () => api.get<WizardSummary[]>(`/api/studio/projects/${project!.id}/wizards`),
    enabled: Boolean(project),
  });
  const list = wizards.data ?? [];
  return list.find((w) => w.published) ?? list[0] ?? null;
}

/** The app works: what to say to it first, with the space's own wizards. */
function Done({ client, footer }: { client: Client; footer?: ReactNode }) {
  const wizard = useExampleWizard();
  const prompts: { label: string; text: string }[] = wizard
    ? [
        { label: t("integrate.labelRun"), text: t("integrate.askRun", { title: wizard.title }) },
        { label: t("integrate.labelBuild"), text: t("integrate.askBuild") },
        {
          label: t("integrate.labelExplain"),
          text: t("integrate.askExplain", { title: wizard.title }),
        },
      ]
    : [
        { label: t("integrate.labelAsk"), text: t("integrate.askTool") },
        { label: t("integrate.labelBuild"), text: t("integrate.askBuild") },
      ];
  return (
    <>
      <Card className="flex flex-col gap-4 p-5 sm:p-6">
        <div>
          <h3 className="font-medium text-[0.9375rem]">{t("integrate.next")}</h3>
          <Hint>{t("integrate.nextHint", { app: client.name })}</Hint>
        </div>
        <ul className="flex flex-col gap-2">
          {prompts.map((p) => (
            <li
              key={p.label}
              className="grid items-start gap-1 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-3"
            >
              <span className="pt-3 text-[0.75rem] text-ink-3">{p.label}</span>
              <CopyLine text={p.text} />
            </li>
          ))}
        </ul>
      </Card>
      {client.widgets ? null : (
        <p className="flex items-start gap-3 rounded-xl bg-paper-2 px-4 py-3 text-[0.875rem] text-ink-2 leading-relaxed">
          <Text className="mt-0.5 size-4 shrink-0 text-ink-3" />
          {t("integrate.textOnly", { app: client.name })}
        </p>
      )}
      {footer}
    </>
  );
}

/** Small links under a panel: what is entered where, and the way out. */
function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-ink-3">
      {children}
    </div>
  );
}

const linkClass =
  "inline-flex items-center gap-1 text-ember-strong underline-offset-2 transition hover:underline";

// --- the panels -----------------------------------------------------------------

/**
 * An app on this computer, one click: entered into its config as the command `wizards mcp`, a
 * restart, a first sentence in the chat. Another computer goes by the address and an API key.
 */
function HerePanel({
  client,
  local,
  seen,
  url,
}: {
  client: Client;
  local: LocalApp | undefined;
  seen: Seen | undefined;
  url: string;
}) {
  const qc = useQueryClient();
  const [byAddress, setByAddress] = useState(false);
  const [said, setSaid] = useState<Outcome | null>(null);
  const [details, setDetails] = useState(false);
  const change = useMutation({
    mutationFn: (connect: boolean) =>
      api.post<Outcome>(`/api/studio/local/apps/${client.id}`, { connect }),
    onSuccess: (outcome) => setSaid(outcome),
    onError: (error) => setSaid({ ok: false, message: (error as Error).message }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["local-apps"] }),
  });
  const connected = Boolean(local?.connected);
  const works = Boolean(seen?.toolAt);
  if (byAddress) {
    return (
      <AddressPanel client={client} seen={seen} url={url} onBack={() => setByAddress(false)} />
    );
  }
  // Under step 1 its title says where it is entered; under the done page this line says it.
  const entered = (named: boolean) => (
    <>
      {named ? <span>{t("integrate.addedIn", { app: client.name })}</span> : null}
      <button type="button" className={linkClass} onClick={() => setDetails(!details)}>
        {t("integrate.details")}
        <ChevronRight className={cn("size-3.5 transition", details && "rotate-90")} />
      </button>
      <button
        type="button"
        className={linkClass}
        disabled={change.isPending}
        onClick={() => change.mutate(false)}
      >
        {t("mcp.appsDisconnect")}
      </button>
    </>
  );
  const where =
    details && local?.where ? (
      <p className="w-full font-mono text-[0.6875rem] text-ink-4">{local.where}</p>
    ) : null;
  return (
    <div className="flex flex-col gap-5">
      <PanelHead client={client} works={works}>
        <Outcomes client={client} />
      </PanelHead>
      {works ? (
        <Done
          client={client}
          footer={
            <Footer>
              {entered(true)}
              {where}
            </Footer>
          }
        />
      ) : (
        <Steps>
          <Step
            n={1}
            state={connected ? "done" : "now"}
            title={
              connected
                ? t("integrate.connected", { app: client.name })
                : t("integrate.connect", { app: client.name })
            }
          >
            {connected ? (
              <Footer>
                {entered(false)}
                {where}
              </Footer>
            ) : (
              <>
                <Hint>
                  {local?.installed === false
                    ? t("integrate.notInstalled", { app: client.name })
                    : t("integrate.connectHint", { app: client.name })}
                </Hint>
                <div>
                  <Button busy={change.isPending} onClick={() => change.mutate(true)}>
                    <Plus className="size-4" /> {t("integrate.connect", { app: client.name })}
                  </Button>
                </div>
              </>
            )}
            {said && !said.ok ? <p className="text-[0.8125rem] text-rose">{said.message}</p> : null}
            {said?.snippet ? <CopyLine text={said.snippet} /> : null}
          </Step>
          <Step
            n={2}
            state={seen ? "done" : connected ? "now" : "later"}
            title={t("integrate.restart", { app: client.name })}
          >
            {seen ? null : (
              <>
                <Hint>{t("integrate.restartHint")}</Hint>
                {connected ? <Waiting app={client.name} /> : null}
              </>
            )}
          </Step>
          <Step n={3} state={seen ? "now" : "later"} title={t("integrate.try")}>
            <Hint>{t("integrate.tryHint")}</Hint>
            <CopyLine text={t("integrate.askTool")} muted={!seen} />
          </Step>
        </Steps>
      )}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.875rem] text-ink-2">
        <Globe className="size-4 text-ink-3" />
        {t("integrate.elsewhere", { app: client.name })}
        <button type="button" className={linkClass} onClick={() => setByAddress(true)}>
          {t("integrate.byAddress")}
        </button>
      </p>
    </div>
  );
}

/** An app on another computer, or one that cannot start the command: the address and an API key. */
function AddressPanel({
  client,
  seen,
  url,
  onBack,
}: {
  client: Client;
  seen: Seen | undefined;
  url: string;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState<string>();
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; name: string; key: string }>("/api/studio/api-keys", {
        name: client.name.slice(0, 32),
      }),
    onSuccess: async (created) => {
      setApiKey(created.key);
      await qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const back = (
    <p className="text-[0.875rem]">
      <button type="button" className={linkClass} onClick={onBack}>
        <Monitor className="size-4" />
        {t("integrate.backHere")}
      </button>
    </p>
  );
  if (seen?.toolAt) {
    return (
      <div className="flex flex-col gap-5">
        <PanelHead client={client} works>
          <Outcomes client={client} />
        </PanelHead>
        <Done client={client} footer={back} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <PanelHead client={client} works={false}>
        <Outcomes client={client} />
      </PanelHead>
      <Steps>
        <Step
          n={1}
          state={apiKey ? "done" : "now"}
          title={apiKey ? t("integrate.keyReady") : t("integrate.keyCreate", { app: client.name })}
        >
          {apiKey ? null : (
            <>
              <Hint>{t("integrate.keyHint", { app: client.name })}</Hint>
              <div>
                <Button variant="secondary" busy={create.isPending} onClick={() => create.mutate()}>
                  <KeyRound className="size-4" /> {t("integrate.keyCreate", { app: client.name })}
                </Button>
              </div>
            </>
          )}
        </Step>
        <Step n={2} state={apiKey ? (seen ? "done" : "now") : "later"} title={t("integrate.add")}>
          {apiKey && !seen ? (
            <>
              <AddByAddress id={client.id} url={url} apiKey={apiKey} />
              <p className="text-[0.75rem] text-ink-4">{t("integrate.addressLocal")}</p>
              <Waiting app={client.name} />
            </>
          ) : null}
        </Step>
        <Step n={3} state={seen ? "now" : "later"} title={t("integrate.try")}>
          <Hint>{t("integrate.tryHint")}</Hint>
          <CopyLine text={t("integrate.askTool")} muted={!seen} />
        </Step>
      </Steps>
      {back}
    </div>
  );
}

/** What the consent page will look like, so the window that opens is no surprise. */
function ConsentPreview({ app, host }: { app: string; host: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex w-56 shrink-0 flex-col items-center gap-2 rounded-xl bg-paper px-4 py-3.5 text-center ring-1 ring-border-soft"
    >
      <span className="font-display font-semibold text-[0.8125rem] leading-snug">
        {t("integrate.consentPreview", { app })}
      </span>
      <span className="inline-flex items-center gap-1 text-[0.6875rem] text-moss">
        <Lock className="size-3" />
        {host}
      </span>
      <span className="flex w-full gap-1.5">
        <span className="h-5 flex-1 rounded-full bg-card ring-1 ring-border" />
        <span className="h-5 flex-1 rounded-full bg-primary" />
      </span>
    </div>
  );
}

/**
 * An app that connects from its maker's servers — claude.ai, ChatGPT, Claude Desktop's
 * connectors: open its settings, enter name and address, sign in and allow, a first sentence.
 */
function WebSteps({
  client,
  url,
  seen,
  tracked,
  accountUrl,
}: {
  client: Client;
  url: string;
  seen?: Seen;
  /** This server sees the app's calls; not so where it is another one (a linked account's cloud). */
  tracked: boolean;
  accountUrl: string | null;
}) {
  const web = WEB_APPS[client.id] ?? WEB_APPS["claude-desktop"];
  const shown = client.id === "chatgpt" ? "ChatGPT" : "Claude";
  return (
    <>
      <Steps>
        <Step n={1} state="todo" title={t("integrate.open", { app: client.name })}>
          {web.open ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => openExternal(web.open!)}>
                {t("integrate.openConnectors")}
                <ExternalLink className="size-4" />
              </Button>
              <Hint>{t(web.where)}</Hint>
            </div>
          ) : (
            <Hint>{t(web.where)}</Hint>
          )}
        </Step>
        <Step n={2} state="todo" title={t("integrate.nameAddress")}>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-[0.75rem] text-ink-3">{t("integrate.name")}</span>
              <CopyLine text={CONNECTOR_NAME} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[0.75rem] text-ink-3">{t("integrate.address")}</span>
              <CopyLine text={url} />
            </div>
          </div>
        </Step>
        <Step n={3} state={seen ? "done" : "todo"} title={t("integrate.allow")}>
          {seen ? null : (
            <div className="flex flex-wrap items-center gap-4">
              <p className="min-w-0 flex-[1_1_16rem] text-[0.875rem] text-ink-3 leading-relaxed">
                {t("integrate.allowHint")}
              </p>
              <ConsentPreview app={shown} host={web.host} />
            </div>
          )}
        </Step>
        <Step
          n={4}
          state={seen?.toolAt ? "done" : seen ? "now" : "later"}
          title={t("integrate.try")}
        >
          {seen?.toolAt ? null : <CopyLine text={t("integrate.askTool")} muted={!seen} />}
          {tracked ? <Checks client={client} seen={seen} /> : null}
        </Step>
      </Steps>
      {accountUrl ? <Revoke accountUrl={accountUrl} /> : null}
    </>
  );
}

function Revoke({ accountUrl }: { accountUrl: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-ink-3">
      {t("integrate.revoke")}
      <button type="button" className={linkClass} onClick={() => openExternal(accountUrl)}>
        {t("integrate.revokeLink")}
        <ArrowRight className="size-3.5" />
      </button>
    </p>
  );
}

/**
 * claude.ai or ChatGPT next to a local install: they cannot reach this computer, the account's
 * cloud they can. Without an account linked, the way to one — and the way without: Claude Desktop.
 */
function ViaAccount({ client, me, onDesktop }: { client: Client; me: Me; onDesktop: () => void }) {
  const account = me.account?.signedIn ? me.account : null;
  const linking = useAccountLink(Boolean(account));
  const canLink = featureOn(me.features, "account");
  return (
    <div className="flex flex-col gap-5">
      <PanelHead client={client} works={false}>
        <p className="mt-2 max-w-2xl text-[0.9375rem] text-ink-2 leading-relaxed">
          {t("integrate.remoteWhy", { app: client.name })}
        </p>
      </PanelHead>
      {account ? (
        <>
          <p className="flex items-start gap-2 text-[0.875rem] text-ink-2">
            <Cloud className="mt-0.5 size-4 shrink-0 text-ink-3" />
            {t("integrate.linked", { email: account.email, app: client.name })}
          </p>
          <WebSteps
            client={client}
            url={`${account.cloudUrl}/api/mcp`}
            tracked={false}
            accountUrl={account.url}
          />
        </>
      ) : canLink ? (
        <Card className="flex flex-col gap-5 p-5 sm:p-6">
          <h3 className="font-medium text-[0.9375rem]">{t("integrate.viaAccount")}</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: Monitor, title: t("integrate.tileHere"), text: t("integrate.tileHereText") },
              { icon: Cloud, title: "engenty.ai", text: t("integrate.tileCloudText") },
              { icon: MessageCircle, title: client.name, text: t("integrate.tileAppText") },
            ].map((tile) => (
              <div key={tile.title} className="flex flex-col gap-2 rounded-xl bg-paper px-4 py-3.5">
                <span className="flex items-center gap-2 font-medium">
                  <tile.icon className="size-4 text-ink-2" />
                  {tile.title}
                </span>
                <span className="text-[0.8125rem] text-ink-3 leading-relaxed">{tile.text}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button busy={linking.link.isPending} onClick={() => linking.link.mutate({})}>
              <Cloud className="size-4" /> {t("integrate.linkAccount")}
            </Button>
            <span className="text-[0.8125rem] text-ink-3">
              {t("integrate.linkHint", { app: client.name })}
            </span>
          </div>
          <LinkStatus {...linking} />
        </Card>
      ) : null}
      {account ? null : (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-paper-2 px-4 py-3 text-[0.875rem] text-ink-2">
          {t("integrate.noAccount")}
          <button type="button" className={linkClass} onClick={onDesktop}>
            {t("integrate.useDesktop")}
            <ArrowRight className="size-3.5" />
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * An app on the person's computer next to the cloud: the server at its address, the sign-in on
 * first use over OAuth at the Manage-App, a first sentence.
 */
function ManagedAppPanel({
  client,
  seen,
  url,
  me,
}: {
  client: Client;
  seen: Seen | undefined;
  url: string;
  me: Me;
}) {
  const works = Boolean(seen?.toolAt);
  const accountUrl = me.manageUrl ? `${me.manageUrl}/account` : null;
  return (
    <div className="flex flex-col gap-5">
      <PanelHead client={client} works={works}>
        <Outcomes client={client} signIn />
      </PanelHead>
      {works ? (
        <Done client={client} />
      ) : (
        <Steps>
          <Step n={1} state={seen ? "done" : "now"} title={t("integrate.add")}>
            {seen ? null : <AddByAddress id={client.id} url={url} />}
          </Step>
          <Step n={2} state={seen ? "done" : "later"} title={t("integrate.allowFirst")}>
            {seen ? null : <Hint>{t("integrate.allowFirstHint", { app: client.name })}</Hint>}
          </Step>
          <Step n={3} state={seen ? "now" : "later"} title={t("integrate.try")}>
            <CopyLine text={t("integrate.askTool")} muted={!seen} />
          </Step>
        </Steps>
      )}
      {accountUrl ? <Revoke accountUrl={accountUrl} /> : null}
    </div>
  );
}

// --- the start ------------------------------------------------------------------

/** One app on the start page: where it stands, what it shows, one button. */
function AppCard({
  client,
  standing,
  onOpen,
  onConnect,
  busy,
}: {
  client: Client;
  standing: Standing;
  onOpen: () => void;
  /** Set where one click enters it right away. */
  onConnect?: () => void;
  busy?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-paper-2 text-ink-2">
          {client.widgets ? <AppWindow className="size-5" /> : <Wrench className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{client.name}</div>
          <div
            className={cn(
              "flex items-center gap-1.5 text-[0.8125rem]",
              standing === "works" && "font-medium text-moss",
              standing === "added" && "text-ember-strong",
              standing === "none" && "text-ink-3",
            )}
          >
            {standing === "works" ? <Check className="size-3.5" strokeWidth={3} /> : null}
            {t(STANDING_LABEL[standing])}
          </div>
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-[0.75rem] text-ink-3">
        {client.widgets ? <AppWindow className="size-3.5" /> : <Text className="size-3.5" />}
        {t(client.widgets ? "integrate.outWidget" : "integrate.outText")}
      </p>
      <div>
        {standing === "none" && onConnect ? (
          <Button size="sm" variant="secondary" busy={busy} onClick={onConnect}>
            {t("integrate.connectShort")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant={standing === "added" ? "primary" : "secondary"}
            onClick={onOpen}
          >
            {t(
              standing === "works"
                ? "integrate.view"
                : standing === "added"
                  ? "integrate.testIt"
                  : "integrate.connectShort",
            )}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** The start of the page: what it is for, the apps on this computer, the way to the browser apps. */
function Overview({
  managed,
  here,
  web,
  standing,
  open,
}: {
  managed: boolean;
  here: Client[];
  web: Client[];
  standing: (id: string) => Standing;
  open: (id: string) => void;
}) {
  const qc = useQueryClient();
  const connect = useMutation({
    mutationFn: (id: string) =>
      api.post<Outcome>(`/api/studio/local/apps/${id}`, { connect: true }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["local-apps"] }),
    onSuccess: (_, id) => open(id),
  });
  const grid = (clients: Client[], local: boolean) => (
    <div className="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
      {clients.map((c) => (
        <AppCard
          key={c.id}
          client={c}
          standing={standing(c.id)}
          onOpen={() => open(c.id)}
          onConnect={local ? () => connect.mutate(c.id) : undefined}
          busy={connect.isPending && connect.variables === c.id}
        />
      ))}
    </div>
  );
  return (
    <div className="flex flex-col gap-9">
      <div>
        <h2 className="font-display font-semibold text-[1.625rem] leading-tight tracking-tight">
          {t("integrate.title")}
        </h2>
        <p className="mt-2 max-w-2xl text-[0.9375rem] text-ink-2 leading-relaxed">
          {t(managed ? "integrate.introManaged" : "integrate.intro")}
        </p>
      </div>
      {managed ? (
        <>
          <section className="flex flex-col gap-3">
            <h3 className="font-display font-semibold text-lg">{t("integrate.groupBrowser")}</h3>
            {grid(web, false)}
          </section>
          <section className="flex flex-col gap-3">
            <h3 className="font-display font-semibold text-lg">{t("integrate.groupDesktop")}</h3>
            {grid(here, false)}
          </section>
        </>
      ) : (
        <>
          {here.length ? (
            <section className="flex flex-col gap-3">
              <h3 className="font-display font-semibold text-lg">{t("integrate.found")}</h3>
              {grid(here, true)}
            </section>
          ) : null}
          <section className="flex flex-col gap-3">
            <h3 className="font-display font-semibold text-lg">{t("integrate.groupCloud")}</h3>
            <Card className="flex flex-wrap items-center gap-4 p-5">
              <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-paper-2 text-ink-2">
                <Cloud className="size-5" />
              </span>
              <div className="min-w-0 flex-[1_1_18rem]">
                <div className="font-medium">{t("integrate.cloudTitle")}</div>
                <p className="text-[0.8125rem] text-ink-3 leading-relaxed">
                  {t("integrate.cloudText")}
                </p>
              </div>
              <Button variant="secondary" onClick={() => open("claude-ai")}>
                {t("integrate.cloudButton")}
              </Button>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * "Integrate": the wizards in the AI apps a person already uses. It starts with what the page is
 * for and the apps found here; each app then walks through numbered steps to its first sentence in
 * the chat — one click on this computer, the address and an API key from another, the sign-in at
 * engenty for the apps that connect from their maker's servers. Sharing by link and on a website
 * come later.
 */
export function Integrate() {
  const me = useMe();
  const managed = me.data?.mode === "managed";
  const apps = useQuery({
    queryKey: ["local-apps"],
    queryFn: () => api.get<LocalApp[]>("/api/studio/local/apps"),
    enabled: me.data?.mode === "local",
  });
  const seen = useQuery({
    queryKey: ["integrations-seen"],
    queryFn: () => api.get<Record<string, Seen>>("/api/studio/integrations/seen"),
    refetchInterval: 2500,
  });
  const [params, setParams] = useSearchParams();
  const { narrow } = useSettingsMenu();
  const show = params.get("show");
  const current = CLIENTS.find((c) => c.id === show) ?? null;
  useDetail(show === "wordpress" ? "WordPress" : (current?.name ?? null));
  if (!me.data || (!managed && !apps.data)) {
    return null;
  }
  const localOf = (id: string) => apps.data?.find((app) => app.id === id);
  const seenOf = (id: string) => seen.data?.[id];
  const standing = (id: string) => standingOf(localOf(id), seenOf(id));
  const open = (id: string) => setParams({ show: id }, { replace: !narrow });
  const found = (c: Client) => Boolean(localOf(c.id)?.installed || localOf(c.id)?.connected);
  // Alone: the apps on this computer, claude.ai and ChatGPT through the account, the rest folded.
  // In the cloud: the apps in the browser, the ones on a computer.
  const web = CLIENTS.filter((c) => c.oauth);
  const here = CLIENTS.filter((c) => !c.oauth && (managed || found(c)));
  const more = managed ? [] : CLIENTS.filter((c) => !c.oauth && !found(c));
  const url = me.data.mcpUrl ?? "";
  const row = (c: Client) => (
    <MenuRow
      key={c.id}
      icon={c.oauth ? Cloud : c.widgets ? AppWindow : Wrench}
      label={c.name}
      tone={TONE[standing(c.id)]}
      toneLabel={t(STANDING_LABEL[standing(c.id)])}
      selected={c.id === current?.id}
      onPick={() => open(c.id)}
    />
  );
  const accountUrl = me.data.manageUrl ? `${me.data.manageUrl}/account` : null;

  let page: ReactNode;
  if (show === "wordpress") {
    page = <WordPressPanel managed={managed} />;
  } else if (!current) {
    page = <Overview managed={managed} here={here} web={web} standing={standing} open={open} />;
  } else if (managed && (current.oauth || current.connector)) {
    // These connect from their maker's servers (Claude Desktop through its connectors).
    page = isPublicHttps(url) ? (
      <div className="flex flex-col gap-5">
        <PanelHead client={current} works={Boolean(seenOf(current.id)?.toolAt)}>
          <Outcomes client={current} signIn />
        </PanelHead>
        {seenOf(current.id)?.toolAt ? (
          <Done client={current} footer={accountUrl ? <Revoke accountUrl={accountUrl} /> : null} />
        ) : (
          <WebSteps
            client={current}
            url={url}
            seen={seenOf(current.id)}
            tracked
            accountUrl={accountUrl}
          />
        )}
      </div>
    ) : (
      <div className="flex flex-col gap-5">
        <PanelHead client={current} works={false} />
        <Hint>{t("integrate.needsPublic", { app: current.name })}</Hint>
      </div>
    );
  } else if (managed) {
    page = <ManagedAppPanel client={current} seen={seenOf(current.id)} url={url} me={me.data} />;
  } else if (current.oauth) {
    page = <ViaAccount client={current} me={me.data} onDesktop={() => open("claude-desktop")} />;
  } else {
    page = (
      <HerePanel client={current} local={localOf(current.id)} seen={seenOf(current.id)} url={url} />
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <SubMenu>
        <MenuGroup label={t(managed ? "integrate.groupBrowser" : "integrate.groupHere")}>
          {(managed ? web : here).map(row)}
        </MenuGroup>
        <MenuGroup label={t(managed ? "integrate.groupDesktop" : "integrate.groupCloud")}>
          {(managed ? here : web).map(row)}
        </MenuGroup>
        {more.length ? (
          <MenuGroup
            label={t("integrate.groupMore")}
            collapsible
            open={more.some((c) => c.id === current?.id)}
            count={more.length}
          >
            {more.map(row)}
          </MenuGroup>
        ) : null}
        <MenuGroup label={t("integrate.groupShare")}>
          <MenuRow
            icon={Link2}
            label={t("integrate.shareLink")}
            badge={<span className="text-[0.6875rem] text-ink-4">{t("integrate.soon")}</span>}
            selected={false}
            disabled
          />
          <MenuRow
            icon={Globe}
            label="WordPress"
            selected={show === "wordpress"}
            onPick={() => open("wordpress")}
          />
          <MenuRow
            icon={Globe}
            label={t("integrate.shareSite")}
            badge={<span className="text-[0.6875rem] text-ink-4">{t("integrate.soon")}</span>}
            selected={false}
            disabled
          />
        </MenuGroup>
        <Legend />
      </SubMenu>
      <div key={current?.id ?? "start"}>{page}</div>
      {managed || show === "wordpress" ? null : <KeyList />}
    </div>
  );
}
