import type { KnowledgeItem } from "@engenty/wizards-shared/knowledge";
import {
  Inbox,
  Layers,
  LayoutGrid,
  type LucideIcon,
  Puzzle,
  ScrollText,
  Search,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useFeature } from "../lib/features";
import { t } from "../lib/i18n";
import { useCurrentSpace, useIsAdmin, useMe } from "../lib/session";
import { PluginFrame, SpacePartFrame, useStudioPlugins } from "../plugins/host";
import { cn, Empty } from "../ui";
import { scrollRoot, useCrumbs } from "./AppFrame";
import { useAssistantPage } from "./assistant/page";
import {
  BackRow,
  LevelHead,
  LevelList,
  MenuGroup,
  MenuRow,
  SettingsMenuContext,
  SubMenu,
  stepClass,
  useNarrow,
  useStepDirection,
} from "./settings-menu";
import {
  CATEGORY_ICON,
  CategoryView,
  NewCategoryDialog,
  useValue,
  ValueView,
} from "./space/Categories";
import { ClientSpaces, OpenToClients } from "./space/ClientSpaces";
import { DateienMenu, DateienPage } from "./space/Dateien";
import { FileView } from "./space/Documents";
import {
  CategoryItems,
  ItemRow,
  KnowledgeOverview,
  NewItemDialog,
  useKnowledge,
} from "./space/Knowledge";
import { CategoryHome, CategoryTree, KnowledgeTabs, ValueHome } from "./space/KnowledgeCategories";
import { KnowledgeFolder, KnowledgeHome, PageContents } from "./space/KnowledgeHome";
import {
  ancestorsOf,
  folderMarks,
  isFolder,
  KnowledgeTree,
  MoveDialog,
  useMoveItem,
} from "./space/KnowledgeTree";
import { PageEditor } from "./space/PageEditor";
import { PublicPage } from "./space/PublicPage";
import { NO_FILTER, Results, type ResultsFilter, useResults } from "./space/Results";
import { Anchor, Section } from "./space/Section";
import { MODE_ICON, SkillsOverview, useSkills } from "./space/Skills";
import { DATA_ICON, DataOverview, dataGroups, useSpaceData } from "./space/SpaceData";
import { SpaceOverview } from "./space/SpaceOverview";
import { SpaceSettings } from "./space/SpaceSettings";
import {
  SourceDialog,
  type SourceKind,
  SourcesStatus,
  SourceView,
  useSources,
} from "./space/sources";
import { TableEditor } from "./space/TableEditor";
import {
  groupOfSection,
  isSpaceGroup,
  type SpaceGroupId,
  type SpaceSectionGroup,
  spaceGroups,
  spaceSections,
  withParts,
} from "./space-sections";

/**
 * The section in view: the last whose top passed the upper third of the page's scroll
 * container; at its end the last one, which may be too short to get there.
 */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function useSectionInView(ids: string[]): string | undefined {
  const key = ids.join(" ");
  const [current, setCurrent] = useState<string | undefined>(ids[0]);
  useEffect(() => {
    const list = key.split(" ");
    let frame = 0;
    const update = () => {
      frame = 0;
      const root = scrollRoot();
      const atEnd =
        root.scrollTop > 0 && root.clientHeight + root.scrollTop >= root.scrollHeight - 4;
      const top = root === document.documentElement ? 0 : root.getBoundingClientRect().top;
      const line = top + Math.max(120, root.clientHeight / 3);
      let found = list[0];
      for (const id of list) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) {
          found = id;
        }
      }
      setCurrent(atEnd ? list.at(-1) : found);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    // The page scrolls inside the frame: its scroll does not bubble, but it can be caught.
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [key]);
  return current;
}

/** The height of the page's scroll container: the menu beside the page scrolls within it. */
function useScrollRootHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const root = scrollRoot();
    const measure = () => setHeight(root.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return height;
}

function scrollToSection(id: string, smooth: boolean) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document
    .getElementById(id)
    ?.scrollIntoView({ block: "start", behavior: smooth && !reduced ? "smooth" : "auto" });
}

/** The rows of a part's sections: its own, then each plugin's under the plugin's name. */
function SectionRows({
  groups,
  current,
  onPick,
}: {
  groups: SpaceSectionGroup[];
  current: string | undefined;
  onPick: (id: string) => void;
}) {
  return groups.map((group) => {
    const rows = group.sections.map((s) => (
      <MenuRow
        key={s.id}
        icon={s.icon ?? Puzzle}
        label={s.label}
        selected={s.id === current}
        onPick={() => onPick(s.id)}
      />
    ));
    return group.label ? (
      <MenuGroup key={group.plugin} label={group.label}>
        {rows}
      </MenuGroup>
    ) : (
      <ul key={group.plugin ?? "own"} className="flex flex-col gap-0.5">
        {rows}
      </ul>
    );
  });
}

// The skill editor brings CodeMirror's pieces with it: loaded when a skill opens.
const SkillEditor = lazy(() =>
  import("./space/SkillEditor").then((m) => ({ default: m.SkillEditor })),
);

