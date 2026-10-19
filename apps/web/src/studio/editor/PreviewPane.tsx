import { RunnerBody as RunnerPage, setRunnerLang } from "@engenty/wizards-runner";
import { isLang, langName, wizardLang } from "@engenty/wizards-shared/definition";
import type { RunTheme, RunView } from "@engenty/wizards-shared/run";
import { DEFAULT_RUNNER_SETTINGS } from "@engenty/wizards-shared/runners";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Flag,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Play,
  RotateCcw,
  Smartphone,
  Sun,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import type { WizardDetail } from "../../lib/session";
import { ChatBody } from "../../runner/ChatView";
import { WizardEffects } from "../../runner/effects";
import { RunnerBody, type RunSource } from "../../runner/RunnerView";
import { bothModes, useScopedLook } from "../../runner/theme";
import { Button, cn, IconButton } from "../../ui";
import { LookSwitch, type RunLook } from "../RunDrawer";
import { type Audience, ResultPreview } from "./ResultPreview";

/** A theme the wizard offers, as the runtime draws it (`GET …/looks`). */
interface ThemeLook {
  id: string;
  name: string | null;
  theme: RunTheme;
}

type Mode = "light" | "dark";

/** A pill of a few choices, in the look of the editor's switches. */
export function Pills<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; icon?: ReactNode }[];
}) {
  return (
    <fieldset
      aria-label={label}
      className="m-0 flex shrink-0 rounded-full border-0 bg-paper-2 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          title={o.label}
          onClick={() => onChange(o.id)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-medium text-[0.75rem] transition coarse:h-9",
            value === o.id ? "bg-card text-ink shadow-soft" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.icon}
          <span className={cn(o.icon ? "sr-only" : undefined)}>{o.label}</span>
        </button>
      ))}
    </fieldset>
  );
}

/** A small menu of choices, where there may be more than a pill holds. */
function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="relative flex shrink-0 items-center">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={label}
        className={cn(
          "h-8 appearance-none truncate rounded-full border-0 bg-paper-2 py-0 pr-7 pl-3 font-medium text-[0.75rem] text-ink outline-none focus-visible:ring-2 focus-visible:ring-ember coarse:h-10 max-w-40",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 size-3 text-ink-3"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </label>
  );
}

/** The name a theme shows in the switch: its own, or the built-in one's. */
function lookName(look: ThemeLook): string {
  return (
    look.name ??
    t(look.id === "default" ? "inspector.lookThemeDefault" : "inspector.lookThemeBrand")
  );
}

/**
 * The editor's main view: the wizard as the people who use it see it, in its look, with the
 * switches it is configured for — its themes, light and dark pages, its languages, page by page
 * or as a chat — and how it sits on a desk or a phone. It shows the step chosen as a run shows
 * it there, filled from the latest test run (the result step as its result page), or the test
 * run itself; with neither it offers to start one.
 */
