import { type ModelClass, TEXT_CLASSES } from "@engenty-wizards/shared/definition";
import type { MissingModel, RunView } from "@engenty-wizards/shared/run";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Flag,
  Lock,
  Maximize2,
  Minimize2,
  Play,
  RotateCcw,
  Share2,
  Workflow,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { eventText, type Key, t } from "../lib/i18n";
import {
  type PublishResult,
  useCloud,
  useMe,
  useProjects,
  type WizardDetail,
} from "../lib/session";
import { ChatBody } from "../runner/ChatView";
import { RunnerBody } from "../runner/RunnerView";
import { Button, Chip, cn, IconButton, LinkedText, Spinner } from "../ui";
import { CreditsPill } from "./AppFrame";
import {
  type Adding,
  AddStepPanel,
  addStepMessage,
  placeText,
  type StepAssistant,
  withEmptyStep,
} from "./editor/AddStep";
import { ChatPanel, useArchitectChat, Working } from "./editor/ChatPanel";
import { FilesPanel } from "./editor/FilesPanel";
import { currentDecisions, FlowDiagram, type StepLive } from "./editor/FlowDiagram";
import { Inspector } from "./editor/Inspector";
import { LiveDialog } from "./editor/LiveDialog";
import { MemoryPanel } from "./editor/MemoryPanel";
import { type Audience, ResultPreview } from "./editor/ResultPreview";
import { RunLog } from "./editor/RunLog";
import { RunsPanel } from "./editor/RunsPanel";
import { ShareDialog } from "./editor/ShareDialog";
import { ResultPageOpener } from "./editor/share";
import { LiveChip, useLiveDraft } from "./live";
import { LookSwitch, useRunLook } from "./RunDrawer";
import { WizardMenu } from "./WizardMenu";
import { WhereChip, whereItRuns } from "./where";

type Tab = "chat" | "step" | "files" | "memory" | "runs";

/** The model classes an account's credits run: text, images, videos. */
const CREDIT_CLASSES: readonly ModelClass[] = [...TEXT_CLASSES, "image", "video"];

const TAB_LABEL: Record<Tab, string> = {
  chat: "editor.chat",
  step: "editor.step",
  files: "editor.files",
  memory: "editor.memory",
  runs: "editor.runs",
};

const PANE_KEY = "wizards.editor.pane";
const PANE_DEFAULT = 420;
/** The main area's width from which a test run sits beside the diagram, not over it. */
const SPLIT_MIN = 880;
const PANE_MIN = 340;

/** Room the diagram keeps next to the pane. */
const paneMax = () => Math.max(PANE_MIN, window.innerWidth - 480);

const RUN_KEY = "wizards.editor.run";
const RUN_DEFAULT = 560;
const RUN_MIN = 420;
/** Room the diagram keeps next to a test run beside it. */
const RUN_ROOM = 360;

/**
 * A column's width on wide screens, dragged at its inner edge; remembered per browser. `dir` is
 * +1 when dragging right widens it (a column on the left), -1 for one on the right.
 */