/**
 * The space at /space/<part>: what all its wizards share, in five parts — Info, Brand, Knowledge,
 * Data and Public page — and Results; Skills at /skills (`place`). The left container shows one
 * level at a time, as the settings do: the parts, or the menu of the part that is open, which jumps to its sections and marks the one in
 * view (Results: picks a wizard). On a phone the parts, a part's menu and the page take
 * turns. Plugins add sections to a part, each plugin's under its name, and parts of their own.
 */
export function SpacePage({ place }: { place?: "skills" }) {
  const { group: param } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { hash } = location;
  const { space, loading } = useCurrentSpace();
  const plugins = useStudioPlugins();
  const narrow = useNarrow();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  // Back up to the parts on a wide page, while the part's page stays; another part opens its
  // own menu again.
  const [upAt, setUpAt] = useState<string | null>(null);
  // Skills have their own address; `/space/skills` leads there.
  const group: SpaceGroupId | undefined =
    place ?? (isSpaceGroup(param) && param !== "skills" ? param : undefined);
  // A plugin's part: it draws itself, and says its menu.
  const part = group ? undefined : plugins.spaceParts.find((p) => p.id === param);
  const open = group ?? part?.id;
  // The folder in the top bar opens the space at its parts, with the first one beside them;
  // picking a part opens its menu.
  const atParts = (location.state as { parts?: boolean } | null)?.parts === true;
  // The public page waits behind its switch.
  const pagesOn = useFeature("pages");
  // Skills wait behind theirs.
  const skillsOn = useFeature("skills");
  // Client spaces wait behind theirs, and are the admins'.
  const admin = useIsAdmin();
  const clientsOn = useFeature("clientSpaces") && admin;
  // Wissen as a knowledge base waits behind its switch.
  const treeOn = useFeature("knowledgeTree");
  // Dateien waits behind its switch, and mounts a folder of this computer (a local install's) or
  // what a plugin's kind brings (a bucket, a drive).
  const local = useMe().data?.mode === "local";
  const filesOn = useFeature("dateien") && (local || plugins.mountKinds.length > 0);
  const groups = spaceGroups().filter(
    (g) =>
      (pagesOn || g.id !== "page") &&
      (clientsOn || g.id !== "clients") &&
      (filesOn || g.id !== "files"),
  );
  const parts = withParts(groups, plugins).map((g) => ({ ...g, to: `/space/${g.id}` }));
  // The overview at `/space` is the head's own link, not a row; a phone opens it a step deeper.
  const entries = parts;
  // Results have a place of their own in the app bar: no part among the others, no way up.
  const resultsEntry = {
    id: "results",
    label: t("space.results"),
    icon: Inbox,
    to: "/space/results",
  };
  // So have Skills, at their own address: a menu of their own, but no way up to the parts.
  const skillsEntry = { id: "skills", label: t("space.skills"), icon: ScrollText, to: "/skills" };
  // Places of their own in the app bar, not parts of the sources.
  const own = group === "results" || group === "skills";
  const entry =
    group === "results"
      ? resultsEntry
      : group === "skills"
        ? skillsEntry
        : entries.find((e) => e.id === open);
  const show = params.get("show");
  // The search over the open part's menu, and ⌘F / Ctrl+F to it.
  const [menuQuery, setMenuQuery] = useState("");
  const menuSearch = useRef<HTMLInputElement>(null);
  const menuFilter = menuQuery.trim().toLowerCase();
  const menu = useMemo(
    () => ({ slot, narrow, setDetail, filter: menuFilter }),
    [slot, narrow, menuFilter],
  );
  const title = space ? space.brand.name?.trim() || space.name : t("nav.space");

  // Typography waits behind its switch.
  const off = useFeature("typography") ? [] : ["typography"];
  const partMenu = part ? (plugins.spaceMenus[part.id] ?? []) : [];
  const sections = part
    ? [{ plugin: null, label: null, sections: partMenu }]
    : group && group !== "results"
      ? spaceSections(group, plugins, off)
      : [];
  const added = group ? spaceSections(group, plugins).filter((g) => g.plugin) : [];
  const anchors = [...sections, ...(group === "results" ? added : [])].flatMap((g) =>
    g.sections.map((s) => s.id),
  );
  const inView = useSectionInView(anchors);
  // Results: of one wizard (`?show=<id>`), or of all.
  const wizardId = group === "results" && show && show !== "all" ? show : null;
  const [filter, setFilter] = useState<ResultsFilter>(NO_FILTER);
  const results = useResults(group === "results" ? space?.id : undefined, wizardId, filter);
  const wizardTitle = results.data?.wizards.find((w) => w.id === wizardId)?.title;
  // Data: a table (`?show=t:<id>`) or a page (`p:<id>`), or all of them. Knowledge: also a file
  // (`f:`), a category (`c:`), one of its values (`v:`) or a plugin's section (`s:`), which in
  // Knowledge is a page of its own; a plain `show` is a section's anchor.
  // A file found by a search opens where the hit stands: `f:<id>#<page>`.
  const [shown, at] = (show ?? "").split("#");
  const picked =
    group === "data" && shown && shown !== "all"
      ? shown
      : group === "knowledge" && shown && /^[ptfcvsq]:/.test(shown)
        ? shown
        : null;
  const pickedSection = picked?.startsWith("s:")
    ? plugins.spaceSections.find((x) => x.id === picked.slice(2))
    : undefined;
  // Knowledge: a page, a table or a file, opened.
  const item = group === "knowledge" && picked && /^[ptf]:/.test(picked) ? picked : null;
  // Skills: one opened (`?show=k:<id>`), or all of them.
  const skillPick = group === "skills" && show?.startsWith("k:") ? show : null;
  const skills = useSkills(group === "skills" && skillsOn ? space?.id : undefined);
  const spaceData = useSpaceData(group === "data" ? space?.id : undefined);
  const knowledge = useKnowledge(group === "knowledge" ? space?.id : undefined);
  // Its sources, behind the same switch: each fills a folder of its own.
  const sources = useSources(group === "knowledge" && treeOn ? space?.id : undefined);
  const [adding, setAdding] = useState<{ kind: SourceKind; parentId: string | null } | null>(null);
  folderMarks.clear();
  for (const s of sources.sources) {
    if (s.folderId) {
      // A plugin's icon draws as lucide's do: it takes `className`.
      folderMarks.set(s.folderId, sources.iconOf(s) as LucideIcon);
    }
  }
  const pickedValue = useValue(picked?.startsWith("v:") ? picked.slice(2) : "");
  // Knowledge as a tree: the item open, the page opened to write (blank, it would be a folder),
  // what is being moved and where a new folder goes.
  const pickedItem = knowledge.data?.items.find((i) => i.key === item);
  const [writing, setWriting] = useState<string | null>(null);
  const [moving, setMoving] = useState<KnowledgeItem | null>(null);
  const [folderIn, setFolderIn] = useState<string | null | undefined>(undefined);
  const moveItem = useMoveItem(space?.id);
  const pickedCategory = knowledge.data?.categories.find(
    (c) => c.id === (picked?.startsWith("c:") ? picked.slice(2) : pickedValue.data?.category.id),
  );
  // The tab of Wissen's menu: Ordner, or Kategorien; it follows what is opened.
  const [knowTab, setKnowTab] = useState<"folders" | "categories">("folders");
  const [newCategory, setNewCategory] = useState(false);
  useEffect(() => {
    if (picked && /^[cv]:/.test(picked)) {
      setKnowTab("categories");
    } else if (picked && /^[ptf]:/.test(picked)) {
      setKnowTab("folders");
    }
  }, [picked]);
  // A phone: 0 the parts, 1 the part's menu, 2 the page.
  // Results have no menu: the page at once, the wizard picked above the list.
  // A part whose menu would only jump to its headings keeps the parts beside its page, as
  // Fähigkeiten does. Knowledge and Data slide to their menu where it lists something: categories,
  // tables and pages, a plugin's sections. A plugin's part says its own menu.
  const listed =
    added.length > 0 ||
    group === "files" ||
    (group === "knowledge" &&
      Boolean(knowledge.data?.categories.length || (treeOn && knowledge.data?.items.length))) ||
    (group === "data" &&
      Boolean(spaceData.data && dataGroups(spaceData.data).some((g) => g.items.length)));
  const listOnly =
    Boolean(group) &&
    !own &&
    !((group === "data" || group === "knowledge" || group === "files") && listed);
  const phone =
    group === "results" ? 2 : !open ? (show === "overview" ? 2 : 0) : show || listOnly ? 2 : 1;
  const level = own
    ? 1
    : narrow
      ? Math.min(phone, 1)
      : open && !listOnly && upAt !== open && !atParts
        ? 1
        : 0;
  const levelStep = useStepDirection(level);
  const pageStep = useStepDirection(phone);
  // Another part opens its own menu again (going up from one part does not stay for the next),
  // unfiltered; ⌘F / Ctrl+F goes to the search while a menu is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another part is what resets them.
  useEffect(() => {
    setUpAt(null);
    setMenuQuery("");
  }, [open]);
  useEffect(() => {
    if (narrow || level !== 1) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && menuSearch.current) {
        e.preventDefault();
        menuSearch.current.focus();
        menuSearch.current.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, level]);
  const pickedTitle =
    group === "skills"
      ? skills.data?.skills.find((k) => `k:${k.id}` === skillPick)?.name
      : group === "knowledge"
        ? pickedSection
          ? pickedSection.label()
          : picked?.startsWith("v:")
            ? pickedValue.data && `${pickedValue.data.category.name}: ${pickedValue.data.value}`
            : picked?.startsWith("c:")
              ? pickedCategory?.name
              : knowledge.data?.items.find((item) => item.key === picked)?.title
        : spaceData.data
          ? dataGroups(spaceData.data)
              .flatMap((g) => g.items)
              .find((item) => item.key === picked)?.title
          : undefined;

  useCrumbs([
    ...(own ? [] : [{ label: t("nav.sources"), to: "/space" }]),
    ...(open ? [] : [{ label: t("space.overview") }]),
    ...(entry ? [{ label: entry.label, to: entry.to }] : []),
    // Knowledge: the folders the open item sits in.
    ...(treeOn && pickedItem && knowledge.data
      ? ancestorsOf(knowledge.data.items, pickedItem).map((a) => ({
          label: a.title,
          to: `/space/knowledge?show=${a.key}`,
        }))
      : []),
    ...(entry && (detail ?? wizardTitle ?? pickedTitle)
      ? [{ label: (detail ?? wizardTitle ?? pickedTitle) as string }]
      : []),
  ]);

  const openKind: Record<string, string> = {
    p: "page",
    t: "table",
    f: "file",
    c: "category",
    v: "category value",
    s: "plugin section",
  };
  useAssistantPage({
    // Full-height tables: the assistant starts small here.
    ...(group === "data" || group === "results" ? { compact: true } : {}),
    ...(group === "data"
      ? {
          suggestions: [
            { label: t("assistant.suggest.dataWhat") },
            { label: t("assistant.suggest.dataWho") },
            { label: t("assistant.suggest.dataEdit") },
          ],
        }
      : group === "results"
        ? {
            suggestions: [
              { label: t("assistant.suggest.resultsFailed") },
              { label: t("assistant.suggest.resultsCost") },
              { label: t("assistant.suggest.resultsShare") },
            ],
          }
        : {}),
    ...(picked && pickedTitle
      ? { open: { kind: openKind[picked[0]] ?? "item", id: picked.slice(2), label: pickedTitle } }
      : wizardId && wizardTitle
        ? { open: { kind: "wizard", id: wizardId, label: wizardTitle } }
        : {}),
  });

  // A section named in the address (`#logos`, or `?show=logos` on a phone) is scrolled to once
  // it is drawn: a plugin's comes after the space's own. A jump from the menu scrolls by itself.
  const target =
    group === "results" || group === "data" || picked ? hash.slice(1) : show || hash.slice(1);
  const scrolled = useRef("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn sections arrive with the space and the plugins.
  useEffect(() => {
    const key = `${open}#${target}`;
    if (target && scrolled.current !== key && document.getElementById(target)) {
      scrolled.current = key;
      requestAnimationFrame(() => scrollToSection(target, false));
    }
  }, [open, target, space?.id, plugins.spaceSections, partMenu.length]);

  // What is picked in the menu of Knowledge or Data takes the page's place: it starts at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pick is what scrolls up.
  useEffect(() => {
    if (!narrow && (open === "knowledge" || open === "data" || open === "skills")) {
      scrollRoot().scrollTo({ top: 0 });
    }
  }, [narrow, open, picked, skillPick]);
  const rootHeight = useScrollRootHeight();

  if (param === "skills") {
    return <Navigate to={{ pathname: "/skills", search: location.search, hash }} replace />;
  }

  if (!open) {
    // The space was one page: `/space#documents` opens the part the section is in now.
    const id = hash.slice(1);
    const of = id ? groupOfSection(id, plugins) : null;
    // A plugin's section of Knowledge is a page of its own.
    if (of === "knowledge" && plugins.spaceSections.some((x) => x.id === id)) {
      return <Navigate to={`/space/knowledge?show=s:${id}`} replace />;
    }
    if (of) {
      return (
        <Navigate
          to={narrow ? `/space/${of}?show=${id}` : { pathname: `/space/${of}`, hash: id }}
          replace
        />
      );
    }
    // A plugin's part, or a plugin's section: known once the plugins are in.
    if ((id || param) && plugins.status !== "ready") {
      return null;
    }
    // An address that names no part leads to the overview.
    if (param !== undefined) {
      return <Navigate to="/space" replace />;
    }
  }

  // Logos, colours, type and assets were in Info before they had a part of their own.
  const moved = group === "info" ? (show ?? hash.slice(1)) : "";
  if (moved && groupOfSection(moved, plugins) === "brand") {
    return (
      <Navigate
        to={narrow ? `/space/brand?show=${moved}` : { pathname: "/space/brand", hash: moved }}
        replace
      />
    );
  }

  if (group === "skills" && !skillsOn) {
    return <Navigate to="/" replace />;
  }

  if (group === "knowledge" && !show && plugins.spaceSections.some((x) => x.id === hash.slice(1))) {
    return <Navigate to={`/space/knowledge?show=s:${hash.slice(1)}`} replace />;
  }

  const jump = (id: string) => {
    if (narrow) {
      navigate({ search: `?show=${id}` });
      return;
    }
    scrolled.current = `${open}#${id}`;
    scrollToSection(id, true);
    navigate({ search: "", hash: id }, { replace: true });
  };
  // Results and Data pick what the page shows: on a phone a step deeper, beside the menu in place.
  const pick = (id: string) =>
    narrow
      ? setParams({ show: id })
      : setParams(id === "all" ? {} : { show: id }, { replace: true });
  const pluginSections = (list: SpaceSectionGroup[]) =>
    list
      .flatMap((g) => g.sections)
      .map((s) => plugins.spaceSections.find((x) => x.id === s.id))
      .filter((s) => s !== undefined)
      .map((section) => (
        <Anchor key={section.serial} id={section.id}>
          <Section title={section.label()} hint={section.hint?.()} plain>
            <PluginFrame of={section}>
              <section.component />
            </PluginFrame>
          </Section>
        </Anchor>
      ));
  // What the plugins' sections are busy with, each drawn by the section's own `status`.
  const pluginStatus = (list: SpaceSectionGroup[]) =>
    list
      .flatMap((g) => g.sections)
      .map((s) => plugins.spaceSections.find((x) => x.id === s.id))
      .map((section) =>
        section?.status ? (
          <PluginFrame key={section.serial} of={section}>
            <section.status />
          </PluginFrame>
        ) : null,
      );
  // On a phone the menu marks nothing: a row opens the page.
  const marked = narrow ? undefined : inView;

  // The area's menu, at the page's left.
  const menuBody = (
    <>
      <LevelHead
        title={title}
        open={level === 1 ? (entry ?? null) : null}
        onBack={own ? undefined : () => (narrow ? navigate("/space") : setUpAt(open ?? null))}
        // The page's own name in the bar, and the way back to the wizards.
        root={{
          icon: Layers,
          label: t("nav.sources"),
          onOpen: () => navigate(narrow ? "/space?show=overview" : "/space"),
          current: !open,
        }}
      />
      {narrow || own ? (
        // A phone, and the places of their own, take the levels in turns.
        <div key={level} className={cn(stepClass(levelStep))}>
          {level === 0 ? (
            <LevelList entries={entries} current={undefined} onPick={() => setUpAt(null)} />
          ) : (
            <div ref={setSlot} />
          )}
        </div>
      ) : (
        <>
          {/* One list: the open part's row folds into the head above, the others stay and move
              up; below them a line, the search and the part's own menu come in. */}
          <LevelList
            entries={entries}
            current={level === 0 ? entry : undefined}
            hide={level === 1 ? entry?.id : undefined}
            onPick={() => {
              setUpAt(null);
              // Picked again: the part's page from its top.
              if (listOnly && entry) {
                navigate(entry.to);
                scrollRoot().scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
          />
          {level === 1 ? (
            <div key={open} className="fade-in-0 slide-in-from-top-1 animate-in duration-200">
              <div className="mx-2 my-3 h-px bg-border-soft" aria-hidden />
              <div className="relative mb-2">
                <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-ink-4" />
                <input
                  ref={menuSearch}
                  type="search"
                  value={menuQuery}
                  onChange={(e) => setMenuQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setMenuQuery("")}
                  aria-label={t("space.menuSearch")}
                  placeholder={t("space.menuSearch")}
                  className="h-8 w-full rounded-lg border border-input bg-card pr-14 pl-9 text-[0.8125rem] text-ink outline-none transition placeholder:text-ink-4 focus:border-focus focus:ring-4 focus:ring-focus-glow"
                />
                <kbd className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2 rounded border border-border-soft px-1 font-sans text-[0.6875rem] text-ink-4">
                  {IS_MAC ? "⌘F" : "Ctrl F"}
                </kbd>
              </div>
              <div ref={setSlot} />
            </div>
          ) : null}
        </>
      )}
    </>
  );
  return (
    <SettingsMenuContext.Provider value={menu}>
      <div className="animate-rise">
        <div
          className={cn(
            "grid gap-6",
            group !== "results" &&
              "md:grid-cols-[10.5rem_minmax(0,1fr)] md:gap-5 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10",
          )}
        >
          {group === "results" ? null : (
            <aside
              className={cn(
                "menu-scroll min-w-0 md:sticky md:top-6 md:self-start md:overflow-y-auto md:overscroll-contain",
                narrow && phone === 2 && "hidden",
                narrow && pageStep === "back" && stepClass("back"),
              )}
              // A menu longer than the page's frame scrolls on its own, beside the page. Like the
              // page it runs under Goose's docked card and keeps the card's room below its last row.
              style={
                !narrow && rootHeight
                  ? { maxHeight: rootHeight - 48, paddingBottom: "var(--assistant-dock, 0px)" }
                  : undefined
              }
            >
              {menuBody}
            </aside>
          )}
          {open ? (
            <div
              className={cn(
                "min-w-0",
                narrow && phone < 2 && "hidden",
                narrow && pageStep === "deeper" && stepClass("deeper"),
              )}
            >
              {narrow && group !== "results" ? (
                <div className="mb-3">
                  <BackRow
                    label={entry?.label ?? title}
                    onBack={() => navigate(entry?.to ?? `/space/${open}`)}
                  />
                </div>
              ) : null}
              {group === "data" ? (
                <SubMenu>
                  <ul className="flex flex-col gap-0.5">
                    <MenuRow
                      icon={LayoutGrid}
                      label={t("data.all")}
                      selected={!narrow && !picked}
                      onPick={() => pick("all")}
                    />
                  </ul>
                  {spaceData.data
                    ? dataGroups(spaceData.data).map((g) => (
                        <MenuGroup key={g.key} label={g.label}>
                          {g.items.map((item) => (
                            <MenuRow
                              key={item.key}
                              icon={DATA_ICON[item.kind]}
                              label={item.title}
                              selected={!narrow && item.key === picked}
                              onPick={() => pick(item.key)}
                            />
                          ))}
                        </MenuGroup>
                      ))
                    : null}
                  <SectionRows groups={added} current={marked} onPick={jump} />
                </SubMenu>
              ) : group === "knowledge" ? (
                <SubMenu>
                  {treeOn && knowledge.data ? (
                    <KnowledgeTabs tab={knowTab} onTab={setKnowTab} />
                  ) : null}
                  {treeOn && knowledge.data && knowTab === "categories" ? (
                    <CategoryTree
                      categories={knowledge.data.categories}
                      picked={narrow ? null : picked}
                      pickedCategory={pickedValue.data?.category.id ?? null}
                      readOnly={Boolean(space?.readOnly)}
                      onPick={pick}
                      onNew={() => setNewCategory(true)}
                    />
                  ) : treeOn && knowledge.data ? (
                    <KnowledgeTree
                      items={knowledge.data.items}
                      picked={narrow ? null : item}
                      all={!(narrow || picked)}
                      readOnly={Boolean(space?.readOnly)}
                      onPick={pick}
                      onMove={moveItem}
                      onNewFolder={setFolderIn}
                      onMoveTo={setMoving}
                    />
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      <MenuRow
                        icon={LayoutGrid}
                        label={t("know.all")}
                        selected={!(narrow || picked)}
                        onPick={() => pick("all")}
                      />
                    </ul>
                  )}
                  {knowledge.data?.categories.length && !treeOn ? (
                    <MenuGroup label={t("know.categories")}>
                      {knowledge.data.categories.map((c) => (
                        <MenuRow
                          key={c.id}
                          icon={CATEGORY_ICON[c.type]}
                          label={c.name}
                          badge={
                            <span className="text-[0.75rem] text-ink-3 tabular-nums">
                              {c.proposed ? "·" : c.count}
                            </span>
                          }
                          selected={
                            !narrow &&
                            (picked === `c:${c.id}` || pickedValue.data?.category.id === c.id)
                          }
                          onPick={() => pick(`c:${c.id}`)}
                        />
                      ))}
                    </MenuGroup>
                  ) : null}
                  <SectionRows
                    groups={added}
                    current={narrow ? undefined : pickedSection?.id}
                    onPick={(id) => pick(`s:${id}`)}
                  />
                </SubMenu>
              ) : group === "files" && space ? (
                <SubMenu>
                  <DateienMenu spaceId={space.id} admin={admin} />
                </SubMenu>
              ) : group === "skills" ? (
                <SubMenu>
                  <ul className="flex flex-col gap-0.5">
                    <MenuRow
                      icon={LayoutGrid}
                      label={t("skills.all")}
                      selected={!(narrow || skillPick)}
                      onPick={() => pick("all")}
                    />
                    {skills.data?.skills.map((k) => (
                      <MenuRow
                        key={k.id}
                        icon={MODE_ICON[k.mode]}
                        label={k.name}
                        selected={!narrow && skillPick === `k:${k.id}`}
                        onPick={() => pick(`k:${k.id}`)}
                      />
                    ))}
                  </ul>
                  <SectionRows groups={added} current={marked} onPick={jump} />
                </SubMenu>
              ) : (
                <SubMenu>
                  <SectionRows groups={sections} current={marked} onPick={jump} />
                </SubMenu>
              )}

              {space && (group === "info" || group === "brand" || group === "knowledge") ? (
                <SpaceSettings
                  key={space.id}
                  space={space}
                  group={group}
                  top={!picked || Boolean(pickedSection)}
                >
                  {group === "knowledge" && item && clientsOn ? (
                    <OpenToClients
                      spaceId={space.id}
                      kind={
                        item.startsWith("p:")
                          ? "page"
                          : item.startsWith("t:")
                            ? "table"
                            : "document"
                      }
                      id={item.slice(2)}
                    />
                  ) : null}
                  {group !== "knowledge" ? null : item ? (
                    treeOn &&
                    knowledge.data &&
                    pickedItem &&
                    isFolder(pickedItem) &&
                    writing !== item ? (
                      <KnowledgeFolder
                        key={item}
                        spaceId={space.id}
                        data={knowledge.data}
                        folder={pickedItem}
                        readOnly={space.readOnly}
                        onOpen={pick}
                        onWrite={(key) => {
                          setWriting(key);
                          pick(key);
                        }}
                        onGone={() =>
                          pick(pickedItem.parentId ? `p:${pickedItem.parentId}` : "all")
                        }
                        kinds={sources.kinds}
                        onKind={(kind, parentId) => setAdding({ kind, parentId })}
                        source={sources.ofFolder(pickedItem.id)}
                        status={
                          sources.ofFolder(pickedItem.id) ? (
                            <SourcesStatus
                              spaceId={space.id}
                              sources={sources.sources}
                              only={sources.ofFolder(pickedItem.id)?.id}
                            />
                          ) : null
                        }
                      />
                    ) : item.startsWith("p:") ? (
                      <div key={item} className="flex flex-col gap-9">
                        <PageEditor
                          pageId={item.slice(2)}
                          onGone={() => pick("all")}
                          onOpen={pick}
                        />
                        {treeOn && knowledge.data && pickedItem ? (
                          <PageContents data={knowledge.data} page={pickedItem} onOpen={pick} />
                        ) : null}
                      </div>
                    ) : item.startsWith("t:") ? (
                      <TableEditor key={item} tableId={item.slice(2)} onGone={() => pick("all")} />
                    ) : (
                      <FileView
                        key={item}
                        spaceId={space.id}
                        fileId={item.slice(2)}
                        page={Number(at) || undefined}
                        readOnly={space.readOnly}
                        onGone={() => pick("all")}
                      />
                    )
                  ) : treeOn && picked?.startsWith("q:") ? (
                    <SourceView
                      key={picked}
                      spaceId={space.id}
                      sourceId={picked.slice(2)}
                      readOnly={space.readOnly}
                      onOpen={pick}
                      onGone={() => pick("all")}
                    />
                  ) : !knowledge.data ? null : pickedSection ? (
                    <Section
                      key={picked}
                      title={pickedSection.label()}
                      hint={pickedSection.hint?.()}
                      plain
                    >
                      <PluginFrame of={pickedSection}>
                        <pickedSection.component />
                      </PluginFrame>
                    </Section>
                  ) : treeOn && picked?.startsWith("c:") ? (
                    pickedCategory ? (
                      <CategoryHome
                        key={picked}
                        spaceId={space.id}
                        data={knowledge.data}
                        category={pickedCategory}
                        readOnly={space.readOnly}
                        onOpen={pick}
                        onGone={() => pick("all")}
                      />
                    ) : null
                  ) : treeOn && picked?.startsWith("v:") ? (
                    pickedValue.data ? (
                      <ValueHome
                        key={picked}
                        data={knowledge.data}
                        value={pickedValue.data}
                        readOnly={space.readOnly}
                        onOpen={pick}
                      />
                    ) : null
                  ) : picked?.startsWith("c:") ? (
                    pickedCategory ? (
                      <div key={picked} className="flex flex-col gap-5">
                        <CategoryView
                          spaceId={space.id}
                          category={pickedCategory}
                          readOnly={space.readOnly}
                          onOpen={pick}
                          onGone={() => pick("all")}
                        />
                        {pickedCategory.type === "choice" ? null : (
                          <CategoryItems
                            spaceId={space.id}
                            category={pickedCategory}
                            categories={knowledge.data.categories}
                            onOpen={pick}
                          />
                        )}
                      </div>
                    ) : null
                  ) : picked?.startsWith("v:") ? (
                    pickedValue.data ? (
                      <ValueView key={picked} value={pickedValue.data} readOnly={space.readOnly}>
                        <div className="flex flex-col gap-2">
                          {pickedValue.data.items.length ? (
                            <div className="flex flex-col rounded-xl bg-card p-1.5 shadow-soft ring-1 ring-border-soft">
                              {pickedValue.data.items.map((i) => (
                                <ItemRow
                                  key={i.key}
                                  item={i}
                                  categories={knowledge.data.categories.filter(
                                    (c) => c.id !== pickedValue.data?.category.id,
                                  )}
                                  onOpen={pick}
                                />
                              ))}
                            </div>
                          ) : null}
                          {pickedValue.data.rows.map((r) => (
                            <button
                              key={r.tableId}
                              type="button"
                              onClick={() => pick(`t:${r.tableId}`)}
                              className="px-1 text-left text-[0.8125rem] text-ink-3 hover:text-ink"
                            >
                              {t("know.tocRows", { n: r.count, table: r.title })}
                            </button>
                          ))}
                        </div>
                      </ValueView>
                    ) : null
                  ) : (
                    <Anchor id="documents">
                      {treeOn ? (
                        <KnowledgeHome
                          spaceId={space.id}
                          data={knowledge.data}
                          readOnly={space.readOnly}
                          onOpen={pick}
                          onWrite={(key) => {
                            setWriting(key);
                            pick(key);
                          }}
                          status={
                            <>
                              <SourcesStatus
                                spaceId={space.id}
                                sources={sources.sources}
                                onOpen={pick}
                              />
                              {pluginStatus(added)}
                            </>
                          }
                          kinds={sources.kinds}
                          onKind={(kind, parentId) => setAdding({ kind, parentId })}
                          adds={plugins.spaceSections
                            .filter((x) => (x.group ?? "knowledge") === "knowledge" && x.add)
                            .map((x) => ({
                              id: x.id,
                              label: x.add?.label() ?? x.label(),
                              hint: x.add?.hint?.(),
                              icon: x.add?.icon ?? x.icon,
                            }))}
                        />
                      ) : (
                        <KnowledgeOverview
                          spaceId={space.id}
                          data={knowledge.data}
                          readOnly={space.readOnly}
                          onOpen={pick}
                          status={pluginStatus(added)}
                        />
                      )}
                    </Anchor>
                  )}
                  {group === "info" || group === "brand" ? pluginSections(added) : null}
                </SpaceSettings>
              ) : null}
              {space && group === "knowledge" && treeOn && knowledge.data ? (
                <>
                  <SourceDialog
                    spaceId={space.id}
                    kind={adding?.kind ?? null}
                    parentId={adding?.parentId ?? null}
                    onClose={() => setAdding(null)}
                    onOpen={pick}
                  />
                  <MoveDialog
                    item={moving}
                    items={knowledge.data.items}
                    onClose={() => setMoving(null)}
                    onMove={moveItem}
                  />
                  <NewCategoryDialog
                    spaceId={space.id}
                    open={newCategory}
                    onClose={() => setNewCategory(false)}
                    onMade={(id) => {
                      setNewCategory(false);
                      pick(`c:${id}`);
                    }}
                  />
                  <NewItemDialog
                    kind={folderIn === undefined ? null : "folder"}
                    spaceId={space.id}
                    parentId={folderIn}
                    onClose={() => setFolderIn(undefined)}
                    onMade={(key) => {
                      setFolderIn(undefined);
                      pick(key);
                    }}
                  />
                </>
              ) : null}
              {space && group === "clients" && clientsOn ? (
                <Anchor id="clients">
                  <ClientSpaces space={space} />
                </Anchor>
              ) : null}
              {space && group === "skills" && skillsOn ? (
                <div className="flex flex-col gap-9 pb-20">
                  {skillPick ? (
                    <Suspense fallback={null}>
                      <SkillEditor
                        key={skillPick}
                        skillId={skillPick.slice(2)}
                        onGone={() => pick("all")}
                        onOpen={pick}
                      />
                    </Suspense>
                  ) : skills.data ? (
                    <>
                      <SkillsOverview spaceId={space.id} data={skills.data} onOpen={pick} />
                      {pluginSections(added)}
                    </>
                  ) : skills.error ? (
                    <p className="text-[0.875rem] text-rose">{(skills.error as Error).message}</p>
                  ) : null}
                </div>
              ) : null}
              {space && group === "page" && pagesOn ? (
                <div className="flex flex-col gap-9 pb-20">
                  <PublicPage key={space.id} space={space} />
                  {pluginSections(added)}
                </div>
              ) : null}
              {space && part ? (
                <PluginFrame of={part}>
                  <SpacePartFrame key={space.id} part={part.id}>
                    <part.component />
                  </SpacePartFrame>
                </PluginFrame>
              ) : null}
              {space && group === "files" && filesOn ? (
                <DateienPage key={space.id} spaceId={space.id} admin={admin} />
              ) : null}
              {space && group === "data" ? (
                <div className="flex flex-col gap-9 pb-20">
                  {picked?.startsWith("t:") ? (
                    <TableEditor
                      key={picked}
                      tableId={picked.slice(2)}
                      onGone={() => pick("all")}
                    />
                  ) : picked?.startsWith("p:") ? (
                    <PageEditor key={picked} pageId={picked.slice(2)} onGone={() => pick("all")} />
                  ) : (
                    <>
                      {spaceData.data ? (
                        <DataOverview
                          spaceId={space.id}
                          data={spaceData.data}
                          readOnly={space.readOnly}
                          onOpen={pick}
                        />
                      ) : null}
                      {pluginSections(added)}
                    </>
                  )}
                </div>
              ) : null}
              {space && group === "results" ? (
                <div className="flex flex-col gap-9 pb-20">
                  {results.data ? (
                    <Results
                      data={results.data}
                      wizardId={wizardId}
                      onWizard={(id) => pick(id ?? "all")}
                      filter={filter}
                      onFilter={setFilter}
                    />
                  ) : null}
                  {results.isError ? (
                    <p className="text-[0.875rem] text-rose">{(results.error as Error).message}</p>
                  ) : null}
                  {pluginSections(added)}
                </div>
              ) : null}
              {/* No space yet: nothing is built here, and no local install has sent one. */}
              {!(space || loading) ? <Empty>{t("settings.noSpace")}</Empty> : null}
            </div>
          ) : space && (!narrow || show === "overview") ? (
            <div className="min-w-0">
              {narrow ? (
                <div className="mb-3">
                  <BackRow label={t("nav.sources")} onBack={() => navigate("/space")} />
                </div>
              ) : null}
              <SpaceOverview space={space} parts={parts} />
            </div>
          ) : null}
        </div>
      </div>
    </SettingsMenuContext.Provider>
  );
}
