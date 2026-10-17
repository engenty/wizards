import { Markdown } from "@engenty-wizards/runner";
import { slotText, type WizardDefinition } from "@engenty-wizards/shared/definition";
import type { RunView } from "@engenty-wizards/shared/run";
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import {
  ArrowRight,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  Undo2,
  Workflow,
} from "lucide-react";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Mascot } from "../brand";
import { setRemoteRuntime, withBase } from "../lib/base";
import { eventText, lang, setLang, t } from "../lib/i18n";
import { RunnerBody } from "../runner/RunnerView";
import { FlowCanvas } from "../studio/editor/FlowDiagram";
import {
  Button,
  Chip,
  cn,
  Input,
  Label,
  Segmented,
  Select,
  Spinner,
  Switch,
  Textarea,
} from "../ui";

/**
 * The widget an AI app shows when its model calls show_wizard, run_wizard or start_test_run of
 * the engenty-wizards MCP server: the wizard as it greets a person, and a run as the wizard
 * itself shows it — the runner, talking to the local runtime with the run's ticket. Where the
 * host lets the widget reach no network, the run falls back to its diagram and a panel whose
 * buttons are calls of the same server's tools.
 */

// --- what the server hands over (apps/runtime/src/services/runs.ts, mcp/flow-app.ts) ---------

interface RunField {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  options?: string[];
  placeholder?: string;
  help?: string;
  default?: unknown;
  value?: unknown;
  inChat: boolean;
}

interface RunOutput {
  stepId: string;
  title: string;
  text?: string;
  json?: string;
  assets: { name: string; mime: string; url: string }[];
  downloads: Record<string, string>;
}

interface RunReport {
  runId: string;
  wizardId: string;
  mode: "test" | "live";
  status: "running" | "waiting_input" | "done" | "failed" | "cancelled";
  step: { id: string; type: string; title: string } | null;
  passed: string[];
  waitingFor?:
    | { page: string; title: string; fields: RunField[] }
    | { review: string; title: string; show: string[]; editable: boolean }
    | { ask: string; kind: "confirm"; reason: string; service: string; action: string }
    | { ask: string; kind: "login"; reason: string; site: string };
  error: string | null;
  credits: number;
  events: { step: string | null; type: string; message: string }[];
  outputs: RunOutput[];
  browserUrl: string | null;
}

interface FlowView {
  wizard: {
    id: string;
    title: string;
    description?: string;
    avatar?: string;
    shows: "draft" | "published";
    published: boolean;
    issues?: number;
  };
  definition: WizardDefinition;
  run?: RunReport;
  runtime?: { base: string; ticket: string };
}

/** Whether the widget reaches the runtime itself: hosts that keep it off the network say no. */
type Reach = "asking" | "yes" | "no";

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;

const FLOW_VIEW_KEY = "engenty/flow";
/** A page field the widget can show; the others (files, recordings, line items) need the run page. */
const WIDGET_KINDS = new Set([
  "text",
  "textarea",
  "number",
  "select",
  "multiselect",
  "date",
  "email",
  "url",
  "toggle",
  "color",
  "location",
  "slot",
]);
/** The diagram's height in the chat: below the greeting, and above a run's panel. */
const FLOW_CANVAS = 420;
/** The widget's most height in the chat; longer pages scroll inside it. */
const WIDGET_HEIGHT = 600;
/**
 * The widget's least height, from its first paint on: a host that sizes the frame once, or keeps
 * the size it measured first, still shows a page the person can use.
 */
const WIDGET_MIN = 360;
const RUN_CANVAS = 320;
const NO_ISSUES: ReadonlySet<string> = new Set();

function bodyOf(result: ToolResult): unknown {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const text = result.content?.find((c) => c.type === "text");
  try {
    return text && "text" in text ? JSON.parse(text.text) : null;
  } catch {
    return text && "text" in text ? text.text : null;
  }
}

/** A tool's answer, or an Error with the server's message. */
function answerOf<T>(result: ToolResult): T {
  const body = bodyOf(result);
  if (result.isError) {
    const message =
      body && typeof body === "object" && "error" in body ? String(body.error) : String(body);
    throw Object.assign(new Error(message), { body });
  }
  return body as T;
}

