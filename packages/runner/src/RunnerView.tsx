import {
  type FormStep,
  isDecidedField,
  type ResultStep,
  type ReviewStep,
  type Step,
  shownFields,
  stepShape,
} from "@engenty/wizards-shared/definition";
import {
  note,
  type RunPause,
  type RunSignIn,
  type RunView,
  type StepOutput,
} from "@engenty/wizards-shared/run";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BellRing,
  Languages,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AskPanel, QuestionPanel } from "./AskPanel.js";
import { DataEditor, editableData, StudioData } from "./data.js";
import {
  disableNotify,
  enableNotify,
  notificationsBlocked,
  signalPerson,
  useKeyboardInset,
  useNotifyState,
  useWakeLock,
} from "./device";
import { api, runBase, runnerEnv, standalone, withBase } from "./env.js";
import { FieldInput, type Values } from "./fields";
import { eventText, noteLine, runnerLangCode, setChoiceLabels, t } from "./i18n.js";
import { DownloadButtons, OutputView } from "./outputs";
import { ListCheck, ListDownloads, ListTable, SignInCard, StoreButton } from "./store";
import { SurfaceView } from "./surface.js";
import { Button, Card, cn, LinkedText, Spinner, Textarea } from "./ui.js";

/**
 * A run as the runner drives it: the view, and the commands a person can give. `useRun` in the
 * studio (a server-sent stream), `useLocalRun` in the WordPress plugin (one request per step).
 */
export interface RunSource {
  view: RunView | null;
  /** Takes a run back that the team has now; only where the viewer can (`view.canWithdraw`). */
  withdraw?: () => Promise<unknown>;
  notFound: boolean;
  error: string | null;
  busy: boolean;
  fieldErrors: Record<string, string>;
  /**
   * Pages shown ahead of the server and not confirmed yet: for a while ("slow"), or the server out
   * of reach ("offline"). Null or left out: all is saved.
   */
  saving?: "slow" | "offline" | null;
  submitPage(stepId: string, values: Record<string, unknown>): Promise<boolean>;
  accept(
    stepId: string,
    edits?: Record<string, string | Record<string, unknown>>,
    note?: string,
  ): Promise<boolean>;
  /** A review with `approve` is declined. */
  decline(stepId: string, note?: string): Promise<boolean>;
  regenerate(stepId: string, target: string, note: string, items?: number[]): Promise<boolean>;
  back(): Promise<boolean>;
  retry(): Promise<boolean>;
  /** A finished result's text in the language the run is read in (a translated wizard). */
  translateResult?(stepId: string): Promise<boolean>;
}

type Run = RunSource;

function Progress({ view }: { view: RunView }) {
  const sections = view.progress.sections;
  if (sections) {
    return (
      <ol className="flex w-full gap-1">
        {sections.names.map((name, i) => {
          const now = i === sections.current;
          return (
            <li key={name} className="min-w-0 flex-1" aria-current={now ? "step" : undefined}>
              <div
                className={cn(
                  "h-[3px] w-full transition-colors duration-700",
                  i <= sections.current ? "bg-ember" : "bg-paper-2",
                )}
              />
              <div
                className={cn(
                  "truncate px-2 pt-1 text-center text-[0.75rem]",
                  now ? "font-medium text-ink" : "text-ink-3",
                )}
              >
                {name}
              </div>
            </li>
          );
        })}
      </ol>
    );
  }
  const pct = Math.round(
    (Math.min(view.progress.done, view.progress.total) / Math.max(1, view.progress.total)) * 100,
  );
  return (
    <div className="h-[3px] w-full bg-paper-2">
      <div
        className="h-full bg-ember transition-[width] duration-700 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Keeps what the person did in a step's view (ticks, a widget's state) with the run. */
const keepView = (runId: string, stepId: string) => (state: Record<string, unknown>) => {
  api.put(`${runBase(runId)}/views/${stepId}`, { state }).catch(() => undefined);
};

function StepHeading({
  title,
  description,
  kicker,
}: {
  title: string;
  description?: string;
  kicker?: string | null;
}) {
  return (
    <div className="kb-title mb-8">
      {kicker ? (
        <p className="kb-hide mb-4 text-[0.9375rem] text-ink-2 leading-relaxed">{kicker}</p>
      ) : null}
      <h1 className="wizard-title font-display font-semibold text-[1.75rem] leading-[1.15] tracking-tight sm:text-[2rem]">
        {title}
      </h1>
      {description ? (
        <p className="kb-hide mt-2 text-[0.9375rem] text-ink-3 leading-relaxed">{description}</p>
      ) : null}
    </div>
  );
}

export function initialValues(step: FormStep, view: RunView): Values {
  const out: Values = {};
  // What was typed here and not sent (another tab, another device, before a reload) comes first.
  const typed = view.step?.id === step.id ? (view.unsent ?? {}) : {};
  for (const f of step.fields) {
    out[f.id] =
      typed[f.id] ??
      view.values[f.id] ??
      view.prefill?.[f.id] ??
      f.default ??
      (f.kind === "multiselect" ? [] : undefined);
  }
  return out;
}

/** Text inputs of a page, in order — what Enter and the keyboard's action key walk through. */
function typedInputs(form: HTMLElement): HTMLElement[] {
  return Array.from(
    form.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"], [type="file"], [type="checkbox"], [type="color"], [type="range"], [disabled]), textarea:not([disabled])',
    ),
  ).filter((el) => !el.closest("dialog") && el.offsetParent !== null);
}

/** After the last change, how long typing rests before it is saved. */
const KEEP_TYPING_MS = 800;

/**
 * Keeps what is typed on a page with the run (`run.unsent`): 800 ms after the last change, when
 * the tab is hidden, and as it closes (`keepalive`). Nothing once the page is sent, and nothing
 * the person did not change. A host that runs wizards on its own keeps nothing.
 */
function useKeepTyping(runId: string, stepId: string, values: Values, sent: { current: boolean }) {
  const latest = useRef(values);
  const open = useRef(false);
  const first = useRef(true);
  latest.current = values;
  const save = useRef((_closing: boolean) => {});
  save.current = (closing: boolean) => {
    if (!open.current || sent.current || standalone()) {
      return;
    }
    open.current = false;
    const path = `${runBase(runId)}/pages/${stepId}/unsent`;
    if (closing) {
      api.keep(path, { values: latest.current });
    } else {
      api.put(path, { values: latest.current }).catch(() => {
        // Tried again with the next change, or as the tab is hidden.
        open.current = true;
      });
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: every change of the values counts.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    open.current = true;
    const timer = setTimeout(() => save.current(false), KEEP_TYPING_MS);
    return () => clearTimeout(timer);
  }, [values]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        save.current(true);
      }
    };
    const leave = () => save.current(true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
    };
  }, []);
}