export function PreviewPane({
  wizard: w,
  runId,
  runView,
  onView,
  stepId,
  onStep,
  audience,
  onAudience,
  test,
  wide,
  onWide,
  onClose,
  building,
  log,
  strip,
}: {
  wizard: WizardDetail;
  runId: string | null;
  runView: RunView | null;
  onView: (view: RunView | null) => void;
  /** The step shown; null: the test run, or without one the start. */
  stepId: string | null;
  /** Shows a step: the result page, from the start. */
  onStep: (stepId: string) => void;
  audience: Audience;
  onAudience: (audience: Audience) => void;
  test: { start: () => void; busy: boolean; disabled: boolean };
  /** Whether the preview fills the window, the side panel and the flow set aside; null: no room for that. */
  wide: boolean | null;
  onWide: (wide: boolean) => void;
  onClose: () => void;
  /** Shown in place of the preview while the assistant builds the first draft. */
  building: ReactNode;
  /** The run's log, under the run. */
  log: ReactNode;
  /** The steps in a row, under the preview's switches. */
  strip: ReactNode;
}) {
  const def = w.draft;

  // The themes the wizard offers; the first is the one its pages show.
  const looks = useQuery({
    queryKey: ["wizard-looks", w.id, w.revision],
    queryFn: () => api.get<{ looks: ThemeLook[] }>(`/api/studio/wizards/${w.id}/looks`),
  }).data?.looks;
  const [lookId, setLookId] = useState<string | null>(null);
  const look = looks?.find((x) => x.id === lookId) ?? looks?.[0] ?? null;
  const theme = look?.theme ?? runView?.brand.theme ?? null;
  const [mode, setMode] = useState<Mode | null>(null);
  const firstMode: Mode = theme?.prefer ?? (theme?.dark ? "dark" : "light");
  const shownMode = mode ?? firstMode;
  const scoped = useScopedLook(theme, mode);

  // Page by page or as a chat: the ones the wizard offers, the one its link opens first.
  const offered = w.runners ?? DEFAULT_RUNNER_SETTINGS;
  const ways = (["steps", "chat"] as const).filter(
    (id) => offered.enabled.includes(id) || offered.default === id,
  );
  const firstWay: RunLook = offered.default === "chat" && ways.includes("chat") ? "chat" : "steps";
  const [way, setWay] = useState<RunLook | null>(null);
  const shownWay = way ?? firstWay;

  // The wizard's own language and the ones it is kept in, where its page offers a translation.
  const own = wizardLang(def);
  const kept = useQuery({
    queryKey: ["wizard-translations", w.id],
    queryFn: () =>
      api.get<{ translations: { lang: string }[] }>(`/api/studio/wizards/${w.id}/translations`),
    enabled: w.published && w.translate,
  });
  const langs = [
    own,
    ...(w.translate ? (kept.data?.translations ?? []).map((x) => x.lang) : []),
  ].filter((code, i, all) => all.indexOf(code) === i);
  const [shownLang, setShownLang] = useState(own);
  // The run reads in the language picked from then on; a new run starts in the wizard's own.
  const told = useRef<{ run: string | null; lang: string }>({ run: null, lang: own });
  useEffect(() => {
    if (!runId) {
      return;
    }
    const before = told.current;
    told.current = { run: runId, lang: shownLang };
    if (before.run === runId ? before.lang === shownLang : shownLang === own) {
      return;
    }
    void api
      .post(`/api/runs/${runId}/lang`, { lang: shownLang === own ? null : shownLang })
      .catch(() => undefined);
  }, [runId, shownLang, own]);
  // The runner's own words follow, where engenty speaks the language; the studio's come back after.
  useEffect(() => {
    if (shownLang !== own && isLang(shownLang)) {
      setRunnerLang(shownLang);
    }
    return () => setRunnerLang(lang);
  }, [shownLang, own]);

  const [device, setDevice] = useState<"desk" | "phone">("desk");

  // The step chosen, as a run shows it there; the result step is its result page.
  const shown = stepId ? (def.steps.find((s) => s.id === stepId) ?? null) : null;
  const resultStep = def.steps.find((s) => s.type === "result") ?? null;
  const stepView = useQuery({
    queryKey: ["draft-step-view", w.id, shown?.id, w.revision, shownLang],
    queryFn: () =>
      api.get<RunView>(
        `/api/studio/wizards/${w.id}/steps/${encodeURIComponent(shown?.id ?? "")}/view${
          shownLang === own ? "" : `?lang=${encodeURIComponent(shownLang)}`
        }`,
      ),
    enabled: Boolean(shown && shown.type !== "result"),
    placeholderData: keepPreviousData,
  });
  // Shown, not run: what a page or a review would do is not done.
  const still = async () => false;
  const stepSource: RunSource | null =
    shown && stepView.data
      ? {
          view: stepView.data,
          notFound: false,
          error: null,
          busy: false,
          fieldErrors: {},
          submitPage: still,
          accept: still,
          regenerate: still,
          back: still,
          retry: still,
        }
      : null;

  const result = shown?.type === "result" ? shown : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {result ? (
        <div className="min-h-0 flex-1">
          <ResultPreview
            wizardId={w.id}
            def={def}
            step={result}
            revision={w.revision}
            audience={audience}
            onAudience={onAudience}
            lead={null}
            under={strip}
            onTest={test.start}
            testBusy={test.busy}
            testDisabled={test.disabled}
          />
        </div>
      ) : null}
      {/* Kept while the result page shows, so an open run keeps its place. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", result && "hidden")}>
        <div className="kb-hide flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-border-soft border-b px-3 [scrollbar-width:none]">
          <span className="flex-1" />
          {ways.length > 1 && !shown ? (
            <span className="shrink-0">
              <LookSwitch look={shownWay} onChange={setWay} ways={[...ways]} />
            </span>
          ) : null}
          {looks && looks.length > 1 && look ? (
            <Choice
              label={t("editor.previewTheme")}
              value={look.id}
              onChange={setLookId}
              options={looks.map((x) => ({ value: x.id, label: lookName(x) }))}
            />
          ) : null}
          {bothModes(theme) ? (
            <Pills<Mode>
              label={t("editor.previewMode")}
              value={shownMode}
              onChange={setMode}
              options={[
                { id: "light", label: t("theme.light"), icon: <Sun className="size-3.5" /> },
                { id: "dark", label: t("theme.dark"), icon: <Moon className="size-3.5" /> },
              ]}
            />
          ) : null}
          {langs.length > 1 ? (
            <Choice
              label={t("editor.previewLang")}
              value={shownLang}
              onChange={setShownLang}
              options={langs.map((code) => ({ value: code, label: langName(code) }))}
            />
          ) : null}
          <span className="max-sm:hidden">
            <Pills<"desk" | "phone">
              label={t("editor.device")}
              value={device}
              onChange={setDevice}
              options={[
                {
                  id: "desk",
                  label: t("editor.deviceDesk"),
                  icon: <Monitor className="size-3.5" />,
                },
                {
                  id: "phone",
                  label: t("editor.devicePhone"),
                  icon: <Smartphone className="size-3.5" />,
                },
              ]}
            />
          </span>
          {runId ? (
            <IconButton
              label={t("editor.restart")}
              disabled={test.disabled || test.busy}
              onClick={test.start}
            >
              <RotateCcw className="size-4" />
            </IconButton>
          ) : null}
          {wide === null ? null : (
            <IconButton
              label={t(wide ? "editor.runNarrow" : "editor.runWide")}
              onClick={() => onWide(!wide)}
            >
              {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </IconButton>
          )}
          {runId ? (
            <IconButton label={t("editor.close")} onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          ) : null}
        </div>

        {strip}
        {/* The wizard's theme shows on this part of the page only. */}
        <div
          className={cn(
            "relative flex min-h-0 flex-1 justify-center",
            device === "phone" && "bg-paper-2 py-4",
          )}
        >
          <div
            className={cn(
              "relative min-h-0 w-full",
              scoped?.className,
              device === "phone" &&
                "max-w-[390px] overflow-hidden rounded-[2rem] shadow-elevated ring-8 ring-paper-3",
            )}
            style={scoped?.style}
          >
            <WizardEffects effects={theme?.effects} contained />
            <div className="absolute inset-0 overflow-y-auto bg-background">
              {building ? (
                <div className="flex h-full items-center justify-center px-6 text-[0.875rem] text-ink-3">
                  {building}
                </div>
              ) : shown || runId ? (
                <>
                  {shown && stepSource ? (
                    // A view that arrives anew starts the page again from its values.
                    <RunnerPage
                      key={`${shown.id}:${stepView.dataUpdatedAt}`}
                      run={stepSource}
                      compact
                      studio
                    />
                  ) : null}
                  {/* The run stays while a step is shown, so it goes on and keeps its place. */}
                  {runId ? (
                    <div className={cn(shown && "hidden")}>
                      {shownWay === "chat" ? (
                        <ChatBody
                          key={runId}
                          runId={runId}
                          onRestart={test.start}
                          onView={onView}
                        />
                      ) : (
                        <RunnerBody
                          key={runId}
                          runId={runId}
                          compact
                          studio
                          onRestart={test.start}
                          onView={onView}
                        />
                      )}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                  <h2 className="text-balance font-display font-semibold text-[1.5rem] tracking-tight">
                    {def.title}
                  </h2>
                  {def.description ? (
                    <p className="max-w-md text-balance text-[0.9375rem] text-ink-2">
                      {def.description}
                    </p>
                  ) : null}
                  <Button busy={test.busy} disabled={test.disabled} onClick={test.start}>
                    <Play className="size-4" />
                    {t("editor.test")}
                  </Button>
                  <p className="max-w-sm text-balance text-[0.8125rem] text-ink-3">
                    {t("editor.previewEmpty")}
                  </p>
                  {resultStep ? (
                    <button
                      type="button"
                      onClick={() => onStep(resultStep.id)}
                      className="inline-flex items-center gap-1.5 text-[0.8125rem] text-ink-3 underline-offset-4 hover:text-ink hover:underline"
                    >
                      <Flag className="size-3.5" />
                      {t("resultPreview.title")}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
        {runId && !shown ? log : null}
      </div>
    </div>
  );
}