function applyHost(ctx: McpUiHostContext | undefined) {
  if (!ctx) {
    return;
  }
  if (ctx.theme) {
    document.documentElement.classList.toggle("dark", ctx.theme === "dark");
  }
  if (ctx.locale) {
    setLang(ctx.locale.toLowerCase().startsWith("de") ? "de" : "en");
  }
}

export function FlowApp() {
  const app = useMemo(
    // The host makes the frame as tall as the widget: the diagram's fixed height and the panel.
    () => new App({ name: "engenty-wizards-flow", version: "1.0.0" }, {}, { autoResize: true }),
    [],
  );
  const [view, setView] = useState<FlowView | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);
  const [host, setHost] = useState<McpUiHostContext | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [reach, setReach] = useState<Reach>("asking");

  useEffect(() => {
    app.ontoolresult = (result) => {
      const next = (result._meta as Record<string, unknown> | undefined)?.[FLOW_VIEW_KEY] as
        | FlowView
        | undefined;
      if (next) {
        setView(next);
        setReport(next.run ?? null);
      }
    };
    app.onhostcontextchanged = (ctx) => {
      setHost((before) => ({ ...before, ...ctx }));
      applyHost(ctx);
    };
    app
      .connect()
      .then(() => {
        const ctx = app.getHostContext();
        setHost(ctx);
        applyHost(ctx);
      })
      .catch((error) => console.error("[flow widget]", error));
  }, [app]);

  const call = useCallback(
    async <T,>(name: string, args: Record<string, unknown>): Promise<T> =>
      answerOf<T>(await app.callServerTool({ name, arguments: args })),
    [app],
  );

  /** Tells the model what the person did here, without making it answer. */
  const tellModel = useCallback(
    (next: RunReport) => {
      const outputs = next.outputs.map((o) => o.title).join(", ");
      const text = [
        `engenty wizards run ${next.runId}: ${next.status}${next.step ? ` at "${next.step.title}"` : ""}.`,
        outputs ? `Made so far: ${outputs}.` : "",
        next.status === "done"
          ? "The person finished it in the widget; get_run has the outputs and download links."
          : "The person answers this run in the widget; get_run has the details.",
      ]
        .filter(Boolean)
        .join(" ");
      app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);
    },
    [app],
  );

  /** The same for the runner, once per status and step. */
  const told = useRef("");
  const tellView = useCallback(
    (next: RunView | null) => {
      const key = next ? `${next.status}:${next.step?.id ?? ""}` : "";
      if (!next || key === told.current) {
        return;
      }
      told.current = key;
      const text = [
        `engenty wizards run ${next.id}: ${next.status}${next.step ? ` at "${next.step.title}"` : ""}.`,
        next.status === "done"
          ? "The person finished it in the widget; get_run has the outputs and download links."
          : "The person answers this run in the widget; get_run has the details.",
      ].join(" ");
      app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);
    },
    [app],
  );

  /** The runner scrolls in its box; a new page or status starts at its top. */
  const box = useRef<HTMLDivElement>(null);
  const shownStep = useRef("");
  const onRunView = useCallback(
    (next: RunView | null) => {
      tellView(next);
      const key = next ? `${next.status}:${next.step?.id ?? ""}` : "";
      if (key !== shownStep.current) {
        shownStep.current = key;
        box.current?.scrollTo({ top: 0 });
      }
    },
    [tellView],
  );

  const runId = report?.runId;
  const runtime = view?.runtime;
  // The runner needs the runtime itself; a host that keeps the widget off the network gets the panel.
  useEffect(() => {
    if (!runId || !runtime) {
      setReach("no");
      return;
    }
    setRemoteRuntime(runtime);
    setReach("asking");
    let live = true;
    fetch(withBase(`/api/runs/${runId}`), { credentials: "include" })
      .then((res) => live && setReach(res.ok ? "yes" : "no"))
      .catch(() => live && setReach("no"));
    return () => {
      live = false;
    };
  }, [runId, runtime]);

  const start = useCallback(
    async (wizardId: string) => {
      const result = await app.callServerTool({ name: "run_wizard", arguments: { wizardId } });
      answerOf(result);
      const next = (result._meta as Record<string, unknown> | undefined)?.[FLOW_VIEW_KEY] as
        | FlowView
        | undefined;
      if (next) {
        setView(next);
        setReport(next.run ?? null);
      }
    },
    [app],
  );

  const running = report?.status === "running";
  // While a step works, ask again; the server holds each call until something changed.
  useEffect(() => {
    if (!runId || !running || reach !== "no") {
      return;
    }
    let live = true;
    void (async () => {
      while (live) {
        try {
          const next = await call<RunReport>("get_run", { runId, waitSeconds: 20 });
          if (!live) {
            return;
          }
          setReport(next);
          if (next.status !== "running") {
            tellModel(next);
            return;
          }
        } catch {
          await new Promise((wait) => setTimeout(wait, 3000));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [runId, running, reach, call, tellModel]);

  const passed = useMemo(() => new Set(report?.passed ?? []), [report]);
  const fullscreen = host?.displayMode === "fullscreen";
  const canFullscreen = host?.availableDisplayModes?.includes("fullscreen");
  const open = (url: string) => {
    app.openLink({ url }).catch(() => window.open(url, "_blank", "noopener"));
  };

  if (!view || (report && reach === "asking")) {
    return (
      <div
        className="flex items-center justify-center gap-2 text-ink-3 text-sm"
        style={{ height: WIDGET_MIN }}
      >
        <Spinner className="size-4" />
        {t("flowApp.loading")}
      </div>
    );
  }

  if (report && reach === "yes") {
    return (
      <div
        ref={box}
        className="overflow-y-auto overscroll-contain bg-background text-ink"
        style={{ minHeight: WIDGET_MIN, maxHeight: WIDGET_HEIGHT }}
      >
        {/* A runner that breaks here leaves the panel, not an empty frame the host folds away. */}
        <Fallback key={report.runId} onError={() => setReach("no")}>
          <RunnerBody runId={report.runId} compact stickyProgress onView={onRunView} />
        </Fallback>
      </div>
    );
  }

  if (!report) {
    return <WizardIntro view={view} onStart={() => start(view.wizard.id)} />;
  }

  const active = report && report.status !== "done" ? (report.step?.id ?? null) : null;

  return (
    <div
      className={cn("flex bg-background text-ink", fullscreen ? "h-screen flex-row" : "flex-col")}
    >
      <div
        className={cn("relative min-w-0", fullscreen ? "flex-1" : "")}
        style={fullscreen ? undefined : { height: RUN_CANVAS }}
      >
        <FlowCanvas
          def={view.definition}
          selected={selected}
          onSelect={setSelected}
          issueSteps={NO_ISSUES}
          activeStep={active}
          passed={passed}
          minFitZoom={0.45}
          fitKey={String(fullscreen)}
        />
      </div>
      <aside
        className={cn(
          "flex flex-col gap-3 border-border-soft bg-card p-4",
          fullscreen ? "w-[380px] overflow-y-auto border-l" : "border-t",
        )}
      >
        <header className="flex flex-wrap items-center gap-2">
          <span className="truncate font-display font-semibold text-[0.9375rem]">
            {view.wizard.title}
          </span>
          <Chip>
            {view.wizard.shows === "published" ? t("flowApp.published") : t("flowApp.draft")}
          </Chip>
          {view.wizard.issues ? (
            <span className="text-[0.75rem] text-rose">
              {t("flowApp.issues", { n: view.wizard.issues })}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            {canFullscreen ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  app
                    .requestDisplayMode({ mode: fullscreen ? "inline" : "fullscreen" })
                    .then(({ mode }) => setHost((before) => ({ ...before, displayMode: mode })))
                    .catch(() => undefined)
                }
              >
                {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                {fullscreen ? t("flowApp.inline") : t("flowApp.fullscreen")}
              </Button>
            ) : null}
          </span>
        </header>
        <RunPanel
          report={report}
          selected={selected}
          call={call}
          onReport={(next) => {
            setReport(next);
            tellModel(next);
          }}
          open={open}
        />
      </aside>
    </div>
  );
}

type Call = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

/** Catches what its children throw while they render: the widget shows something else instead of nothing. */
export class Fallback extends Component<
  { children: ReactNode; onError?: () => void; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[flow widget]", error);
    this.props.onError?.();
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** The wizard as it greets a person on its own page, its flow one click away. */
function WizardIntro({ view, onStart }: { view: FlowView; onStart: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState(false);
  const description = view.wizard.description ?? view.definition.description;
  return (
    <div
      className="flex flex-col overflow-y-auto overscroll-contain bg-background text-ink"
      style={{ maxHeight: WIDGET_HEIGHT }}
    >
      <div className="mx-auto flex max-w-lg flex-col items-center px-6 pt-6 pb-6 text-center">
        <Mascot kind={view.wizard.avatar ?? view.definition.avatar} size={120} fluffy />
        <h1 className="mt-2 text-balance font-display font-semibold text-[1.625rem] leading-[1.1] tracking-tight">
          {view.wizard.title}
        </h1>
        {description ? (
          <p className="mt-3 text-[0.9375rem] text-ink-2 leading-relaxed">{description}</p>
        ) : null}
        {view.wizard.published ? (
          <Button
            size="lg"
            className="mt-8 min-w-48"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onStart();
              } catch (err) {
                setError((err as Error).message);
                setBusy(false);
              }
            }}
          >
            {t("run.start")} <ArrowRight className="size-4" />
          </Button>
        ) : (
          <p className="mt-8 rounded-xl bg-paper-2 px-5 py-4 text-[0.875rem] text-ink-2">
            {t("flowApp.notPublished")}
          </p>
        )}
        {error ? <p className="mt-4 text-[0.875rem] text-rose">{error}</p> : null}
        <Button size="sm" variant="ghost" className="mt-4" onClick={() => setFlow(!flow)}>
          <Workflow className="size-4" />
          {t("flowApp.flow")}
        </Button>
      </div>
      {flow ? (
        <div className="relative border-border-soft border-t" style={{ height: FLOW_CANVAS }}>
          <FlowCanvas
            def={view.definition}
            selected={null}
            onSelect={() => undefined}
            issueSteps={NO_ISSUES}
            activeStep={null}
            minFitZoom={0.45}
          />
        </div>
      ) : null}
    </div>
  );
}

function RunPanel({
  report,
  selected,
  call,
  onReport,
  open,
}: {
  report: RunReport;
  selected: string | null;
  call: Call;
  onReport: (r: RunReport) => void;
  open: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (name: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      onReport(await call<RunReport>(name, { runId: report.runId, ...args }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const waiting = report.waitingFor;
  const shown = selected ? report.outputs.filter((o) => o.stepId === selected) : [];
  const last = report.events.at(-1);
  const runPage = report.browserUrl;
  const toRunPage = runPage ? () => open(runPage) : undefined;

  let body: ReactNode = null;
  if (report.status === "running" && !(waiting && "ask" in waiting)) {
    body = (
      <p className="flex items-center gap-2 text-[0.8125rem] text-ink-2">
        <Spinner className="size-4" />
        {(last && eventText(last)) || t("run.working")}
      </p>
    );
  } else if (waiting && "page" in waiting) {
    body = (
      <PageForm
        key={`${report.runId}-${waiting.page}`}
        fields={waiting.fields}
        busy={busy}
        onSubmit={(values) => act("answer_page", { stepId: waiting.page, values, waitSeconds: 3 })}
        onBrowser={toRunPage}
      />
    );
  } else if (waiting && "review" in waiting) {
    body = (
      <Review
        outputs={report.outputs.filter((o) => waiting.show.includes(o.stepId))}
        targets={waiting.show}
        busy={busy}
        onAccept={() => act("review_step", { stepId: waiting.review, action: { type: "accept" } })}
        onRegenerate={(target, note) =>
          act("review_step", {
            stepId: waiting.review,
            action: { type: "regenerate", target, note },
          })
        }
        open={open}
      />
    );
  } else if (waiting && "ask" in waiting) {
    body =
      waiting.kind === "confirm" ? (
        <div className="flex flex-col gap-2">
          <div className="font-medium text-[0.8125rem]">{t("flowApp.ask")}</div>
          <p className="text-[0.8125rem] text-ink-2">
            {waiting.reason} — {waiting.service}: {waiting.action}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              busy={busy}
              onClick={() => act("answer_ask", { askId: waiting.ask, answer: "allow" })}
            >
              {t("flowApp.allow")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => act("answer_ask", { askId: waiting.ask, answer: "skip" })}
            >
              {t("flowApp.skip")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[0.8125rem] text-ink-2">
            {t("flowApp.signIn", { site: waiting.site })}
          </p>
          {toRunPage ? (
            <Button size="sm" onClick={toRunPage}>
              <ExternalLink className="size-4" />
              {t("flowApp.runPage")}
            </Button>
          ) : null}
        </div>
      );
  } else if (report.status === "failed") {
    body = (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[0.8125rem] text-rose">{report.error || t("run.failed")}</p>
        <Button size="sm" busy={busy} onClick={() => act("control_run", { action: "retry" })}>
          {t("run.retry")}
        </Button>
      </div>
    );
  } else if (report.status === "cancelled") {
    body = <p className="text-[0.8125rem] text-ink-3">{t("run.cancelled")}</p>;
  } else if (report.status === "done") {
    body = <Outputs outputs={report.outputs} open={open} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[0.75rem] text-ink-3">
        <span className="font-medium text-ink-2">
          {report.status === "done" ? t("flowApp.done") : report.step?.title}
        </span>
        <span>· {t("flowApp.credits", { n: report.credits })}</span>
        <span className="ml-auto flex gap-1">
          {report.status === "waiting_input" && report.passed.length ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => act("control_run", { action: "back" })}
            >
              <Undo2 className="size-4" />
              {t("run.back")}
            </Button>
          ) : null}
          {toRunPage ? (
            <Button size="sm" variant="ghost" onClick={toRunPage}>
              <ExternalLink className="size-4" />
              {t("flowApp.runPage")}
            </Button>
          ) : null}
        </span>
      </div>
      {body}
      {error ? (
        <p className="text-[0.8125rem] text-rose">{t("flowApp.failed", { error })}</p>
      ) : null}
      {shown.length && report.status !== "done" ? <Outputs outputs={shown} open={open} /> : null}
    </div>
  );
}

function initialValue(field: RunField): unknown {
  return (
    field.value ??
    field.default ??
    (field.kind === "multiselect" ? [] : field.kind === "toggle" ? false : "")
  );
}

function PageForm({
  fields,
  busy,
  onSubmit,
  onBrowser,
}: {
  fields: RunField[];
  busy: boolean;
  onSubmit: (values: Record<string, unknown>) => void;
  onBrowser?: () => void;
}) {
  const shown = fields.filter((f) => WIDGET_KINDS.has(f.kind));
  const elsewhere = fields.filter((f) => !WIDGET_KINDS.has(f.kind));
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(shown.map((f) => [f.id, initialValue(f)])),
  );
  const set = (id: string, value: unknown) => setValues((v) => ({ ...v, [id]: value }));
  const missing = shown.some((f) => {
    const v = values[f.id];
    return f.required && (v === "" || v === undefined || (Array.isArray(v) && !v.length));
  });

  if (elsewhere.some((f) => f.required)) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[0.8125rem] text-ink-2">
          {t("flowApp.inBrowser", { fields: elsewhere.map((f) => f.label).join(", ") })}
        </p>
        {onBrowser ? (
          <Button size="sm" onClick={onBrowser}>
            <ExternalLink className="size-4" />
            {t("flowApp.runPage")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const out: Record<string, unknown> = {};
        for (const f of shown) {
          const v = values[f.id];
          if (v === "" || v === undefined) {
            continue;
          }
          out[f.id] =
            f.kind === "number" ? Number(v) : f.kind === "location" ? { label: String(v) } : v;
        }
        onSubmit(out);
      }}
    >
      {shown.map((f) => (
        <div key={f.id}>
          <Label required={f.required} hint={f.help}>
            {f.label}
          </Label>
          <div className="mt-1.5">
            <FieldControl field={f} value={values[f.id]} onChange={(v) => set(f.id, v)} />
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button type="submit" busy={busy} disabled={missing}>
          {t("run.next")}
        </Button>
        {elsewhere.length ? (
          <span className="text-[0.75rem] text-ink-3">
            {t("flowApp.inBrowser", { fields: elsewhere.map((f) => f.label).join(", ") })}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: RunField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  switch (field.kind) {
    case "textarea":
      return (
        <Textarea
          value={text}
          rows={4}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "select":
      return (
        <Select
          value={text}
          onChange={onChange}
          placeholder=""
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      );
    case "multiselect":
      return (
        <Segmented
          multi
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          options={field.options ?? []}
        />
      );
    // An appointment time reads as day and time on the business's clock: "Di 13.10.2026, 10:30".
    case "slot":
      return field.options?.length ? (
        <Select
          value={text}
          onChange={onChange}
          placeholder=""
          options={field.options.map((o) => ({ value: o, label: slotText(o, lang) }))}
        />
      ) : (
        <p className="text-[0.8125rem] text-ink-3">{t("slot.none")}</p>
      );
    case "toggle":
      return <Switch checked={value === true} onChange={onChange} />;
    case "location":
      return (
        <Input
          value={
            value && typeof value === "object" && "label" in value
              ? String((value as { label?: string }).label ?? "")
              : text
          }
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <Input
          type={
            field.kind === "number"
              ? "number"
              : field.kind === "date"
                ? "date"
                : field.kind === "email"
                  ? "email"
                  : field.kind === "url"
                    ? "url"
                    : field.kind === "color"
                      ? "color"
                      : "text"
          }
          value={text}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function Review({
  outputs,
  targets,
  busy,
  onAccept,
  onRegenerate,
  open,
}: {
  outputs: RunOutput[];
  targets: string[];
  busy: boolean;
  onAccept: () => void;
  onRegenerate: (target: string, note: string) => void;
  open: (url: string) => void;
}) {
  const [note, setNote] = useState("");
  const [target, setTarget] = useState(targets[0] ?? "");
  return (
    <div className="flex flex-col gap-3">
      <Outputs outputs={outputs} open={open} />
      <div className="flex flex-col gap-2">
        {targets.length > 1 ? (
          <Select
            value={target}
            onChange={setTarget}
            options={outputs.map((o) => ({ value: o.stepId, label: o.title }))}
          />
        ) : null}
        <Textarea
          rows={2}
          value={note}
          placeholder={t("run.regenerateNote")}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex gap-2">
          <Button busy={busy} onClick={onAccept}>
            {t("run.accept")}
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !note.trim() || !target}
            onClick={() => onRegenerate(target, note.trim())}
          >
            {t("run.regenerateGo")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Outputs({ outputs, open }: { outputs: RunOutput[]; open: (url: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {outputs.map((o) => (
        <section key={o.stepId} className="rounded-xl bg-paper-2 p-3">
          <div className="mb-1.5 font-medium text-[0.8125rem] text-ink-2">{o.title}</div>
          {o.text ? <Markdown text={o.text} className="text-[0.8125rem]" /> : null}
          {o.assets
            .filter((a) => a.mime.startsWith("image/"))
            .map((a) => (
              <img key={a.url} src={a.url} alt={a.name} className="mt-2 max-h-64 rounded-lg" />
            ))}
          {Object.keys(o.downloads).length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(o.downloads).map(([format, url]) => (
                <Button key={format} size="sm" variant="secondary" onClick={() => open(url)}>
                  <Download className="size-4" />
                  {format.toUpperCase()}
                </Button>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
