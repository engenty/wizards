import { type ModelClass, TEXT_CLASSES } from "@engenty/wizards-shared/definition";
import type { MissingModel, RunView } from "@engenty/wizards-shared/run";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Eye,
  FileText,
  Flag,
  Globe,
  History,
  Lock,
  NotebookTabs,
  Pencil,
  Settings,
  Share2,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { eventText, type Key, t } from "../lib/i18n";
import { useMediaQuery } from "../lib/media";
import {
  type PublishResult,
  useCloud,
  useMe,
  useProjects,
  type WizardDetail,
} from "../lib/session";
import { Button, Chip, cn, IconButton, LinkedText, Spinner } from "../ui";
import { CreditsPill } from "./AppFrame";
import { SyncNotice } from "./CloudSync";
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
import { Inspector, StepNav } from "./editor/Inspector";
import { LiveDialog } from "./editor/LiveDialog";
import { MemoryPanel } from "./editor/MemoryPanel";
import { Pills, PreviewPane } from "./editor/PreviewPane";
import type { Audience } from "./editor/ResultPreview";
import { RunLog } from "./editor/RunLog";
import { RunsPanel } from "./editor/RunsPanel";
import { ShareDialog } from "./editor/ShareDialog";
import { ResultPageOpener } from "./editor/share";
import { LiveChip, useLiveDraft } from "./live";
import { pageAddress, pageUrl } from "./project/page-address";
import { WizardMenu } from "./WizardMenu";
import { WhereChip, whereItRuns } from "./where";

/** What the main area shows. The flow has a column of its own where the window is wide. */
type View = "preview" | "flow" | "files" | "memory" | "runs";

/** The model classes an account's credits run: text, images, videos. */
const CREDIT_CLASSES: readonly ModelClass[] = [...TEXT_CLASSES, "image", "video"];

const VIEW_LABEL: Record<View, Key> = {
  preview: "editor.preview",
  flow: "editor.flow",
  files: "editor.files",
  memory: "editor.memory",
  runs: "editor.runs",
};
const VIEW_ICON: Record<View, typeof Eye> = {
  preview: Eye,
  flow: Workflow,
  files: FileText,
  memory: NotebookTabs,
  runs: History,
};

const PANE_KEY = "wizards.editor.pane";
const PANE_DEFAULT = 420;
const PANE_MIN = 340;

/** Room the main area keeps next to the pane. */
const paneMax = () => Math.max(PANE_MIN, window.innerWidth - 560);

/** From this width a column stands beside the preview: the flow or the editor. */
const WIDE = "(min-width: 1440px)";
const COLUMN_WIDTH_KEY = "wizards.editor.columnWidth";
const COLUMN_DEFAULT = 380;
const COLUMN_MIN = 260;
/** Room the preview keeps next to the column. */
const columnMax = () => Math.max(COLUMN_MIN, window.innerWidth - PANE_MIN - 640);
const COLUMN_SHOWN_KEY = "wizards.editor.columnShown";
/** What the column beside the preview shows: the flow, or the editor of what the strip has chosen. */
type Column = "flow" | "edit";
/** The column's switch: the editor named by what it is on, the wizard's settings and result apart. */
type ColumnPick = "settings" | "flow" | "edit" | "result";
const COLUMN_KEY = "wizards.editor.column";
/** Steps a person sees: shown first; the others are edited first where there is no room for both. */
const SHOWN_FIRST = new Set(["page", "review", "result"]);

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
  const [dragging, setDragging] = useState(false);
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
      setDragging(false);
    };
    setDragging(true);
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
  return { width, dragging, onPointerDown, onKeyDown, reset: () => set(initial) };
}

const SHEET_KEY = "wizards.editor.sheet";
/** Percent of the room below the header: open, the sheet takes all of it. */
const SHEET_DEFAULT = 100;
/** The least a sheet being dragged keeps: its handle and a little of the composer. */
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
  /** The sheet's height: folded, its handle and the composer; else up to the whole room. */
  const height = folded && !dragging ? "auto" : `clamp(${SHEET_MIN}px, ${percent}%, 100%)`;
  return { ref, percent, height, folded, dragging, unfold, fold, toggle, onPointerDown, onKeyDown };
}

