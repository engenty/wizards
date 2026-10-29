import { Markdown } from "@engenty/wizards-runner";
import {
  Brain,
  ChevronRight,
  File,
  FileText,
  Globe,
  ListChecks,
  type LucideIcon,
  Puzzle,
  Search,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Table2,
  Tag,
  Wrench,
} from "lucide-react";
import { createContext, Fragment, type ReactNode, useContext, useEffect, useState } from "react";
import { NavLink } from "react-router";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { lang, t } from "../../lib/i18n";
import { Button, cn } from "../../ui";
import type { Approval, ChatPart, ToolLabel } from "./chats";
import { ChatViewPart, VIEW_TOOL, type ViewPart } from "./View";

/**
 * A turn of the space's AI as the chat shows it: its texts, and between them the steps it took
 * (reasoning, tool calls) as one line each in the person's words, grouped where there are several
 * (shadcn/ui Trace; the patterns of AI Elements' Chain of Thought, Reasoning, Tool and Sources).
 * What a tool found reads as rows and chips; its raw input and result wait behind "Details".
 */

export type ToolPart = Extract<ChatPart, { toolCallId: string }>;

export const isTool = (p: ChatPart): p is ToolPart =>
  p.type.startsWith("tool-") && "toolCallId" in p;

const isReasoning = (p: ChatPart): p is { type: "reasoning"; text: string; state?: string } =>
  p.type === "reasoning";

/** The chat's held calls and how to decide them, and the plugins' tool names. */
export const StepsContext = createContext<{
  approvals: Map<string, Approval>;
  may: (a: Approval) => boolean;
  decide: (id: string, approve: boolean) => void;
  busy: boolean;
  tools: Record<string, ToolLabel>;
}>({ approvals: new Map(), may: () => false, decide: () => {}, busy: false, tools: {} });

/** The approval a tool's result names, when the gate held the call. */
export const heldBy = (part: ToolPart): string | null => {
  const output = part.output as { approval?: unknown; status?: unknown } | undefined;
  return output && typeof output.approval === "string" && output.status === "waiting"
    ? output.approval
    : null;
};

/** What a call does, in the person's words: the plugin's label, else its name and the tool's. */
export function labelOf(name: string, tools: Record<string, ToolLabel>): string {
  const plugin = tools[name];
  if (!plugin) {
    return words(name);
  }
  return plugin.label?.[lang] ?? `${plugin.plugin}: ${words(plugin.tool)}`;
}

const words = (name: string) => name.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");

/** A turn's parts in its order: runs of steps between its texts, and the views it showed. */
type Run =
  | { kind: "steps"; parts: ChatPart[] }
  | { kind: "text"; text: string }
  | { kind: "view"; part: ViewPart };

function runsOf(parts: ChatPart[]): Run[] {
  const runs: Run[] = [];
  for (const part of parts) {
    const last = runs.at(-1);
    if (part.type === "text") {
      const text = String((part as { text?: string }).text ?? "");
      if (last?.kind === "text") {
        last.text += text;
      } else if (text) {
        runs.push({ kind: "text", text });
      }
    } else if (part.type === VIEW_TOOL && "toolCallId" in part) {
      runs.push({ kind: "view", part: part as ViewPart });
    } else if (isReasoning(part) || isTool(part)) {
      if (last?.kind === "steps") {
        last.parts.push(part);
      } else {
        runs.push({ kind: "steps", parts: [part] });
      }
    }
  }
  return runs;
}

/**
 * A turn of the space's AI. `live`: its answer streams right now, so its last steps are the
 * ones under way.
 */
export function AiParts({ parts, live, id }: { parts: ChatPart[]; live: boolean; id: string }) {
  const runs = runsOf(parts);
  const sources = sourcesOf(parts);
  const working = live && runs.at(-1)?.kind !== "text";
  return (
    <div className="grid gap-3">
      {runs.map((run, at) =>
        run.kind === "text" ? (
          <Markdown key={`text-${at}`} text={run.text} className="text-[0.9375rem]" />
        ) : run.kind === "view" ? (
          <ChatViewPart key={run.part.toolCallId} part={run.part} live={live} />
        ) : (
          <Fragment key={`steps-${at}`}>
            <Steps
              parts={run.parts}
              running={live && at === runs.length - 1}
              live={live}
              id={`${id.replace(/^pending-/, "")}:${at}`}
            />
            {run.parts
              .filter(isTool)
              .map(heldBy)
              .filter((held): held is string => Boolean(held))
              .map((held) => (
                <ApprovalCard key={held} id={held} />
              ))}
          </Fragment>
        ),
      )}
      {sources.length && !working ? <Sources list={sources} /> : null}
    </div>
  );
}