function PageForm({ view, run, step }: { view: RunView; run: Run; step: FormStep }) {
  // Keyed by the page at the call site, so a page (or a page revisited) starts from the run's values.
  const [values, setValues] = useState<Values>(() => initialValues(step, view));
  // Once the page is on its way, its typed answers are in it: nothing more is kept apart.
  const sent = useRef(false);
  useKeepTyping(view.id, step.id, values, sent);
  // Fields still uploading or recording; going on now would leave their answer behind.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const form = useRef<HTMLFormElement>(null);
  const first = view.progress.done === 0;
  // Choices from earlier data stand in for the fixed ones; a field whose condition does not
  // hold is not shown, decided again as the person types.
  const fields = useMemo(
    () =>
      step.fields
        .filter((f) => !isDecidedField(f) || view.decidedFields?.includes(f.id))
        .map((f) => (view.options?.[f.id]?.length ? { ...f, options: view.options[f.id] } : f)),
    [step.fields, view.options, view.decidedFields],
  );
  const shown = shownFields(fields, view.known ?? {}, values);
  const submit = () => {
    sent.current = true;
    void run.submitPage(step.id, values).then((ok) => {
      // Refused: the person stays on the page, and what they type is kept again.
      if (!ok) {
        sent.current = false;
      }
    });
  };
  const fieldInput = (f: (typeof shown)[number]) => (
    <FieldInput
      key={f.id}
      field={f}
      value={values[f.id]}
      values={values}
      runId={view.id}
      view={view}
      error={run.fieldErrors[f.id]}
      closed={view.closed?.[f.id]}
      onChange={(v) => setValues((prev) => ({ ...prev, [f.id]: v }))}
      onBusy={(busy) =>
        setPending((prev) => {
          if (prev.has(f.id) === busy) {
            return prev;
          }
          const next = new Set(prev);
          if (busy) {
            next.add(f.id);
          } else {
            next.delete(f.id);
          }
          return next;
        })
      }
    />
  );

  // The keyboard's action key says what it does: "next" between fields, "go" on the last one.
  useEffect(() => {
    if (!form.current) {
      return;
    }
    const inputs = typedInputs(form.current).filter((el) => el instanceof HTMLInputElement);
    for (const [i, el] of inputs.entries()) {
      if (el.dataset.hint || !el.hasAttribute("enterkeyhint")) {
        el.dataset.hint = "1";
        el.setAttribute("enterkeyhint", i === inputs.length - 1 ? "go" : "next");
      }
    }
  });

  return (
    <form
      ref={form}
      className="animate-rise"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending.size) {
          submit();
        }
      }}
      onKeyDown={(e) => {
        const el = e.target;
        if (
          e.key !== "Enter" ||
          e.defaultPrevented ||
          e.nativeEvent.isComposing ||
          !(el instanceof HTMLInputElement) ||
          el.closest("dialog")
        ) {
          return;
        }
        // Enter walks to the next field; only on the last one it sends the page.
        const inputs = typedInputs(e.currentTarget);
        const next = inputs[inputs.indexOf(el) + 1];
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }}
    >
      <StepHeading
        title={step.title}
        description={step.description}
        kicker={first ? view.wizard.intro : null}
      />
      {step.components ? (
        <SurfaceView
          surface={{
            components: step.components,
            data: { ...view.pageData, ...values },
          }}
          assetUrl={(id) => withBase(`${runBase(view.id)}/assets/${id}`)}
          field={(name) => {
            const f = shown.find((s) => s.id === name);
            return f ? fieldInput(f) : null;
          }}
        />
      ) : (
        <div className="flex flex-col gap-7">{shown.map(fieldInput)}</div>
      )}
      <AnswerBy view={view} />
      {run.saving ? (
        <p
          role="status"
          className={cn(
            "mt-6 flex items-center gap-2 text-[0.8125rem]",
            run.saving === "offline" ? "text-rose" : "text-ink-3",
          )}
        >
          {run.saving === "slow" ? <Spinner className="size-3.5" /> : null}
          {t(run.saving === "slow" ? "run.saving" : "run.notSaved")}
        </p>
      ) : null}
      <Footer view={view} run={run} sticky>
        <Button type="submit" size="lg" busy={run.busy} disabled={pending.size > 0}>
          {step.cta || t("run.next")} <ArrowRight className="size-4" />
        </Button>
      </Footer>
    </form>
  );
}