/** Whether the column beside the preview shows where the window is wide; remembered per browser. */
function useColumnShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(COLUMN_SHOWN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  return [
    shown,
    (next) => {
      setShown(next);
      try {
        localStorage.setItem(COLUMN_SHOWN_KEY, next ? "1" : "0");
      } catch {
        // only lasts this page then
      }
    },
  ];
}

/** What the column beside the preview shows; remembered per browser. */
function useColumn(): [Column, (column: Column) => void] {
  const [column, setColumn] = useState<Column>(() => {
    try {
      return localStorage.getItem(COLUMN_KEY) === "edit" ? "edit" : "flow";
    } catch {
      return "flow";
    }
  });
  return [
    column,
    (next) => {
      setColumn(next);
      try {
        localStorage.setItem(COLUMN_KEY, next);
      } catch {
        // only lasts this page then
      }
    },
  ];
}

/** The editor of the wizard the address names; another wizard gets an editor of its own. */
export function EditorPage() {
  const { id } = useParams();
  return <Editor key={id} />;
}

function Editor() {
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
  const [view, setView] = useState<View>("preview");
  const pane = useDragWidth({
    key: PANE_KEY,
    initial: PANE_DEFAULT,
    min: PANE_MIN,
    max: paneMax,
    dir: 1,
  });
  const columnPane = useDragWidth({
    key: COLUMN_WIDTH_KEY,
    initial: COLUMN_DEFAULT,
    min: COLUMN_MIN,
    max: columnMax,
    dir: -1,
  });
  const wideWindow = useMediaQuery(WIDE);
  const [columnShown, setColumnShown] = useColumnShown();
  /** A column beside the preview holds the flow or the editor, while the window is wide and it is shown. */
  const columnBeside = wideWindow && columnShown;
  const [column, setColumn] = useColumn();
  /** Where there is no column: the main area edits the step chosen instead of showing it. */
  const [editing, setEditing] = useState(false);
  // On a wide window the flow lives in the column, never as a view of the main area.
  const shownView: View = wideWindow && view === "flow" ? "preview" : view;
  const sheet = useSheetHeight();
  // The tab in effect stays in view where the row scrolls (a phone).
  const viewsRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab in effect is what moves into view
  useEffect(() => {
    viewsRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [shownView]);
  /** Where a touch on the step panel began, for a swipe. */
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  /** The test run the preview shows. */
  const [drawerRun, setDrawerRun] = useState<string | null>(null);
  /** The preview shows the open test run, not the step chosen. */
  const [showRun, setShowRun] = useState(false);
  /** Whom the result page is shown as: a visitor, or the wizard's owner. */
  const [audience, setAudience] = useState<Audience>("visitor");
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
      // Kept when the run closes: the step panel shows the last test run's decisions.
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
  // The organization's public page, where the wizard stands on it: one more place it runs.
  const pagesHost = me.data?.tenant.pagesHost ?? null;
  const spacePage = projects.data?.find((p) => p.id === wizard.data?.projectId)?.page;
  const onPage =
    pagesHost && spacePage?.on && wizard.data && spacePage.wizards.includes(wizard.data.id)
      ? spacePage
      : null;
  const cloud = useCloud(id ?? "", Boolean(id) && cloudLinked);
  const blocked = missing.some((m) => m.blocking);
  /** A run opens in the preview; on a phone the sheet folds so the run gets the screen. */
  const openRun = (runId: string) => {
    setDrawerRun(runId);
    setRunView(null);
    setShowRun(true);
    setEditing(false);
    setView("preview");
    sheet.fold();
  };
  const closeRun = () => {
    setDrawerRun(null);
    setRunView(null);
    setShowRun(false);
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
  // A first build covers the preview and the diagram; a step asked for in place is shown there.
  const building = chat.phase !== "idle" && w.blank && !adding;
  const hasIssues = w.issues.length > 0;
  const resultStep = def.steps.find((s) => s.type === "result") ?? null;
  /** The result page in the preview, from the step panel's button. */
  const openPage = resultStep
    ? () => {
        setSelected(resultStep.id);
        setShowRun(false);
        setEditing(false);
        setView("preview");
        sheet.fold();
      }
    : null;
  /** Asks the assistant to mend the draft's issues, in the chat. */
  const fixIssues = () => {
    setShareOpen(false);
    setLiveOpen(false);
    sheet.unfold();
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

  const stepOf = (sid: string | null) => def.steps.find((s) => s.id === sid) ?? null;
  /**
   * A step chosen, the result or the wizard's settings: the preview shows it, the editor edits it,
   * and where there is no column it opens shown or edited by its kind.
   */
  const select = (sid: string | null) => {
    setSelected(sid);
    setShowRun(false);
    const step = stepOf(sid);
    setEditing(!step || !SHOWN_FIRST.has(step.type));
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
        showChat: () => sheet.unfold(),
      };

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

  /** The step's editor: in the column beside the preview, or in the preview's place. */
  const editor = (
    // A swipe left or right moves to the next or the previous step.
    <div className="min-h-0 flex-1 overflow-y-auto" {...stepSwipe}>
      <div className="mx-auto w-full max-w-3xl">
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
            projectId={w.projectId}
            readOnly={w.readOnly}
            decisions={shownDecisions}
            branchFocus={branchFocus}
            assistant={assistant}
          />
        </ResultPageOpener.Provider>
      </div>
    </div>
  );

  /** The steps in a row, under the preview's switches: what the preview and the editor are on. */
  const strip = (
    <StepNav
      def={def}
      selected={showRun && drawerRun ? null : (selected ?? "__wizard")}
      onSelect={select}
      issues={w.issues}
      run={drawerRun ? { shown: showRun, at: activeStep, onShow: () => setShowRun(true) } : null}
    />
  );
  /** Where there is no column: show the step or edit it, at the start of the main area's bar. */
  const showOrEdit = columnBeside ? null : (
    <Pills<"show" | "edit">
      label={t("editor.view")}
      value={editing ? "edit" : "show"}
      onChange={(v) => setEditing(v === "edit")}
      options={[
        { id: "show", label: t("editor.preview") },
        { id: "edit", label: t("editor.edit") },
      ]}
    />
  );

  /**
   * The column's switch: the flow, or the editor — on the wizard's settings, a step, or the
   * result, like the strip's gear, steps and flag.
   */
  const chosen = stepOf(selected);
  const columnPick: ColumnPick =
    column === "flow"
      ? "flow"
      : !chosen
        ? "settings"
        : chosen.type === "result"
          ? "result"
          : "edit";
  const pickColumn = (pick: ColumnPick) => {
    setColumn(pick === "flow" ? "flow" : "edit");
    if (pick === "settings") {
      select("__wizard");
    } else if (pick === "result" && resultStep) {
      select(resultStep.id);
    } else if (pick === "edit" && (!chosen || chosen.type === "result")) {
      const first = def.steps.find((s) => s.type !== "result");
      if (first) {
        select(first.id);
      }
    }
  };

  // The tabs follow the window's width alone: wide, the flow is in the column.
  const views: View[] = wideWindow
    ? ["preview", "files", "memory", "runs"]
    : ["preview", "flow", "files", "memory", "runs"];
  /** The diagram follows a run where it is not in sight: its tab says so. */
  const flowPulse = Boolean(drawerRun && activeStep) && shownView !== "flow";
  const pickView = (v: View) => {
    setView(v);
    sheet.fold();
  };

  /** The flow: in its column beside the preview, or as a view of its own. */
  const flow = (
    <div className="relative h-full min-h-0">
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
          onSelect={(sid) => {
            // Beside the preview a second click on the step chosen opens its editor.
            if (columnBeside && sid && sid === selected) {
              setColumn("edit");
              return;
            }
            select(sid);
          }}
          issueSteps={issueSteps}
          activeStep={drawerRun ? activeStep : null}
          live={live}
          fitKey={`${columnBeside}:${shownView}:${columnBeside ? columnPane.width : 0}`}
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
  );

  /** What stops a test, or would: over the main area, whatever it shows. */
  const notices = (
    <>
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
                {m.steps.map((s) => `„${s.title}“`).join(", ")}): <LinkedText text={m.problem} />
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button size="sm" variant="quiet" onClick={() => navigate("/settings/models")}>
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
            <Button size="sm" variant="quiet" onClick={() => navigate("/settings/models")}>
              {t("editor.models.settings")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => testRun.reset()}>
              {t("editor.close")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ "--pane": `${pane.width}px`, "--sheet": sheet.height } as React.CSSProperties}
    >
      {readOnlyNote ? (
        <div className="flex shrink-0 items-center gap-3 border-border-soft border-b bg-paper-2 px-4 py-2 text-[0.8125rem] text-ink-2 max-sm:hidden sm:px-6">
          <Lock className="size-4 shrink-0 text-ink-3" />
          <p className="min-w-0 flex-1">{readOnlyNote}</p>
        </div>
      ) : null}
      <SyncNotice kind="wizard" item={w.id} />
      {failed ? (
        <div className="shrink-0 bg-rose-tint px-4 py-2 text-[0.8125rem] text-rose sm:px-6">
          {failed}
        </div>
      ) : null}
      <header className="flex h-12 shrink-0 items-center gap-1 px-2 coarse:h-14 sm:gap-2 sm:px-4 lg:h-14 lg:pl-0">
        {/* Above the side panel: the wizard. Above the main area: what it shows. */}
        {/* At least as wide as the side panel, wider where the title needs it and there is room. */}
        <div className="flex min-w-0 items-center gap-1 sm:gap-2 max-lg:flex-1 lg:min-w-(--pane)">
          <IconButton label={t("common.back")} onClick={() => navigate("/")}>
            <ArrowLeft className="size-5" />
          </IconButton>
          <button
            type="button"
            onClick={() => {
              select("__wizard");
              setColumn("edit");
              setView("preview");
            }}
            className="min-w-0 truncate rounded-md px-1 py-1 text-left hover:bg-accent sm:px-2"
          >
            <span className="font-display font-semibold text-[1.0625rem] tracking-tight">
              {def.title}
            </span>
          </button>
          {saving ? <Spinner className="size-4 shrink-0 text-ink-4" /> : null}
        </div>
        <nav
          aria-label={t("editor.view")}
          className="ml-3 flex shrink-0 items-center gap-0.5 rounded-full bg-paper-2 p-0.5 max-lg:hidden"
        >
          {views.map((v) => {
            const Icon = VIEW_ICON[v];
            const on = shownView === v;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                title={t(VIEW_LABEL[v])}
                onClick={() => pickView(v)}
                className={cn(
                  "relative inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 font-medium text-[0.8125rem] transition",
                  on ? "bg-card text-ink shadow-soft" : "text-ink-3 hover:text-ink",
                )}
              >
                <Icon className="size-4" />
                <span className={cn(!on && "max-xl:sr-only")}>{t(VIEW_LABEL[v])}</span>
                {v === "flow" && flowPulse ? (
                  <span
                    className="size-1.5 animate-pulse rounded-full bg-ember"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Where it runs and in which version, beside sharing it. */}
          <span className="hidden shrink-0 xl:inline-flex">
            <LiveChip remote={remote} merged={merged} />
          </span>
          <span className="hidden shrink-0 sm:inline-flex">
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
          {onPage && pagesHost && w.published ? (
            <a
              href={pageUrl(pagesHost, onPage.slug, me.data?.manageUrl ?? null)}
              target="_blank"
              rel="noreferrer"
              title={t("live.pageRow")}
              className="hidden shrink-0 lg:inline-flex"
            >
              <Chip tone="live" icon={<Globe className="size-3.5" />}>
                {pageAddress(pagesHost, onPage.slug)}
              </Chip>
            </a>
          ) : null}
          {/* The first version goes live by sharing; every later one by its own dialog. */}
          {w.published && w.dirty && !w.readOnly ? (
            <Button variant="secondary" size="sm" onClick={() => setLiveOpen(true)}>
              <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span className="max-sm:hidden">{t("live.open")}</span>
              <span className="sm:hidden">{t("live.openShort")}</span>
            </Button>
          ) : null}
          {shareButton}
          <span className="contents max-md:hidden">
            <CreditsPill me={me.data} />
          </span>
          {/* At the very right: a copy, the package to keep, deleting it. */}
          <WizardMenu
            wizard={{ id: w.id, title: def.title, published: w.published }}
            onDeleted={() => navigate("/")}
          />
        </div>
      </header>

      {/* Where the side panel is a sheet: what the main area shows. */}
      <nav
        ref={viewsRef}
        aria-label={t("editor.view")}
        className="flex shrink-0 items-center gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none] lg:hidden"
      >
        {views.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={shownView === v}
            data-active={shownView === v || undefined}
            onClick={() => pickView(v)}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 font-medium text-[0.8125rem] transition",
              shownView === v ? "bg-paper-2 text-ink" : "text-ink-3 hover:text-ink",
            )}
          >
            {t(VIEW_LABEL[v])}
            {v === "flow" && flowPulse ? (
              <span className="size-1.5 animate-pulse rounded-full bg-ember" aria-hidden="true" />
            ) : null}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:gap-3 lg:overflow-hidden lg:pr-3 lg:pb-3">
        <aside
          ref={sheet.ref}
          className={cn(
            "relative flex h-(--sheet) min-h-0 w-full shrink-0 flex-col rounded-t-3xl bg-card shadow-[0_0_0_1px_var(--border-soft)] max-lg:order-last lg:h-auto lg:w-(--pane) lg:rounded-t-none lg:rounded-r-3xl",
            !sheet.dragging &&
              "max-lg:motion-safe:transition-[height] max-lg:motion-safe:duration-200",
          )}
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
            className="group -right-3 absolute inset-y-0 z-10 hidden w-3 cursor-col-resize outline-none lg:block"
          >
            {/* The grip is centred in the gap beside the pane's edge, clear of its scrollbar. */}
            <span className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 h-8 w-1 rounded-full bg-ink-4/20 transition group-hover:bg-ember/60 group-focus-visible:bg-ember group-active:h-12 group-active:bg-ember" />
          </div>
          {/* Folded, the sheet keeps the composer at hand; its thread opens with the sheet. */}
          {sheet.folded && !readOnlyNote ? (
            <div className="shrink-0 px-3 pb-3 lg:hidden">
              <ChatPanel compact chat={chat} avatar={def.avatar} costume={def.costume} />
            </div>
          ) : null}
          <div className={cn("min-h-0 flex-1 overflow-y-auto", sheet.folded && "max-lg:hidden")}>
            <ChatPanel
              chat={chat}
              avatar={def.avatar}
              costume={def.costume}
              closed={readOnlyNote ?? undefined}
            />
          </div>
        </aside>

        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card lg:rounded-3xl lg:shadow-[0_0_0_1px_var(--border-soft)]">
          {notices}
          {/* Editing in its place, the preview stays: its picks and an open run keep their state. */}
          {shownView === "preview" && editing && !columnBeside ? (
            <div key="edit" className="flex min-h-0 flex-1 flex-col animate-fade-in">
              {/* The preview's bar, with only the switch back while editing. */}
              <div className="@container flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-border-soft border-b px-3 [scrollbar-width:none]">
                {showOrEdit}
              </div>
              {strip}
              {editor}
            </div>
          ) : null}
          {shownView === "preview" ? (
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                editing && !columnBeside ? "hidden" : "animate-fade-in",
              )}
            >
              <PreviewPane
                lead={showOrEdit}
                // The flow beside the preview shows the steps: no strip then, and the run is a button away.
                strip={columnBeside && column === "flow" ? null : strip}
                onEdit={columnBeside && column === "flow" ? () => setColumn("edit") : undefined}
                onShowRun={
                  columnBeside && column === "flow" && drawerRun && !showRun && stepOf(selected)
                    ? () => setShowRun(true)
                    : undefined
                }
                wizard={w}
                runId={drawerRun}
                runView={runView}
                onView={onRunView}
                stepId={showRun && drawerRun ? null : (stepOf(selected)?.id ?? null)}
                audience={audience}
                onAudience={setAudience}
                test={{
                  start: () => testRun.mutate(),
                  busy: testRun.isPending,
                  disabled: hasIssues || building || blocked,
                }}
                column={wideWindow ? columnShown : null}
                onColumn={setColumnShown}
                onClose={closeRun}
                building={building ? <Working chat={chat} spinner="size-4 text-ember" /> : null}
                log={
                  <RunLog
                    view={runView}
                    steps={def.steps}
                    onSelect={select}
                    className="border-border-soft border-t"
                  />
                }
              />
            </div>
          ) : shownView === "flow" ? (
            flow
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl py-2">
                {shownView === "files" ? (
                  <FilesPanel wizardId={w.id} files={w.files} readOnly={w.readOnly} />
                ) : shownView === "memory" ? (
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
            </div>
          )}
        </section>

        {/* On a wide window the column is always there: shown and hidden, it slides. */}
        {wideWindow ? (
          <section
            aria-label={t("editor.flow")}
            aria-hidden={!columnBeside}
            inert={!columnBeside}
            className={cn(
              "relative min-h-0 shrink-0",
              !columnPane.dragging &&
                "motion-safe:transition-[width,margin,opacity] motion-safe:duration-300 motion-safe:ease-out",
              // Hidden, it gives back its width and the gap before it.
              !columnBeside && "-ml-3 opacity-0",
            )}
            style={{ width: columnBeside ? columnPane.width : 0 }}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no element of its own */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("editor.resize")}
              aria-valuenow={columnPane.width}
              tabIndex={0}
              title={t("editor.resize")}
              onPointerDown={columnPane.onPointerDown}
              onKeyDown={columnPane.onKeyDown}
              onDoubleClick={columnPane.reset}
              className="group -left-3 absolute inset-y-0 z-10 w-3 cursor-col-resize outline-none"
            >
              <span className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 h-8 w-1 rounded-full bg-ink-4/20 transition group-hover:bg-ember/60 group-focus-visible:bg-ember group-active:h-12 group-active:bg-ember" />
            </div>
            {/* The card keeps its width while the column slides: nothing inside reflows. */}
            <div className="h-full overflow-hidden rounded-3xl bg-card shadow-[0_0_0_1px_var(--border-soft)]">
              <div className="flex h-full flex-col" style={{ width: columnPane.width }}>
                <div className="@container flex h-12 shrink-0 items-center gap-2 border-border-soft border-b px-3">
                  <Pills<ColumnPick>
                    named
                    label={t("editor.view")}
                    value={columnPick}
                    onChange={pickColumn}
                    options={[
                      {
                        id: "settings",
                        label: t("editor.profile"),
                        icon: <Settings className="size-3.5" />,
                      },
                      {
                        id: "flow",
                        label: t("editor.flow"),
                        icon: <Workflow className="size-3.5" />,
                      },
                      {
                        id: "edit",
                        label: t("editor.edit"),
                        icon: <Pencil className="size-3.5" />,
                      },
                      ...(resultStep
                        ? [
                            {
                              id: "result" as const,
                              label: t("editor.result"),
                              icon: <Flag className="size-3.5" />,
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-3xl">
                  <div key={column} className="flex min-h-0 flex-1 flex-col animate-fade-in">
                    {/* Hidden, the column holds no editor: the main area has it then. */}
                    {column === "flow" ? flow : columnBeside ? editor : null}
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}
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