// --- one step ------------------------------------------------------------------------------------

type Phase = "running" | "done" | "failed" | "denied" | "waiting" | "stopped";

interface StepView {
  key: string;
  icon: LucideIcon;
  title: string;
  /** What came of it, after the title: "keine Treffer", "abgelehnt". */
  detail: string | null;
  phase: Phase;
  /** What it found, readable. */
  body: ReactNode;
  /** Its input and result as they are, behind "Details". */
  raw: { input?: unknown; output?: unknown } | null;
}

const PHASE_WORD: Partial<Record<Phase, Parameters<typeof t>[0]>> = {
  failed: "work.step.failed",
  denied: "work.step.denied",
  waiting: "work.step.waiting",
  stopped: "work.step.stopped",
};

function phaseOf(part: ToolPart, live: boolean, held: string | null, approval?: Approval): Phase {
  if (held) {
    return !approval || approval.state === "pending"
      ? "waiting"
      : approval.state === "approved"
        ? "done"
        : approval.state;
  }
  switch (part.state) {
    case "output-available":
      // A client's failed call is stored as a result that holds only its error.
      return errorOf(part.output) !== null && Object.keys(part.output as object).length === 1
        ? "failed"
        : "done";
    case "output-error":
      return "failed";
    case "output-denied":
      return "denied";
    case "approval-requested":
      return "waiting";
    default:
      // A call without its result once the turn ended was stopped.
      return live ? "running" : "stopped";
  }
}

function toolView(
  part: ToolPart,
  live: boolean,
  approvals: Map<string, Approval>,
  tools: Record<string, ToolLabel>,
): StepView {
  const name = part.type.slice("tool-".length);
  const held = part.state === "output-available" ? heldBy(part) : null;
  const approval = held ? approvals.get(held) : undefined;
  const phase = phaseOf(part, live, held, approval);
  const output = held ? approval?.output : part.output;
  const input = (part.input ?? {}) as Record<string, unknown>;
  const said = PHASE_WORD[phase] ? t(PHASE_WORD[phase]) : null;
  const error = phase === "failed" ? (part.errorText ?? errorOf(output)) : null;
  const errorBody = error ? <p className="text-[0.8125rem] text-danger">{error}</p> : null;
  const base = { key: part.toolCallId, phase };

  if (name === "search_space") {
    const query = typeof input.query === "string" ? input.query : "";
    const hits = hitsOf(output);
    return {
      ...base,
      icon: Search,
      title: t(phase === "running" ? "work.step.searchingSpace" : "work.step.searchedSpace", {
        query,
      }),
      detail:
        said ??
        (phase === "done" && hits
          ? hits.length
            ? t("work.step.hits", { count: hits.length })
            : t("work.step.noHits")
          : null),
      body: hits?.length ? <HitList hits={hits} /> : errorBody,
      raw: hits?.length || error ? { input: part.input, output: output ?? error } : null,
    };
  }
  if (name === "web_search") {
    const asked = input.query ?? input.queries;
    const query = Array.isArray(asked) ? asked.join(", ") : typeof asked === "string" ? asked : "";
    const found = webSourcesOf(output);
    return {
      ...base,
      icon: Globe,
      title: query
        ? t(phase === "running" ? "work.step.searchingWeb" : "work.step.searchedWeb", { query })
        : t(phase === "running" ? "work.step.searchingWebBare" : "work.step.webSearch"),
      detail:
        said ??
        (phase === "done" && found.length ? t("work.step.sources", { count: found.length }) : null),
      body: found.length ? <SourceChips list={found} /> : errorBody,
      raw: found.length || error ? { input: part.input, output: output ?? error } : null,
    };
  }
  return {
    ...base,
    icon: tools[name] ? Puzzle : Wrench,
    title: labelOf(name, tools),
    detail: said ?? (phase === "done" ? summaryOf(output) : null),
    body: errorBody,
    raw: { input: part.input, output: output ?? error ?? undefined },
  };
}