function Footer({
  view,
  run,
  sticky,
  children,
}: {
  view: RunView;
  run: Run;
  /** The page's primary action: on a phone it stays in reach at the bottom of the screen. */
  sticky?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mt-10 flex items-center justify-between gap-3", sticky && "action-bar")}>
      {view.canBack ? (
        <Button variant="ghost" onClick={() => void run.back()} disabled={run.busy}>
          <ArrowLeft className="size-4" /> {t("run.back")}
        </Button>
      ) : (
        <span />
      )}
      {children}
    </div>
  );
}

/** "Tell me when it's done": asked for with a tap, never on page load. */
function NotifyToggle() {
  const state = useNotifyState();
  const [busy, setBusy] = useState(false);
  const on = state !== "off";
  return (
    <div className="mt-6 flex flex-col items-center gap-2">
      <button
        type="button"
        aria-pressed={on}
        disabled={busy}
        onClick={async () => {
          if (on) {
            disableNotify();
            return;
          }
          setBusy(true);
          await enableNotify();
          setBusy(false);
        }}
        className={cn(
          "inline-flex h-11 items-center gap-2 rounded-full px-4 font-medium text-[0.875rem] ring-1 transition",
          on
            ? "bg-ember-tint text-ink ring-ember"
            : "bg-card text-ink-2 ring-input hover:text-ink hover:ring-ink-4",
        )}
      >
        {on ? <BellRing className="size-4 text-ember-strong" /> : <Bell className="size-4" />}
        {t(on ? "notify.on" : "notify.ask")}
      </button>
      <p className="max-w-xs text-[0.75rem] text-ink-4 leading-relaxed">
        {state === "off"
          ? t("notify.why")
          : state === "on"
            ? t("notify.onHint")
            : t(notificationsBlocked() ? "notify.blocked" : "notify.quiet")}
      </p>
    </div>
  );
}

/**
 * The heading of a run that waits for a time: the day and the hour it goes on, as the person reads
 * them. `signIn`: what the run's view says about a sign-in it waits for.
 */
export function goesOnText(
  wakeAt: string | null,
  pause?: RunPause | null,
  signIn?: RunSignIn | null,
): string {
  if (pause?.kind === "credits") {
    return t("run.waitsCredits");
  }
  if (pause?.kind === "sign_in") {
    return t(signIn && "admin" in signIn ? "run.waitsAdminSignIn" : "run.waitsSignIn", {
      service: pause.service,
    });
  }
  if (!wakeAt) {
    return t("run.goesOnSoon");
  }
  const when = new Date(wakeAt);
  const code = runnerLangCode();
  return t(pause?.kind === "retry" ? "run.retryAt" : "run.goesOn", {
    date: new Intl.DateTimeFormat(code, { weekday: "long", day: "numeric", month: "long" }).format(
      when,
    ),
    time: new Intl.DateTimeFormat(code, { hour: "numeric", minute: "2-digit" }).format(when),
  });
}

/** Until when a person's step takes an answer, if it has a deadline. */
function AnswerBy({ view }: { view: RunView }) {
  if (view.status !== "waiting_input" || !view.wakeAt) {
    return null;
  }
  const code = runnerLangCode();
  const when = new Date(view.wakeAt);
  return (
    <p className="mt-4 text-[0.8125rem] text-ink-3">
      {t("run.answerBy", {
        date: new Intl.DateTimeFormat(code, {
          weekday: "long",
          day: "numeric",
          month: "long",
        }).format(when),
        time: new Intl.DateTimeFormat(code, { hour: "numeric", minute: "2-digit" }).format(when),
      })}
    </p>
  );
}