function useDragWidth({
  key,
  initial,
  min,
  max,
  dir,
}: {
  key: string;
  initial: number;
  min: number;
  max: () => number;
  dir: 1 | -1;
}) {
  const [width, setWidth] = useState(() => {
    try {
      const n = Number(localStorage.getItem(key));
      return n ? Math.min(Math.max(n, min), max()) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: number) => {
    const w = Math.round(Math.min(Math.max(next, min), max()));
    setWidth(w);
    try {
      localStorage.setItem(key, String(w));
    } catch {
      // the width only lasts this page then
    }
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => set(startW + dir * (ev.clientX - startX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      set(width + (e.key === "ArrowRight" ? dir : -dir) * step);
    }
  };
  return { width, onPointerDown, onKeyDown, reset: () => set(initial) };
}

const SHEET_KEY = "wizards.editor.sheet";
/** Percent of the room below the header: open, the sheet takes all of it. */
const SHEET_DEFAULT = 100;
/** The folded sheet: its handle and tabs. */
const SHEET_MIN = 76;
/** A drag let go above this percent opens the sheet to the whole room, below it folds. */
const SHEET_SNAP = 50;
/** Pixels a touch moves before it drags instead of tapping. */
const SHEET_SLOP = 6;

function storedSheet(): number {
  try {
    const raw = localStorage.getItem(SHEET_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    // Open is the whole room; only folded is kept as it was.
    return Number.isFinite(n) && n === 0 ? 0 : SHEET_DEFAULT;
  } catch {
    return SHEET_DEFAULT;
  }
}

/**
 * The pane as a bottom sheet on small screens: its height in percent of the room below the
 * header, dragged at its handle, 0 when folded to its tabs. A tap on the handle folds and unfolds
 * it. Remembered per browser.
 */
function useSheetHeight() {
  const [percent, setPercent] = useState(storedSheet);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLElement>(null);
  /** Sets the height, remembered in this browser. */
  const set = useCallback((next: number) => {
    const p = Math.round(Math.min(Math.max(next, 0), 100) * 10) / 10;
    setPercent(p);
    try {
      localStorage.setItem(SHEET_KEY, String(p));
    } catch {
      // the height only lasts this page then
    }
  }, []);
  const folded = percent === 0;
  const toggle = () => set(folded ? SHEET_DEFAULT : 0);
  const unfold = () => {
    if (folded) {
      set(SHEET_DEFAULT);
    }
  };
  const fold = () => set(0);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const sheet = ref.current;
    const room = sheet?.parentElement;
    if (!(sheet && room) || e.button !== 0) {
      return;
    }
    e.preventDefault();
    const startY = e.clientY;
    const startH = sheet.getBoundingClientRect().height;
    const roomH = room.getBoundingClientRect().height;
    let moved = false;
    let last = percent;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < SHEET_SLOP) {
        return;
      }
      if (!moved) {
        moved = true;
        setDragging(true);
      }
      const h = Math.min(startH + startY - ev.clientY, roomH);
      set(h < SHEET_MIN + 16 ? 0 : (h / roomH) * 100);
      // Let go, it opens to the whole room or folds, whichever is nearer.
      last = h / roomH > SHEET_SNAP / 100 ? 100 : 0;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      setDragging(false);
      if (moved) {
        set(last);
      } else if (ev.type === "pointerup") {
        toggle();
      }
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      set(100);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      set(0);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
  /** The sheet's height, kept between folded and the whole room. */
  const height = `clamp(${SHEET_MIN}px, ${percent}%, 100%)`;
  return { ref, percent, height, folded, dragging, unfold, fold, toggle, onPointerDown, onKeyDown };
}

export function EditorPage() {
  const account = useFeature("account");
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const wizard = useQuery({
    queryKey: ["wizard", id],
    queryFn: () => api.get<WizardDetail>(`/api/studio/wizards/${id}`),
    // The live stream keeps it fresh; a refetch on focus would only race unsaved edits.
    refetchOnWindowFocus: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const pane = useDragWidth({
    key: PANE_KEY,
    initial: PANE_DEFAULT,
    min: PANE_MIN,
    max: paneMax,
    dir: 1,
  });
  const sheet = useSheetHeight();
  // The tab in effect stays in view where the row scrolls (a phone).
  const tabsRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab in effect is what moves into view
  useEffect(() => {
    tabsRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [tab, sheet.folded]);
  /** Where a touch on the step panel began, for a swipe. */
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  /** The test run open in the main area, which shows it or the diagram. */
  const [drawerRun, setDrawerRun] = useState<string | null>(null);
  /** What the main area shows where it has no room for two: the flow, the test run, the result page. */
  const [view, setView] = useState<"flow" | "test" | "result">("flow");
  /** Whom the result page is shown as: a visitor, or the wizard's owner. */
  const [audience, setAudience] = useState<Audience>("visitor");
  /** The result page beside the flow, closed until another step is chosen. */
  const [pageClosed, setPageClosed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another step, the page may open again
  useEffect(() => {
    setPageClosed(false);
    setView((v) => (v === "result" ? "flow" : v));
  }, [selected]);
  /** On a desk the test run can take the whole window, the side panel set aside. */
  const [runWide, setRunWide] = useState(false);
  /** Counts the side panel's slides, so the diagram fits the room it ends with. */
  const [paneMoves, setPaneMoves] = useState(0);
  const [look, setLook] = useRunLook();
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<RunView["decisions"]>();
  const [branchFocus, setBranchFocus] = useState(0);
  /** The step the assistant builds for a request from the step panel or the diagram. */
  const [adding, setAdding] = useState<Adding | null>(null);
  /** Where a "+" in the diagram asks for a step: before the step at this index. */
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const openInsert = useCallback((at: number) => setInsertAt(at), []);
  /** The open test run as it reports itself: its step, status and log. */
  const [runView, setRunView] = useState<RunView | null>(null);
  const onRunView = useCallback(
    (view: RunView | null) => {
      setRunView(view);
      // A finished test run fills the result page's preview anew.
      if (view?.status === "done") {
        void qc.invalidateQueries({ queryKey: ["share-preview", id] });
      }
      setActiveStep(view && view.status !== "done" ? (view.step?.id ?? null) : null);
      // Kept when the drawer closes: the step panel it covered shows the last test run's decisions.
      if (view) {
        setDecisions(view.decisions);
      }
    },
    [qc, id],
  );
  // What the run's step in effect does, for its node in the diagram.
  const live = useMemo<StepLive | null>(() => {
    const step = drawerRun ? runView?.step : null;
    if (!(runView && step) || runView.status === "done" || runView.status === "cancelled") {
      return null;
    }
    const failed = runView.status === "failed";
    const waiting = runView.status === "waiting_input";
    const mine = runView.events.filter((ev) => ev.stepId === step.id).reverse();
    const started = mine.find((ev) => ev.type === "step_started");
    const latest = mine.find((ev) => ev.type !== "step_done");
    const said = latest ? eventText(latest) : step.title;
    return {
      step: step.id,
      text: failed ? (runView.error ?? said) : waiting ? t("editor.waitsForInput") : said,
      since: failed || waiting ? null : started ? new Date(started.at).getTime() : Date.now(),
      failed,
    };
  }, [drawerRun, runView]);
  // The main area's width: with room for both, a test run sits beside the diagram.
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const [mainWidth, setMainWidth] = useState(0);
  useEffect(() => {
    if (!mainEl) {
      return;
    }
    const observer = new ResizeObserver(() => setMainWidth(mainEl.clientWidth));
    observer.observe(mainEl);
    return () => observer.disconnect();
  }, [mainEl]);
  const split = Boolean(drawerRun) && mainWidth >= SPLIT_MIN;
  const runPane = useDragWidth({
    key: RUN_KEY,
    initial: RUN_DEFAULT,
    min: RUN_MIN,
    max: () => Math.max(RUN_MIN, (mainEl?.clientWidth ?? window.innerWidth) - RUN_ROOM),
    dir: -1,
  });
  const { save, saving, remote, merged, refused } = useLiveDraft(id);
  const projects = useProjects();

  const chat = useArchitectChat(wizard.data, (draft, revision) => {
    qc.setQueryData<WizardDetail>(["wizard", id], (old) =>
      old ? { ...old, draft, revision, title: draft.title, blank: false } : old,
    );
  });

  // A wizard created from the start page arrives with its first prompt.
  const sentPrompt = useRef(false);
  useEffect(() => {
    const prompt = params.get("prompt");
    if (prompt && wizard.data && !sentPrompt.current) {
      sentPrompt.current = true;
      setParams({}, { replace: true });
      void chat.send(prompt);
    }
  }, [params, wizard.data, chat, setParams]);

  // Models the draft needs that this runtime cannot serve: a step on every path blocks the test.
  const models = useQuery({
    queryKey: ["wizard-models", id, wizard.data?.revision],
    queryFn: () => api.get<{ missing: MissingModel[] }>(`/api/studio/wizards/${id}/models`),
    enabled: Boolean(wizard.data),
  });
  const missing = models.data?.missing ?? [];
  // A local install with an account sends what it publishes on to the account's cloud.
  const cloudLinked = me.data?.mode === "local" && Boolean(me.data.account);
  const cloud = useCloud(id ?? "", Boolean(id) && cloudLinked);
  const blocked = missing.some((m) => m.blocking);
  /** A run opens in the main area; on a phone the sheet folds so the run gets the screen. */
  const openRun = (runId: string) => {
    setDrawerRun(runId);
    setRunView(null);
    setView("test");
    // The run gets the room: on a desk the side panel steps aside (its bar brings it back).
    setRunWide(true);
    sheet.fold();
  };
  const closeRun = () => {
    setDrawerRun(null);
    setRunView(null);
    setView("flow");
    setRunWide(false);
  };
  const testRun = useMutation({
    mutationFn: () => api.post<{ runId: string }>(`/api/studio/wizards/${id}/test-runs`),
    onSuccess: ({ runId }) => openRun(runId),
  });
  const publish = useMutation({
    mutationFn: () => api.post<PublishResult>(`/api/studio/wizards/${id}/publish`),
    onSuccess: async ({ cloud }) => {
      // With an account linked the version went on to its cloud: how that went comes along, and
      // the dialog that published says so.
      if (cloud) {
        qc.setQueryData(["cloud", id], { linked: true, ...cloud });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["wizard", id] }),
        qc.invalidateQueries({ queryKey: ["cloud", id] }),
        qc.invalidateQueries({ queryKey: ["wizards"] }),
      ]);
    },
  });

  const issueSteps = useMemo(
    () => new Set((wizard.data?.issues ?? []).map((i) => i.stepId).filter(Boolean) as string[]),
    [wizard.data?.issues],
  );

  if (wizard.isLoading || !me.data) {
    return (
      <div className="flex flex-1 items-center justify-center text-ink-4">
        <Spinner />
      </div>
    );
  }
  if (!wizard.data) {
    return <div className="p-10 text-center text-ink-3">{t("run.notFound")}</div>;
  }
  const w = wizard.data;
  const def = w.draft;
  const shownDecisions = currentDecisions(def, decisions);
  // A first build covers the diagram; a step asked for in place is shown in its place instead.
  const building = chat.phase !== "idle" && w.blank && !adding;
  const hasIssues = w.issues.length > 0;
  // The result page shows while its step is chosen and no test run is open: beside the flow where
  // there is room, else in its place, behind a switch.
  const chosen = def.steps.find((s) => s.id === selected);
  const resultStep = chosen?.type === "result" && !building && !drawerRun ? chosen : null;
  const pageBeside = Boolean(resultStep) && !pageClosed && mainWidth >= SPLIT_MIN;
  const pageInPlace = Boolean(resultStep) && mainWidth < SPLIT_MIN;
  const openPage =
    resultStep && !pageBeside
      ? () => {
          setPageClosed(false);
          setView("result");
          sheet.fold();
        }
      : null;
  /** Asks the assistant to mend the draft's issues, in the chat. */
  const fixIssues = () => {
    setShareOpen(false);
    setLiveOpen(false);
    setTab("chat");
    void chat.send(
      `${t("editor.fixIssuesAsk")}\n${w.issues.map((i) => `- ${i.message}`).join("\n")}`,
    );
  };
  // Read-only for one of two reasons: the wizard is a local install's, or nothing is built here.
  // Its project says which. A project that is not in the list was made here by a tenant that
  // builds nothing here any more.
  const project = projects.data?.find((p) => p.id === w.projectId);
  const fromLocal = project
    ? project.origin === "local"
    : me.data.limits.build || projects.isLoading;
  const readOnlyNote = w.readOnly ? t(fromLocal ? "readonly.wizard" : "readonly.server") : null;
  /**
   * What the account's credits would do for the models that are missing — text, images, videos:
   * `connect` without an account, `use` with one whose credits the models do not run on yet.
   */
  const credits =
    me.data.mode === "local" && account && missing.some((m) => CREDIT_CLASSES.includes(m.cls))
      ? !me.data.account
        ? "connect"
        : me.data.models?.source !== "account"
          ? "use"
          : null
      : null;
  /** A write the server refused, in its own words. */
  const failed = refused ?? (publish.error ? (publish.error as Error).message : null);

  const select = (sid: string | null) => {
    setSelected(sid);
    if (sid) {
      setTab("step");
      sheet.unfold();
    }
  };

  /** A swipe on the step panel: left to the next step, right to the one before (the wizard's own settings first). */
  const stepSwipe = {
    onTouchStart: (e: React.TouchEvent) => {
      const target = e.target as HTMLElement;
      // A field, a slider, a row that scrolls sideways keep their own gestures.
      const own = target.closest(
        "input, textarea, select, [contenteditable='true'], [role='slider']",
      );
      const touch = e.touches[0];
      swipeStart.current =
        own || e.touches.length > 1 || !touch ? null : { x: touch.clientX, y: touch.clientY };
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const start = swipeStart.current;
      swipeStart.current = null;
      const touch = e.changedTouches[0];
      if (!(start && touch)) {
        return;
      }
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) {
        return;
      }
      const ids = ["__wizard", ...def.steps.map((st) => st.id)];
      const at = selected ? ids.indexOf(selected) : -1;
      const next = at + (dx < 0 ? 1 : -1);
      if (next >= 0 && next < ids.length) {
        select(ids[next]);
      }
    },
  };

  /**
   * A step asked for in the step panel or the diagram goes to the conversation as the admin's
   * message, so the thread tells what was asked and built. The step appears in its place while
   * the assistant builds it, and is selected once it is there.
   */
  const addStep = (request: Adding): boolean => {
    if (chat.phase !== "idle") {
      return false;
    }
    const before = new Set(def.steps.map((s) => s.id));
    setAdding(request);
    void chat.send(addStepMessage(def, request)).then(() => {
      setAdding(null);
      const latest = qc.getQueryData<WizardDetail>(["wizard", id])?.draft;
      const added = latest?.steps.find((s) => !before.has(s.id));
      if (added) {
        setSelected(added.id);
        setTab((k) => (k === "chat" ? k : "step"));
      }
    });
    return true;
  };
  const assistant: StepAssistant | undefined = w.readOnly
    ? undefined
    : {
        adding,
        add: addStep,
        ask: (text) => {
          if (chat.phase !== "idle") {
            return false;
          }
          void chat.send(text);
          return true;
        },
        working: <Working chat={chat} />,
        showChat: () => {
          setTab("chat");
          sheet.unfold();
        },
      };

  /** Test and share: in the header, on a phone as icons in the row below it. */
  const testButton = (
    <Button
      variant="secondary"
      size="sm"
      className="max-sm:aspect-square max-sm:px-0 max-sm:coarse:px-0"
      title={t("editor.test")}
      disabled={hasIssues || building || blocked}
      busy={testRun.isPending}
      onClick={() => testRun.mutate()}
    >
      <Play className="size-3.5 max-sm:size-4" />
      <span className="max-sm:sr-only">{t("editor.test")}</span>
    </Button>
  );
  const shareButton = (
    <Button
      size="sm"
      className="max-sm:aspect-square max-sm:px-0 max-sm:coarse:px-0"
      title={t("editor.share")}
      onClick={() => setShareOpen(true)}
    >
      <Share2 className="size-3.5 max-sm:size-4" />
      <span className="max-sm:sr-only">{t("editor.share")}</span>
    </Button>
  );

  /** The open test run's bar: above the main area, or at the top of the run beside the diagram. */
  const runBar = drawerRun ? (
    <div
      className={cn(
        "kb-hide flex h-12 shrink-0 items-center gap-1 px-3",
        // Over the diagram it has a line below; over the run, the run's progress line is the edge.
        !split && view === "flow" && "border-border-soft border-b",
      )}
    >
      {split ? (
        <Chip>{t("run.testChip")}</Chip>
      ) : (
        <fieldset
          aria-label={t("editor.view")}
          className="m-0 flex min-w-0 rounded-full border-0 bg-paper-2 p-0.5"
        >
          {(["flow", "test"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-3 font-medium text-[0.8125rem] transition coarse:h-9",
                view === v ? "bg-card text-ink shadow-soft" : "text-ink-3 hover:text-ink",
              )}
            >
              {v === "flow" ? (
                <Workflow className="size-3.5 max-sm:size-4" />
              ) : (
                <Play className="size-3.5 max-sm:size-4" />
              )}
              {/* A phone has the glyphs alone: the row is narrow. */}
              <span className="max-sm:sr-only">
                {t(v === "flow" ? "editor.flow" : "run.testChip")}
              </span>
              {/* The diagram follows the run: its step in effect is lit there. */}
              {v === "flow" && activeStep && view === "test" ? (
                <span className="size-1.5 animate-pulse rounded-full bg-ember" aria-hidden="true" />
              ) : null}
            </button>
          ))}
        </fieldset>
      )}
      <span className="flex-1" />
      {view === "test" || split ? <LookSwitch look={look} onChange={setLook} /> : null}
      <Button
        variant="ghost"
        size="sm"
        title={t("editor.restart")}
        busy={testRun.isPending}
        disabled={hasIssues}
        onClick={() => testRun.mutate()}
      >
        <RotateCcw className="size-3.5" />
        <span className="max-sm:sr-only">{t("editor.restart")}</span>
      </Button>
      <IconButton
        label={t(runWide ? "editor.runNarrow" : "editor.runWide")}
        onClick={() => {
          setRunWide(!runWide);
          setView("test");
        }}
        className="max-lg:hidden"
      >
        {runWide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </IconButton>
      <IconButton label={t("editor.close")} onClick={closeRun}>
        <X className="size-5" />
      </IconButton>
    </div>
  ) : null;

  /** Flow or result page, where the main area shows one of them. */
  const pageSwitch = (
    <fieldset
      aria-label={t("editor.view")}
      className="m-0 flex min-w-0 rounded-full border-0 bg-paper-2 p-0.5"
    >
      {(["flow", "result"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={(view === "result") === (v === "result")}
          onClick={() => setView(v)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-3 font-medium text-[0.8125rem] transition coarse:h-9",
            (view === "result") === (v === "result")
              ? "bg-card text-ink shadow-soft"
              : "text-ink-3 hover:text-ink",
          )}
        >
          {v === "flow" ? <Workflow className="size-3.5" /> : <Flag className="size-3.5" />}
          {t(v === "flow" ? "editor.flow" : "resultPreview.title")}
        </button>
      ))}
    </fieldset>
  );
  const page = (lead: React.ReactNode, onClose?: () => void) =>
    resultStep ? (
      <ResultPreview
        wizardId={w.id}
        def={def}
        step={resultStep}
        revision={w.revision}
        audience={audience}
        onAudience={setAudience}
        lead={lead}
        onTest={() => testRun.mutate()}
        testBusy={testRun.isPending}
        testDisabled={hasIssues}
        onClose={onClose}
      />
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {readOnlyNote ? (
        <div className="flex shrink-0 items-center gap-3 border-border-soft border-b bg-paper-2 px-4 py-2 text-[0.8125rem] text-ink-2 max-sm:hidden sm:px-6">
          <Lock className="size-4 shrink-0 text-ink-3" />
          <p className="min-w-0 flex-1">{readOnlyNote}</p>
        </div>
      ) : null}
      {failed ? (
        <div className="shrink-0 bg-rose-tint px-4 py-2 text-[0.8125rem] text-rose sm:px-6">
          {failed}
        </div>
      ) : null}
      <header className="flex h-12 shrink-0 items-center gap-1 px-2 coarse:h-14 sm:gap-2 sm:px-4">
        <IconButton label={t("common.back")} onClick={() => navigate("/")}>
          <ArrowLeft className="size-5" />
        </IconButton>
        <button
          type="button"
          onClick={() => select("__wizard")}
          className="min-w-0 truncate rounded-md px-1 py-1 text-left hover:bg-accent sm:px-2"
        >
          <span className="font-display font-semibold text-[1.0625rem] tracking-tight">
            {def.title}
          </span>
        </button>
        <span className="hidden sm:inline-flex">
          {w.published ? (
            <WhereChip
              where={whereItRuns(w, me.data, cloudLinked ? cloud.data : null)}
              me={me.data}
              version={w.publishedVersion}
            />
          ) : (
            <Chip>{t("editor.notPublished")}</Chip>
          )}
        </span>
        {saving ? <Spinner className="size-4 text-ink-4" /> : null}
        <span className="hidden md:inline-flex">
          <LiveChip remote={remote} merged={merged} />
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* With a run open, its bar restarts it: the header keeps no second test button. */}
          {drawerRun ? null : <span className="contents max-sm:hidden">{testButton}</span>}
          {/* The first version goes live by sharing; every later one by its own dialog. */}
          {w.published && w.dirty && !w.readOnly ? (
            <Button variant="secondary" size="sm" onClick={() => setLiveOpen(true)}>
              <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span className="max-sm:hidden">{t("live.open")}</span>
              <span className="sm:hidden">{t("live.openShort")}</span>
            </Button>
          ) : null}
          <span className="contents max-sm:hidden">{shareButton}</span>
          <span className="ml-2 hidden md:inline-flex">
            <CreditsPill me={me.data} />
          </span>
          {/* At the very right: a copy, the package to keep, deleting it. */}
          <WizardMenu
            wizard={{ id: w.id, title: def.title, published: w.published }}
            onDeleted={() => navigate("/")}
          />
        </div>
      </header>

      {/* Where the pane is a sheet: the diagram behind it, and on a phone test and share. A test
          run's bar, or the result page's, takes this row's place. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 px-3 pb-2 lg:hidden",
          (drawerRun || (pageInPlace && view === "result")) && "hidden",
        )}
      >
        <Button variant="secondary" size="sm" aria-expanded={sheet.folded} onClick={sheet.toggle}>
          <Workflow className="size-4" />
          <span className="max-sm:sr-only">{t("editor.flow")}</span>
          {sheet.folded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
        <span className="flex-1" />
        <span className="contents sm:hidden">
          {testButton}
          {shareButton}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row-reverse lg:overflow-hidden">
        <section ref={setMainEl} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {split ? null : runBar}
          {pageInPlace ? (
            <div className="kb-hide flex h-12 shrink-0 items-center gap-1 border-border-soft border-b px-3">
              {pageSwitch}
            </div>
          ) : null}
          <div className="relative flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="relative min-h-0 flex-1">
                {hasIssues && !building ? (
                  <div className="absolute top-3 right-3 left-3 z-10 mx-auto max-w-xl animate-rise rounded-xl bg-card p-4 shadow-elevated ring-1 ring-rose/30">
                    <p className="text-[0.875rem]">{t("editor.issues")}</p>
                    <ul className="mt-2 list-disc pl-5 text-[0.8125rem] text-ink-2">
                      {w.issues.slice(0, 4).map((i, k) => (
                        <li key={k}>{i.message}</li>
                      ))}
                    </ul>
                    {w.readOnly ? null : (
                      <Button
                        size="sm"
                        variant="quiet"
                        className="mt-3"
                        disabled={chat.phase !== "idle"}
                        onClick={fixIssues}
                      >
                        {t("editor.fixWithChat")}
                      </Button>
                    )}
                  </div>
                ) : null}
                {!hasIssues && !building && missing.length ? (
                  <div
                    className={cn(
                      "absolute top-3 right-3 left-3 z-10 mx-auto max-w-xl animate-rise rounded-xl bg-card p-4 shadow-elevated ring-1",
                      blocked ? "ring-rose/30" : "ring-amber/30",
                    )}
                  >
                    <p className="text-[0.875rem]">
                      {t(blocked ? "editor.models.blocking" : "editor.models.optional")}
                    </p>
                    <ul className="mt-2 list-disc pl-5 text-[0.8125rem] text-ink-2">
                      {missing.map((m) => (
                        <li key={m.cls}>
                          <span className="text-ink">{t(`class.${m.cls}` as Key)}</span> (
                          {m.steps.map((s) => `„${s.title}“`).join(", ")}):{" "}
                          <LinkedText text={m.problem} />
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => navigate("/settings/models")}
                      >
                        {t("editor.models.settings")}
                      </Button>
                      {credits === "connect" ? (
                        <p className="text-[0.8125rem] text-ink-3">
                          {t("teaser.models")}{" "}
                          <button
                            type="button"
                            className="font-medium text-ink underline underline-offset-2"
                            onClick={() => navigate("/settings/account")}
                          >
                            {t("teaser.connect")}
                          </button>
                        </p>
                      ) : credits === "use" ? (
                        <p className="text-[0.8125rem] text-ink-3">{t("teaser.modelsLinked")}</p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {/* A test the runtime refused to start says why, where the run would have opened. */}
                {testRun.error && !drawerRun ? (
                  <div
                    role="alert"
                    className="absolute top-3 right-3 left-3 z-20 mx-auto max-w-xl animate-rise rounded-xl bg-card p-4 shadow-elevated ring-1 ring-rose/30"
                  >
                    <p className="font-medium text-[0.875rem]">{t("editor.testFailed")}</p>
                    <p className="mt-1 text-[0.8125rem] text-ink-2">
                      <LinkedText text={testRun.error.message} />
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => navigate("/settings/models")}
                      >
                        {t("editor.models.settings")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => testRun.reset()}>
                        {t("editor.close")}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {insertAt !== null && assistant && !building ? (
                  <div className="absolute top-3 right-3 left-3 z-20 mx-auto max-w-xl animate-rise rounded-xl shadow-elevated">
                    <AddStepPanel
                      place={placeText(def, insertAt)}
                      branchable={insertAt > 0}
                      onAdd={(kind, prompt, when) => {
                        if (!addStep({ at: insertAt, kind, prompt, when })) {
                          return false;
                        }
                        setInsertAt(null);
                        return true;
                      }}
                      onEmpty={(kind) => {
                        const added = withEmptyStep(def, insertAt, kind);
                        save(added.def);
                        setInsertAt(null);
                        select(added.id);
                      }}
                      onCancel={() => setInsertAt(null)}
                    />
                  </div>
                ) : null}
                {building ? (
                  <div className="flex h-full items-center justify-center px-6 text-[0.875rem] text-ink-3">
                    <Working chat={chat} spinner="size-4 text-ember" />
                  </div>
                ) : (
                  <FlowDiagram
                    def={def}
                    selected={selected}
                    onSelect={select}
                    issueSteps={issueSteps}
                    activeStep={drawerRun ? activeStep : null}
                    live={live}
                    fitKey={`${split || pageBeside}:${Boolean(drawerRun)}:${paneMoves}`}
                    pulse={remote?.steps}
                    wizardId={w.id}
                    decisions={shownDecisions}
                    onBranch={(sid) => {
                      select(sid);
                      setBranchFocus((n) => n + 1);
                    }}
                    adding={adding}
                    onInsert={w.readOnly || adding ? undefined : openInsert}
                  />
                )}
              </div>
            </div>
            {/* Beside the diagram where there is room, else over it; hidden, not unmounted, so the
                run keeps its place. */}
            {drawerRun ? (
              <div
                className={cn(
                  split
                    ? "relative shrink-0 animate-slide-in"
                    : "absolute inset-0 z-30 animate-fade-in",
                  !split && view === "flow" && "hidden",
                )}
                // Beside the diagram, as wide as dragged, the diagram keeping its room.
                style={
                  split
                    ? { width: `min(${runPane.width}px, calc(100% - ${RUN_ROOM}px))` }
                    : undefined
                }
              >
                {split ? (
                  // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no element of its own
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t("editor.resize")}
                    aria-valuenow={runPane.width}
                    tabIndex={0}
                    title={t("editor.resize")}
                    onPointerDown={runPane.onPointerDown}
                    onKeyDown={runPane.onKeyDown}
                    onDoubleClick={runPane.reset}
                    className="group -left-5 absolute inset-y-0 z-10 w-5 cursor-col-resize outline-none"
                  >
                    <span className="-translate-y-1/2 absolute top-1/2 left-[7px] h-12 w-1.5 rounded-full bg-ink-4/40 transition group-hover:bg-ember/70 group-focus-visible:bg-ember group-active:h-16 group-active:bg-ember" />
                  </div>
                ) : null}
                {/* Beside the diagram a card like the side panel, mirrored: rounded where it meets the header. */}
                <div
                  className={cn(
                    "flex h-full flex-col",
                    split
                      ? "overflow-hidden rounded-tl-3xl bg-card shadow-[0_0_0_1px_var(--border-soft)]"
                      : "bg-background",
                  )}
                >
                  {split ? runBar : null}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {look === "chat" ? (
                      <ChatBody
                        key={drawerRun}
                        runId={drawerRun}
                        onRestart={() => testRun.mutate()}
                        onView={onRunView}
                      />
                    ) : (
                      <RunnerBody
                        key={drawerRun}
                        runId={drawerRun}
                        compact
                        studio
                        onRestart={() => testRun.mutate()}
                        onView={onRunView}
                      />
                    )}
                  </div>
                </div>
              </div>
            ) : null}
            {pageBeside ? (
              <div
                className="relative shrink-0 animate-slide-in"
                style={{ width: `min(${runPane.width}px, calc(100% - ${RUN_ROOM}px))` }}
              >
                {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no element of its own */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("editor.resize")}
                  aria-valuenow={runPane.width}
                  tabIndex={0}
                  title={t("editor.resize")}
                  onPointerDown={runPane.onPointerDown}
                  onKeyDown={runPane.onKeyDown}
                  onDoubleClick={runPane.reset}
                  className="group -left-5 absolute inset-y-0 z-10 w-5 cursor-col-resize outline-none"
                >
                  <span className="-translate-y-1/2 absolute top-1/2 left-[7px] h-12 w-1.5 rounded-full bg-ink-4/40 transition group-hover:bg-ember/70 group-focus-visible:bg-ember group-active:h-16 group-active:bg-ember" />
                </div>
                <div className="flex h-full flex-col overflow-hidden rounded-tl-3xl bg-card shadow-[0_0_0_1px_var(--border-soft)]">
                  {page(<Chip>{t("resultPreview.title")}</Chip>, () => setPageClosed(true))}
                </div>
              </div>
            ) : null}
          </div>
          {/* The result page in place of the flow, its switch at the top. */}
          {pageInPlace && view === "result" ? (
            <div className="absolute inset-0 z-30 animate-fade-in bg-background">
              {page(pageSwitch)}
            </div>
          ) : null}
          {/* The run's log across the whole width, under the diagram and the run. */}
          {drawerRun ? (
            <RunLog
              view={runView}
              steps={def.steps}
              onSelect={select}
              className="border-border-soft border-t"
            />
          ) : null}
        </section>

        <aside
          ref={sheet.ref}
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && e.propertyName === "margin-left") {
              setPaneMoves((n) => n + 1);
            }
          }}
          className={cn(
            "relative flex h-(--sheet) min-h-0 w-full shrink-0 flex-col rounded-t-3xl bg-card shadow-[0_0_0_1px_var(--border-soft)] lg:h-auto lg:w-(--pane) lg:rounded-tl-none",
            !sheet.dragging &&
              "max-lg:motion-safe:transition-[height] max-lg:motion-safe:duration-200",
            // On a desk it slides out to the left for a test run, its content unchanged, and back.
            "lg:motion-safe:transition-[margin-left,visibility] lg:motion-safe:duration-300 lg:motion-safe:ease-out",
            drawerRun && runWide && "lg:invisible lg:ml-[calc(var(--pane)*-1)]",
            // A test run on a small screen gets all of it: the sheet slides down out of the way,
            // and back up when the flow is shown again.
            drawerRun && view === "test" && "max-lg:h-0! max-lg:overflow-hidden max-lg:shadow-none",
          )}
          style={{ "--pane": `${pane.width}px`, "--sheet": sheet.height } as React.CSSProperties}
        >
          {/* On small screens the pane is a sheet over the bottom: its handle drags its height, a
              tap folds it to its tabs. The handle reaches a little above the sheet for fingers. */}
          {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no element of its own */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("editor.resizeSheet")}
            aria-valuenow={sheet.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            title={t("editor.resizeSheet")}
            onPointerDown={sheet.onPointerDown}
            onKeyDown={sheet.onKeyDown}
            className="group before:-top-4 relative z-10 flex h-7 shrink-0 cursor-row-resize touch-none select-none items-center justify-center outline-none before:absolute before:inset-x-0 before:h-4 lg:hidden"
          >
            <span className="h-1.5 w-10 rounded-full bg-ink-4/40 transition-all group-hover:bg-ember/70 group-focus-visible:bg-ember group-active:w-14 group-active:bg-ember" />
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no element of its own */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("editor.resize")}
            aria-valuenow={pane.width}
            tabIndex={0}
            title={t("editor.resize")}
            onPointerDown={pane.onPointerDown}
            onKeyDown={pane.onKeyDown}
            onDoubleClick={pane.reset}
            className="group -right-5 absolute inset-y-0 z-10 hidden w-5 cursor-col-resize outline-none lg:block"
          >
            {/* The grip sits just outside the pane, beside its edge, clear of its scrollbar. */}
            <span className="-translate-y-1/2 absolute top-1/2 right-[7px] h-12 w-1.5 rounded-full bg-ink-4/40 transition group-hover:bg-ember/70 group-focus-visible:bg-ember group-active:h-16 group-active:bg-ember" />
          </div>
          <nav
            ref={tabsRef}
            className="flex shrink-0 gap-1 overflow-x-auto px-3 [scrollbar-width:none] lg:pt-3"
          >
            {(["chat", "step", "files", "memory", "runs"] as Tab[]).map((k) => (
              <button
                key={k}
                type="button"
                data-active={tab === k || undefined}
                onClick={() => {
                  setTab(k);
                  sheet.unfold();
                }}
                className={cn(
                  "h-9 shrink-0 rounded-full px-4 font-medium text-[0.8125rem] transition",
                  tab === k ? "bg-paper-2 text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {t(TAB_LABEL[k] as "editor.chat")}
                {readOnlyNote && k !== "runs" ? (
                  <Lock className="ml-1.5 inline size-3 align-[-1px] text-ink-3 sm:hidden" />
                ) : null}
              </button>
            ))}
          </nav>
          <div className={cn("min-h-0 flex-1 overflow-y-auto", sheet.folded && "max-lg:hidden")}>
            {tab === "chat" ? (
              <ChatPanel chat={chat} avatar={def.avatar} closed={readOnlyNote ?? undefined} />
            ) : tab === "step" ? (
              <div className="flex h-full min-h-0 flex-col">
                {/* A swipe left or right moves to the next or the previous step. */}
                <div className="min-h-0 flex-1 overflow-y-auto" {...stepSwipe}>
                  <ResultPageOpener.Provider value={openPage}>
                    <Inspector
                      def={def}
                      selected={selected}
                      update={save}
                      onSelect={select}
                      issues={w.issues}
                      mcpServers={w.mcpServers}
                      files={w.files}
                      wizardId={w.id}
                      readOnly={w.readOnly}
                      decisions={shownDecisions}
                      branchFocus={branchFocus}
                      assistant={assistant}
                    />
                  </ResultPageOpener.Provider>
                </div>
                {/* The chat's composer stays at hand while a step is open; its thread is the Chat tab's. */}
                {readOnlyNote ? null : (
                  <div className="shrink-0 px-3 pt-2 pb-3">
                    <ChatPanel compact chat={chat} avatar={def.avatar} foldOn={drawerRun} />
                  </div>
                )}
              </div>
            ) : tab === "files" ? (
              <FilesPanel wizardId={w.id} files={w.files} readOnly={w.readOnly} />
            ) : tab === "memory" ? (
              <MemoryPanel
                wizardId={w.id}
                projectId={w.projectId}
                def={def}
                readOnly={w.readOnly}
              />
            ) : (
              <RunsPanel wizardId={w.id} onOpen={openRun} />
            )}
          </div>
        </aside>
      </div>

      <ShareDialog
        wizard={w}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        publish={
          w.readOnly
            ? undefined
            : {
                run: () => publish.mutateAsync(),
                busy: publish.isPending,
                disabled: hasIssues || building,
                fix: fixIssues,
                goLive: () => {
                  setShareOpen(false);
                  setLiveOpen(true);
                },
              }
        }
      />
      {w.readOnly ? null : (
        <LiveDialog
          wizard={w}
          open={liveOpen}
          onClose={() => setLiveOpen(false)}
          cloud={cloudLinked}
          actions={{
            publish: () => publish.mutateAsync(),
            busy: publish.isPending,
            disabled: hasIssues || building,
            test: () => {
              setLiveOpen(false);
              testRun.mutate();
            },
            openRun: (runId) => {
              setLiveOpen(false);
              openRun(runId);
            },
            fix: fixIssues,
            share: () => {
              setLiveOpen(false);
              setShareOpen(true);
            },
          }}
        />
      )}
    </div>
  );
}