function reasoningView(
  part: { text: string; state?: string },
  key: string,
  running: boolean,
): StepView {
  const text = part.text.trim();
  return {
    key,
    icon: Brain,
    title: t(running ? "work.step.thinking" : "work.step.thought"),
    detail: null,
    phase: running ? "running" : "done",
    body: text ? (
      <p className="whitespace-pre-wrap text-[0.8125rem] leading-relaxed">{text}</p>
    ) : null,
    raw: null,
  };
}

/** One step: its line, and what it found folded under it. */
function StepRow({ view, seconds }: { view: StepView; seconds: number | null }) {
  const line = (
    <TraceLine
      status={view.phase === "running" ? "running" : view.phase === "failed" ? "error" : undefined}
    >
      <TraceIcon>
        <view.icon />
      </TraceIcon>
      <TraceTitle>{view.title}</TraceTitle>
      {view.detail ? (
        <TraceDescription className={view.phase === "waiting" ? "text-ember" : undefined}>
          · {view.detail}
        </TraceDescription>
      ) : null}
      {seconds !== null ? <TraceDescription>· {duration(seconds)}</TraceDescription> : null}
    </TraceLine>
  );
  if (!(view.body || view.raw)) {
    return line;
  }
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="grid gap-2">
        {view.body}
        {view.raw ? <Details raw={view.raw} /> : null}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

// --- several steps -------------------------------------------------------------------------------

/**
 * The steps between two texts of a turn. One shows as its own line; several fold into one, "3
 * Schritte · 4 s", open while they run and folded once the answer starts, unless the person
 * opened or closed it.
 */
function Steps({
  parts,
  running,
  live,
  id,
}: {
  parts: ChatPart[];
  running: boolean;
  live: boolean;
  id: string;
}) {
  const { approvals, tools } = useContext(StepsContext);
  const [chosen, setChosen] = useState<boolean | null>(null);
  useTick(running);
  const views = parts.map((part, at) =>
    isTool(part)
      ? toolView(part, live, approvals, tools)
      : reasoningView(
          part as { text: string; state?: string },
          `${id}:r${at}`,
          running &&
            (at === parts.length - 1 || (part as { state?: string }).state === "streaming"),
        ),
  );
  const times = views.map((view) => span(view.key, view.phase === "running"));
  if (views.length === 1) {
    return (
      <Trace>
        <StepRow view={views[0]} seconds={secondsOf(times, views[0].phase === "running")} />
      </Trace>
    );
  }
  const failed = views.filter((view) => view.phase === "failed").length;
  const seconds = secondsOf(times, running);
  return (
    <Trace>
      <TraceCollapsible open={chosen ?? running} onOpenChange={(open) => setChosen(open)}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? "running" : undefined}>
            <TraceIcon>
              <ListChecks />
            </TraceIcon>
            <TraceTitle>{t("work.step.steps", { count: views.length })}</TraceTitle>
            {seconds !== null ? <TraceDescription>· {duration(seconds)}</TraceDescription> : null}
            {failed ? (
              <TraceDescription className="text-danger">
                · {t("work.step.failedCount", { count: failed })}
              </TraceDescription>
            ) : null}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {views.map((view, at) => (
              <StepRow
                key={view.key}
                view={view}
                seconds={view.phase === "running" ? null : secondsOf([times[at]], false)}
              />
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

// --- how long --------------------------------------------------------------------------------

/**
 * When each step this page saw ran: from its first sight running to its first sight done. A turn
 * read from the store has no times, so its lines go without.
 */
const spans = new Map<string, { from: number; to: number | null }>();

function span(key: string, running: boolean) {
  let found = spans.get(key);
  if (!found && running) {
    found = { from: Date.now(), to: null };
    spans.set(key, found);
  }
  if (found && !running && found.to === null) {
    found.to = Date.now();
  }
  return found ?? null;
}

function secondsOf(list: ({ from: number; to: number | null } | null)[], running: boolean) {
  const known = list.filter((s) => s !== null);
  if (!known.length) {
    return null;
  }
  const from = Math.min(...known.map((s) => s.from));
  const to = running ? Date.now() : Math.max(...known.map((s) => s.to ?? s.from));
  return (to - from) / 1000;
}

function duration(seconds: number) {
  const whole = Math.max(1, Math.round(seconds));
  return whole < 60
    ? t("work.step.seconds", { n: whole })
    : t("work.step.minutes", { m: Math.floor(whole / 60), s: whole % 60 });
}

/** Draws again each second while something runs, for its time. */
function useTick(running: boolean) {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
}

// --- what a step found ---------------------------------------------------------------------------

interface Hit {
  key: string;
  title: string;
  heading: string | null;
  text: string;
  open: string | null;
  link: string | null;
}

function hitsOf(output: unknown): Hit[] | null {
  const hits = (output as { hits?: unknown } | null)?.hits;
  return Array.isArray(hits) ? (hits as Hit[]) : null;
}

const HIT_ICON: Record<string, LucideIcon> = {
  p: FileText,
  d: FileText,
  t: Table2,
  f: File,
  v: Tag,
  x: Puzzle,
};

/** A search's hits as rows: where it stands, and the passage. A page of the space opens it. */
function HitList({ hits }: { hits: Hit[] }) {
  return (
    <ul className="-mx-2 grid">
      {hits.map((hit, at) => {
        const Icon = HIT_ICON[hit.key.split(":")[0]] ?? FileText;
        const row = (
          <>
            <Icon className="mt-0.5 size-3.5 shrink-0 text-ink-4" />
            <span className="min-w-0">
              <span className="block truncate text-[0.8125rem] text-ink-2">
                {hit.title}
                {hit.heading && hit.heading !== hit.title ? (
                  <span className="text-ink-4"> › {hit.heading}</span>
                ) : null}
              </span>
              <span className="line-clamp-2 text-[0.75rem] text-ink-4">{hit.text}</span>
            </span>
          </>
        );
        const look = "flex items-start gap-2 rounded-md px-2 py-1.5";
        return (
          <li key={`${hit.key}:${at}`}>
            {hit.open ? (
              <NavLink
                to={`/space/knowledge?show=${encodeURIComponent(hit.open)}`}
                className={cn(look, "hover:bg-ink/5")}
              >
                {row}
              </NavLink>
            ) : hit.link ? (
              <a href={hit.link} className={cn(look, "hover:bg-ink/5")}>
                {row}
              </a>
            ) : (
              <div className={look}>{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface Source {
  url: string;
  title: string;
}

/** The pages a web search found, from either search's result. */
function webSourcesOf(output: unknown): Source[] {
  const list = Array.isArray(output)
    ? output
    : ((output as { results?: unknown; sources?: unknown } | null)?.results ??
      (output as { sources?: unknown } | null)?.sources);
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((item: { url?: unknown; title?: unknown }) =>
    item && typeof item.url === "string"
      ? [{ url: item.url, title: typeof item.title === "string" ? item.title : "" }]
      : [],
  );
}

/** Every page a turn's web searches found and its sources name, each once. */
function sourcesOf(parts: ChatPart[]): Source[] {
  const found = new Map<string, Source>();
  for (const part of parts) {
    const list =
      part.type === "source-url"
        ? [part as unknown as Source]
        : isTool(part) && part.type === "tool-web_search"
          ? webSourcesOf(part.output)
          : [];
    for (const source of list) {
      if (typeof source.url === "string" && !found.has(source.url)) {
        found.set(source.url, { url: source.url, title: source.title ?? "" });
      }
    }
  }
  return [...found.values()];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** A site's own icon, or a globe where it has none. */
function Favicon({ url, className }: { url: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const host = hostOf(url);
  if (failed || !host) {
    return <Globe className={cn("size-3.5 shrink-0 text-ink-4", className)} />;
  }
  return (
    <img
      src={`https://${new URL(url).hostname}/favicon.ico`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("size-3.5 shrink-0 rounded-sm", className)}
    />
  );
}

function SourceChips({ list }: { list: Source[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
          title={source.title || source.url}
          className="flex max-w-80 items-center gap-1.5 rounded-full bg-ink/5 py-1 pr-2.5 pl-2 text-[0.75rem] text-ink-2 transition hover:bg-ink/10 hover:text-ink"
        >
          <Favicon url={source.url} />
          <span className="truncate">{source.title || hostOf(source.url)}</span>
          {source.title ? <span className="shrink-0 text-ink-4">{hostOf(source.url)}</span> : null}
        </a>
      ))}
    </div>
  );
}

/** Under the answer: the sites it stands on, as a row of their icons that opens the list. */
function Sources({ list }: { list: Source[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid justify-items-start gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-full border border-border-soft py-1 pr-3 pl-1.5 text-[0.8125rem] text-ink-3 transition hover:bg-ink/5 hover:text-ink"
      >
        <span className="-space-x-1 flex">
          {list.slice(0, 4).map((source) => (
            <span
              key={source.url}
              className="grid size-5 place-items-center rounded-full bg-canvas ring-1 ring-border-soft"
            >
              <Favicon url={source.url} className="size-3" />
            </span>
          ))}
        </span>
        {t("work.step.sources", { count: list.length })}
      </button>
      {open ? <SourceChips list={list} /> : null}
    </div>
  );
}

/** A tool's result in a line: a text, or its first fields. */
function summaryOf(output: unknown): string {
  if (typeof output === "string" && output.trim()) {
    return clip(output.trim().split("\n")[0]);
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const fields = Object.entries(output)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 2)
      .map(([key, value]) => `${words(key)}: ${clip(String(value))}`);
    if (fields.length) {
      return fields.join(" · ");
    }
  }
  return t("work.step.done");
}

const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

const errorOf = (output: unknown) => {
  const error = (output as { error?: unknown; message?: unknown } | null)?.error;
  return typeof error === "string" ? error : null;
};

/** The raw input and result, for whoever wants to see exactly what went in and out. */
function Details({ raw }: { raw: { input?: unknown; output?: unknown } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid justify-items-start gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[0.75rem] text-ink-4 transition hover:text-ink"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {t("work.step.details")}
      </button>
      {open ? (
        <div className="grid w-full gap-1.5">
          {raw.input !== undefined ? <Raw label={t("work.step.input")} value={raw.input} /> : null}
          {raw.output !== undefined ? (
            <Raw label={t("work.step.output")} value={raw.output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Raw({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="grid gap-1">
      <span className="text-[0.6875rem] text-ink-4 uppercase tracking-wide">{label}</span>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-ink/5 p-2 font-mono text-[0.75rem]">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

// --- a held call ---------------------------------------------------------------------------------

/**
 * A held call (AI Elements, Confirmation): what the AI wants to do in the person's words, what it
 * would send as rows, Approve or Deny for who may, and the outcome after.
 */
export function ApprovalCard({ id }: { id: string }) {
  const { approvals, may, decide, busy, tools } = useContext(StepsContext);
  const approval = approvals.get(id);
  if (!approval) {
    return null;
  }
  const input =
    approval.input && typeof approval.input === "object" && !Array.isArray(approval.input)
      ? Object.entries(approval.input)
      : [];
  const state =
    approval.state === "approved"
      ? t("work.approval.approved")
      : approval.state === "denied"
        ? t("work.approval.denied")
        : approval.state === "failed"
          ? t("work.approval.failed")
          : null;
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-card/40 p-3.5 text-[0.875rem]">
      <p className="flex items-center gap-2 font-medium text-ink">
        {approval.state === "pending" ? (
          <ShieldQuestion className="size-4 shrink-0 text-ember" />
        ) : approval.state === "approved" ? (
          <ShieldCheck className="size-4 shrink-0 text-moss" />
        ) : (
          <ShieldX className="size-4 shrink-0 text-ink-3" />
        )}
        {approval.state === "pending"
          ? t("work.approval.waiting", { name: labelOf(approval.toolName, tools) })
          : labelOf(approval.toolName, tools)}
      </p>
      {input.length ? (
        <dl className="grid max-h-56 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 overflow-auto rounded-lg bg-ink/5 px-3 py-2.5 text-[0.8125rem]">
          {input.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="text-ink-3">{words(key)}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-ink">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {state ? (
        <p className={approval.state === "failed" ? "text-danger" : "text-ink-3"}>{state}</p>
      ) : may(approval) ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => decide(approval.id, true)}>
            {t("work.approval.approve")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => decide(approval.id, false)}
          >
            {t("work.approval.deny")}
          </Button>
        </div>
      ) : (
        <p className="text-ink-3">{t("work.approval.notYours")}</p>
      )}
    </div>
  );
}