/** Says what a run waiting for a signal waits for, and until when at most. */
export function waitsSignalText(waitsFor: string | null, until: string | null): string {
  const waits = waitsFor ? t("run.waitsSignalFrom", { who: waitsFor }) : t("run.waitsSignal");
  if (!until) {
    return waits;
  }
  const date = new Intl.DateTimeFormat(runnerLangCode(), {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(until));
  return t("run.waitsAtMost", { waits, date });
}

/**
 * The run waits for a time or a signal: nothing to do, and nobody has to stay. One that waits for
 * the viewer's sign-in shows the connect card.
 */
function Sleeping({ view, compact }: { view: RunView; compact?: boolean }) {
  const { Mascot } = runnerEnv();
  return (
    <div className="flex animate-rise flex-col items-center pt-6 text-center">
      <Mascot kind={view.wizard.avatar} costume={view.wizard.costume} size={compact ? 130 : 170} />
      <h2 className="wizard-heading mt-4 font-display font-semibold text-[1.375rem] tracking-tight">
        {view.status === "waiting_signal"
          ? waitsSignalText(view.waitsFor, view.wakeAt)
          : goesOnText(view.wakeAt, view.pause, view.signIn)}
      </h2>
      {view.signIn && "connection" in view.signIn ? (
        <div className="mt-5 w-full max-w-md">
          <SignInCard view={view} center />
        </div>
      ) : null}
      <p className="mt-4 text-[0.9375rem] text-ink-3">{t("run.leavePage")}</p>
    </div>
  );
}

/** The step is someone else's: this viewer has nothing to answer. */
function AnsweredElsewhere({ view, run, compact }: { view: RunView; run: Run; compact?: boolean }) {
  const { Mascot } = runnerEnv();
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex animate-rise flex-col items-center pt-6 text-center">
      <Mascot kind={view.wizard.avatar} costume={view.wizard.costume} size={compact ? 130 : 170} />
      <h2 className="wizard-heading mt-4 font-display font-semibold text-[1.375rem] tracking-tight">
        {t(view.answeredBy === "team" ? "run.answeredByTeam" : "run.answeredByOther")}
      </h2>
      <p className="mt-2 text-[0.9375rem] text-ink-3">{t("run.leavePage")}</p>
      {view.canWithdraw && run.withdraw ? (
        asking ? (
          <div className="mt-4 flex flex-col items-center gap-2">
            <p className="text-[0.875rem] text-ink-2">{t("run.withdrawAsk")}</p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setAsking(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" disabled={run.busy} onClick={() => void run.withdraw?.()}>
                {t("run.withdraw")}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" className="mt-4" onClick={() => setAsking(true)}>
            {t("run.withdraw")}
          </Button>
        )
      ) : null}
    </div>
  );
}

function Working({
  view,
  compact,
  awake,
}: {
  view: RunView;
  compact?: boolean;
  /** The screen is kept on while the step works. */
  awake: boolean;
}) {
  const started = useMemo(() => {
    const e = [...view.events]
      .reverse()
      .find((ev) => ev.type === "step_started" && ev.stepId === view.step?.id);
    return e ? new Date(e.at).getTime() : Date.now();
  }, [view.events, view.step?.id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const label =
    [...view.events]
      .reverse()
      .find((ev) => ev.type === "step_started" && ev.stepId === view.step?.id)?.message ??
    view.step?.title ??
    t("run.working");
  const recent = view.events.filter(
    (ev) =>
      (ev.type === "tool" || ev.type === "info") && new Date(ev.at).getTime() >= started - 500,
  );
  const trail = recent.slice(-4);
  const { Mascot } = runnerEnv();
  // The pictures the step is about — photos it looks at, images it has just made — newest last.
  const pictures = [...new Set(recent.map((ev) => ev.asset).filter((id): id is string => !!id))];
  const latest = [...recent].reverse().find((ev) => ev.asset)?.asset;
  return (
    <div className="flex animate-rise flex-col items-center pt-6 text-center">
      <Mascot
        kind={view.wizard.avatar}
        costume={view.wizard.costume}
        size={compact ? 130 : 170}
        fluffy
      />
      <h2 className="wizard-heading mt-4 font-display font-semibold text-[1.375rem] tracking-tight">
        {label}
      </h2>
      <div className="mt-1 text-[0.8125rem] text-ink-4 tabular-nums">
        {t("run.elapsed", { s: Math.max(0, Math.round((now - started) / 1000)) })}
      </div>
      {pictures.length ? (
        <div className="mt-5 flex max-w-full flex-wrap justify-center gap-2">
          {pictures.slice(-8).map((id) => (
            <img
              key={id}
              src={withBase(`${runBase(view.id)}/assets/${id}`)}
              alt=""
              className={cn(
                "size-16 animate-rise rounded-lg bg-paper-2 object-cover ring-1 ring-border-soft transition sm:size-20",
                id === latest ? "ring-2 ring-ember" : "opacity-70",
              )}
            />
          ))}
        </div>
      ) : null}
      <div className="mt-6 flex min-h-[7rem] w-full max-w-sm flex-col gap-1.5">
        {trail.map((ev, i) => (
          <div
            key={ev.id}
            className={cn(
              "flex items-center justify-center gap-2 text-[0.8125rem] transition-opacity",
              i === trail.length - 1 ? "text-ink-2" : "text-ink-4",
            )}
          >
            {i === trail.length - 1 ? (
              <Sparkles className="size-3.5 animate-breathe text-ember" />
            ) : null}
            <span className="truncate">{eventText(ev)}</span>
          </div>
        ))}
      </div>
      {compact ? null : <NotifyToggle />}
      {awake ? <p className="mt-3 text-[0.75rem] text-ink-4">{t("run.awake")}</p> : null}
    </div>
  );
}

/** Above a step's question: which step it is, and what it had done up to there. */
function AskedAt({ view, compact }: { view: RunView; compact?: boolean }) {
  const { Mascot } = runnerEnv();
  const started = [...view.events]
    .reverse()
    .find((ev) => ev.type === "step_started" && ev.stepId === view.step?.id);
  const since = started ? new Date(started.at).getTime() - 500 : 0;
  const trail = view.events
    .filter(
      (ev) =>
        (ev.type === "tool" || ev.type === "info") &&
        ev.stepId === view.step?.id &&
        new Date(ev.at).getTime() >= since &&
        ev.note?.code !== "turnAsked",
    )
    .slice(-3);
  return (
    <div className="mb-8 flex animate-rise flex-col items-center text-center">
      <Mascot
        kind={view.wizard.avatar}
        costume={view.wizard.costume}
        size={compact ? 90 : 110}
        fluffy
      />
      <h2 className="wizard-heading mt-2 font-display font-semibold text-[1.25rem] tracking-tight">
        {view.step?.title}
      </h2>
      {trail.length ? (
        <div className="mt-3 flex w-full max-w-sm flex-col gap-1">
          {trail.map((ev) => (
            <div key={ev.id} className="truncate text-[0.8125rem] text-ink-4">
              {eventText(ev)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Tells the person when a step that took a while is done, or when it needs them (a sign-in, a
 * confirmation) — if they asked for it. A page in the background also marks its title.
 */
export function useDoneSignal(view: RunView | null) {
  const last = useRef({ running: false, since: 0, ask: null as string | null });
  useEffect(() => {
    if (!view) {
      return;
    }
    const prev = last.current;
    const running = view.status === "running";
    const since = running ? (prev.running ? prev.since : Date.now()) : 0;
    const tell = (body: string) => {
      if (document.visibilityState !== "visible" && !document.title.startsWith("● ")) {
        document.title = `● ${document.title}`;
      }
      void signalPerson({ title: view.wizard.title, body, tag: view.id });
    };
    if (running && view.ask && view.ask.id !== prev.ask) {
      tell(t("notify.needsYou"));
    } else if (
      !running &&
      prev.running &&
      view.status !== "sleeping" &&
      view.status !== "waiting_signal" &&
      Date.now() - prev.since > 8000
    ) {
      tell(
        view.status === "failed"
          ? t("run.failed")
          : view.status === "done"
            ? t("notify.done")
            : t("notify.next"),
      );
    }
    last.current = { running, since, ask: view.ask?.id ?? null };
  }, [view]);
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState === "visible" && document.title.startsWith("● ")) {
        document.title = document.title.slice(2);
      }
    };
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, []);
}

function Review({
  view,
  run,
  step,
  studio,
}: {
  view: RunView;
  run: Run;
  step: ReviewStep;
  studio?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, string | Record<string, unknown>>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  // What the person wants changed, and which of the shown results it is about.
  const [note, setNote] = useState("");
  // What the person says with their decision, at a review that asks for one.
  const [decision, setDecision] = useState("");
  const made = view.shown.filter((x) => x.output);
  const [target, setTarget] = useState<string | null>(made.length === 1 ? made[0].step.id : null);
  // Steps with several results: the ones picked to be made again.
  const [picked, setPicked] = useState<Record<string, number[]>>({});
  const prompt = useRef<HTMLTextAreaElement>(null);
  const aim = made.find((x) => x.step.id === target);
  const several = aim?.step.type === "generate" && (aim.output?.assets?.length ?? 0) > 1;
  const send = () => {
    if (aim && note.trim()) {
      void run.regenerate(step.id, aim.step.id, note.trim(), picked[aim.step.id]);
    }
  };
  return (
    <div className="animate-rise">
      <StepHeading title={step.title} description={step.description} />
      <div className="flex flex-col gap-6">
        {/* A step the run skipped (a branch) has nothing to review. */}
        {view.shown
          .filter((x) => x.kept)
          .map(({ step: s, label }) => (
            <KeptCard key={s.id} title={label ?? s.title} />
          ))}
        {view.shown
          .filter((x) => x.output)
          .map(({ step: s, output }) => {
            // A json step's data is edited by its schema, a written one as its text.
            const data = editableData(s);
            const editable =
              Boolean(step.edit) &&
              ((s.type === "agent" && s.output.format !== "json") || Boolean(data));
            const draft = drafts[s.id];
            const heading = (menu: React.ReactNode) => (
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="font-medium text-[0.8125rem] text-ink-3 uppercase tracking-[0.06em]">
                  {s.title}
                </h3>
                <div className="flex items-center">
                  {editable && !editing[s.id] ? (
                    <button
                      type="button"
                      onClick={() => setEditing((e) => ({ ...e, [s.id]: true }))}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] text-ink-2 hover:bg-accent hover:text-ink coarse:h-11"
                    >
                      <Pencil className="size-3.5" /> {t("run.edit")}
                    </button>
                  ) : null}
                  {menu}
                </div>
              </div>
            );
            const shown =
              data && output && editable && editing[s.id] ? (
                <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border-soft">
                  <DataEditor
                    shape={stepShape(data)}
                    value={
                      draft && typeof draft === "object"
                        ? draft
                        : ((output.json ?? {}) as Record<string, unknown>)
                    }
                    onChange={(next) => setDrafts((d) => ({ ...d, [s.id]: next }))}
                    start="edit"
                  />
                </div>
              ) : (
                <OutputView
                  base={`${runBase(view.id)}`}
                  step={s}
                  output={output}
                  onView={keepView(view.id, s.id)}
                  editable={editable && editing[s.id] && !data}
                  draft={typeof draft === "string" ? draft : undefined}
                  onDraft={(text) => setDrafts((d) => ({ ...d, [s.id]: text }))}
                  picked={picked[s.id]}
                  onPick={
                    step.regenerate
                      ? (i) => {
                          // Picking a result says what the change is about.
                          setTarget(s.id);
                          setPicked((p) => {
                            const now = p[s.id] ?? [];
                            return {
                              ...p,
                              [s.id]: now.includes(i) ? now.filter((x) => x !== i) : [...now, i],
                            };
                          });
                          prompt.current?.focus();
                        }
                      : undefined
                  }
                  onSurfaceAction={
                    step.regenerate
                      ? () => {
                          setTarget(s.id);
                          prompt.current?.focus();
                        }
                      : undefined
                  }
                />
              );
            return (
              <section key={s.id}>
                {studio && data && output ? (
                  <StudioData runId={view.id} step={data} output={output} header={heading}>
                    {shown}
                  </StudioData>
                ) : (
                  <>
                    {heading(null)}
                    {shown}
                  </>
                )}
              </section>
            );
          })}
        {view.lists.map((list) => (
          <section key={list.def.id}>
            <h3 className="mb-2 font-medium text-[0.8125rem] text-ink-3 uppercase tracking-[0.06em]">
              {list.def.title}
            </h3>
            {list.def.check ? (
              <ListCheck runId={view.id} list={list} />
            ) : (
              <ListTable runId={view.id} list={list} editable />
            )}
          </section>
        ))}
        {step.regenerate && made.length ? (
          // The way to say what should be different: always there, below what it is about.
          <Card className="p-3">
            {made.length > 1 ? (
              <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
                <span className="mr-1 text-[0.8125rem] text-ink-3">{t("run.feedbackTarget")}</span>
                {made.map(({ step: s }) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={target === s.id}
                    onClick={() => {
                      setTarget(s.id);
                      prompt.current?.focus();
                    }}
                    className={cn(
                      "inline-flex h-8 items-center rounded-full px-3 text-[0.8125rem] ring-1 transition coarse:h-11",
                      target === s.id
                        ? "bg-ember-tint text-ink ring-ember"
                        : "bg-card text-ink-2 ring-input hover:text-ink",
                    )}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            ) : null}
            <Textarea
              ref={prompt}
              minRows={2}
              maxRows={8}
              value={note}
              placeholder={t("run.feedbackPlaceholder")}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
              className="border-0 bg-transparent shadow-none focus:ring-0"
            />
            <div className="flex items-center justify-between gap-3 px-1 pt-1">
              <span className="min-w-0 text-[0.75rem] text-ink-3">
                {several
                  ? picked[aim.step.id]?.length
                    ? t("run.regeneratePicked", {
                        n: [...picked[aim.step.id]]
                          .sort((x, y) => x - y)
                          .map((i) => i + 1)
                          .join(", "),
                      })
                    : t("run.regenerateAll")
                  : !aim && note.trim()
                    ? t("run.feedbackPick")
                    : null}
              </span>
              <Button
                size="sm"
                variant="secondary"
                busy={run.busy}
                disabled={!note.trim() || !aim}
                onClick={send}
              >
                <RefreshCw className="size-3.5" /> {t("run.regenerateGo")}
              </Button>
            </div>
          </Card>
        ) : null}
      </div>
      {step.approve ? (
        <Textarea
          minRows={2}
          maxRows={6}
          value={decision}
          placeholder={t("run.decisionNote")}
          onChange={(e) => setDecision(e.target.value)}
          className="mt-4"
        />
      ) : null}
      <AnswerBy view={view} />
      <Footer view={view} run={run} sticky>
        {step.approve ? (
          <Button
            size="lg"
            variant="secondary"
            busy={run.busy}
            onClick={() => void run.decline(step.id, decision.trim() || undefined)}
          >
            {t("run.decline")}
          </Button>
        ) : null}
        <Button
          size="lg"
          busy={run.busy}
          onClick={() =>
            void run.accept(
              step.id,
              Object.keys(drafts).length ? drafts : undefined,
              decision.trim() || undefined,
            )
          }
        >
          {t(step.approve ? "run.approve" : "run.accept")} <ArrowRight className="size-4" />
        </Button>
      </Footer>
    </div>
  );
}

function Result({
  view,
  run,
  step,
  onRestart,
  studio,
}: {
  view: RunView;
  run: Run;
  step: ResultStep;
  onRestart?: () => void;
  studio?: boolean;
}) {
  const made = view.shown.filter((x) => x.output);
  const { Mascot, ShareResultButton, RunEnd } = runnerEnv();
  return (
    <div className="animate-rise">
      <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-5">
        <Mascot kind={view.wizard.avatar} costume={view.wizard.costume} size={64} />
        {/* On a phone the title keeps the row; the share button goes below it. */}
        <div className="min-w-0 flex-1 basis-[12rem]">
          <h1 className="wizard-title text-balance font-display font-semibold text-[1.75rem] leading-tight tracking-tight sm:text-[2rem]">
            {step.title}
          </h1>
          {step.message ? <p className="mt-1 text-[0.9375rem] text-ink-3">{step.message}</p> : null}
        </div>
        {ShareResultButton && view.shown.some((x) => x.output) ? (
          <div className="max-sm:basis-full">
            <ShareResultButton view={view} title={`${step.title} · ${view.wizard.title}`} />
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-6">
        {/* What a step made from the space's own connections stays with the team: the page says so. */}
        {view.shown
          .filter((x) => x.kept)
          .map(({ step: s, label }) => (
            <KeptCard key={s.id} title={label ?? s.title} />
          ))}
        {/* A step the run skipped (a branch) has made nothing to hand over. */}
        {made.map(({ step: s, output, formats, label }) => {
          const data = editableData(s);
          const heading = (menu: React.ReactNode) => (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-display font-semibold text-[1.0625rem]">{label ?? s.title}</h3>
              <div className="flex items-center gap-1">
                <DownloadButtons
                  base={`${runBase(view.id)}`}
                  stepId={s.id}
                  formats={formats}
                  title={label ?? s.title}
                  step={s}
                  output={output ?? undefined}
                  foot={`${view.wizard.title} · ${new Date().toLocaleDateString(runnerEnv().lang)}`}
                />
                {menu}
              </div>
            </div>
          );
          const shown = (
            <TranslatedOutput
              view={view}
              run={run}
              step={s}
              output={output}
              onView={keepView(view.id, s.id)}
            />
          );
          return (
            <Card key={s.id} className="p-4 sm:p-5">
              {studio && data && output ? (
                <StudioData runId={view.id} step={data} output={output} header={heading}>
                  {shown}
                </StudioData>
              ) : (
                <>
                  {heading(null)}
                  {shown}
                </>
              )}
              {output?.assets?.some((a) => a.ai) ? (
                // Whoever publishes it has to say so too; the file already does, in its metadata.
                <p className="mt-3 text-[0.75rem] text-ink-3 leading-relaxed">{t("ai.publish")}</p>
              ) : null}
            </Card>
          );
        })}
        {view.lists.map((list) => (
          <Card key={list.def.id} className="p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-display font-semibold text-[1.0625rem]">
                {list.label ?? list.def.title}
              </h3>
              <ListDownloads runId={view.id} list={list} />
            </div>
            <ListTable runId={view.id} list={list} editable />
          </Card>
        ))}
      </div>
      {RunEnd && !studio ? <RunEnd view={view} /> : null}
      <Footer view={view} run={run}>
        {onRestart ? (
          <Button variant="secondary" onClick={onRestart}>
            <RotateCcw className="size-4" /> {t("run.again")}
          </Button>
        ) : (
          <span />
        )}
      </Footer>
    </div>
  );
}

function Failed({ view, run }: { view: RunView; run: Run }) {
  const { Mascot, RunEnd } = runnerEnv();
  return (
    <div className="flex animate-rise flex-col items-center pt-8 text-center">
      <Mascot kind={view.wizard.avatar} costume={view.wizard.costume} size={90} />
      <h2 className="wizard-heading mt-4 font-display font-semibold text-[1.375rem]">
        {t("run.failed")}
      </h2>
      <p className="mt-2 max-w-md text-[0.9375rem] text-ink-3">
        <LinkedText text={view.error ?? ""} />
      </p>
      <div className="mt-8 flex gap-3">
        {view.canBack ? (
          <Button variant="ghost" onClick={() => void run.back()}>
            <ArrowLeft className="size-4" /> {t("run.back")}
          </Button>
        ) : null}
        <Button onClick={() => void run.retry()} busy={run.busy}>
          <RotateCcw className="size-4" /> {t("run.retry")}
        </Button>
      </div>
      {RunEnd ? <RunEnd view={view} failed /> : null}
    </div>
  );
}

/**
 * A result in a translated run: as it was made, with the offer to read its text in the run's
 * language; once translated, the translation with the way back to the original.
 */
function TranslatedOutput({
  view,
  run,
  step,
  output,
  onView,
}: {
  view: RunView;
  run: Run;
  step: Step;
  output: StepOutput | null;
  onView?: (state: Record<string, unknown>) => void;
}) {
  const [original, setOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = runBase(view.id);
  const translated = view.translation?.results[step.id];
  if (!(view.translation && output?.text && run.translateResult)) {
    return <OutputView base={base} step={step} output={output} onView={onView} />;
  }
  const shown = translated && !original ? { ...output, text: translated } : output;
  return (
    <>
      <OutputView base={base} step={step} output={shown} onView={onView} />
      <div className="mt-3 flex items-center gap-3 text-[0.8125rem] text-ink-3">
        {translated ? (
          <>
            {original ? null : <span>{t("translation.machine")}</span>}
            <button
              type="button"
              className="underline-offset-4 hover:text-ink hover:underline coarse:min-h-11"
              onClick={() => setOriginal((o) => !o)}
            >
              {t(original ? "translation.showTranslated" : "translation.showOriginal")}
            </button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await run.translateResult?.(step.id);
              setBusy(false);
            }}
          >
            <Languages className="size-4" />{" "}
            {busy ? t("translation.working") : t("result.translate")}
          </Button>
        )}
      </div>
    </>
  );
}
export function RunnerBody({
  run,
  compact,
  onRestart,
  onView,
  stickyProgress,
  studio,
}: {
  run: RunSource;
  compact?: boolean;
  /** In the studio: a json step's data can be viewed, edited and its JSON Schema read. */
  studio?: boolean;
  onRestart?: () => void;
  onView?: (view: RunView | null) => void;
  /** In a box of its own (an AI app's widget): the progress stays on top while the page scrolls. */
  stickyProgress?: boolean;
}) {
  const { view } = run;
  setChoiceLabels(view?.translation?.labels);
  useEffect(() => {
    onView?.(view);
  }, [view, onView]);
  useKeyboardInset();
  const awake = useWakeLock(view?.status === "running" && !view.ask);
  useDoneSignal(view);
  if (run.notFound) {
    return <div className="py-24 text-center text-ink-3">{t("run.notFound")}</div>;
  }
  if (!view) {
    return (
      <div className="flex justify-center py-24 text-ink-4">
        <Spinner />
      </div>
    );
  }
  const step = view.step;
  let body: React.ReactNode = null;
  if (view.answeredBy) {
    body = <AnsweredElsewhere view={view} run={run} compact={compact} />;
  } else if (view.status === "running" && view.ask) {
    body = <AskPanel key={view.ask.id} runId={view.id} ask={view.ask} />;
  } else if (view.status === "waiting_input" && view.question) {
    body = (
      <>
        <AskedAt view={view} compact={compact} />
        <QuestionPanel key={view.question} runId={view.id} question={view.question} />
      </>
    );
  } else if (view.status === "running") {
    body = <Working view={view} compact={compact} awake={awake} />;
  } else if (view.status === "sleeping" || view.status === "waiting_signal") {
    body = <Sleeping view={view} compact={compact} />;
  } else if (view.status === "failed") {
    body = <Failed view={view} run={run} />;
  } else if (view.status === "cancelled") {
    body = <div className="py-24 text-center text-ink-3">{t("run.cancelled")}</div>;
  } else if (step?.type === "form") {
    body = <PageForm key={step.id} view={view} run={run} step={step} />;
  } else if (step?.type === "review") {
    // A regenerated output is a fresh review: drafts and notes start over.
    const version = view.shown.map((x) => x.output?.at ?? "").join("|");
    body = (
      <Review key={`${step.id}:${version}`} view={view} run={run} step={step} studio={studio} />
    );
  } else if (step?.type === "result") {
    body = <Result view={view} run={run} step={step} onRestart={onRestart} studio={studio} />;
  }
  // Rows beside their files need the width of the screen.
  const wide =
    step?.type === "review" &&
    view.status === "waiting_input" &&
    view.lists.some((l) => l.def.check);
  return (
    <div className="flex min-h-full flex-col">
      {stickyProgress ? (
        <div className="sticky top-0 z-10">
          <Progress view={view} />
        </div>
      ) : (
        <Progress view={view} />
      )}
      <div
        className={cn(
          "safe-x kb-tight mx-auto w-full flex-1",
          wide
            ? "max-w-[1240px] py-8"
            : compact
              ? "max-w-[620px] py-8"
              : "max-w-[640px] py-8 sm:py-16",
        )}
      >
        {body}
        {run.error && view.status !== "failed" ? (
          <div className="mt-4 rounded-lg bg-rose-tint px-4 py-3 text-[0.875rem] text-rose">
            {run.error}
          </div>
        ) : null}
        {view.keeps && view.status !== "running" ? (
          <div className="mt-10 flex justify-center">
            <StoreButton runId={view.id} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A result that stays in the space (`ShownStep.kept`): its title and the note in its place. */
export function KeptCard({ title }: { title: string }) {
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="mb-2 font-display font-semibold text-[1.0625rem]">{title}</h3>
      <p className="text-[0.9375rem] text-ink-3 leading-relaxed">
        {noteLine(note("resultKeptInSpace"))}
      </p>
    </Card>
  );
}
