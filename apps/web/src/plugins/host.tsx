import type {
  StudioAssistantCard,
  StudioAssistantProps,
  StudioNavEntry,
  StudioPage,
  StudioPlugin,
  StudioPluginContext,
  StudioSettingsSection,
  StudioShareSection,
  StudioShareSetup,
  StudioSpace,
  StudioSpaceMenuEntry,
  StudioSpacePart,
  StudioSpaceSection,
} from "@engenty/wizards/plugin/studio";
import * as sdk from "@engenty/wizards/plugin/studio";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import {
  Component,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import * as jsx from "react/jsx-runtime";
import { createPortal, flushSync } from "react-dom";
import {
  Link,
  Navigate,
  NavLink,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { api } from "../lib/api";
import { withBase } from "../lib/base";
import { lang, t } from "../lib/i18n";
import { type Me, useCurrentProject } from "../lib/session";
import { useCrumbs } from "../studio/AppFrame";
import { useAssistantPage } from "../studio/assistant/page";
import { useAssistantTool } from "../studio/assistant/tools";
import { OWN_SPACE_SECTIONS } from "../studio/project-sections";
import * as ui from "../ui";

/**
 * The studio's side of plugins (docs/content/dev/plugins). After sign-in the studio asks the runtime
 * which plugins the tenant has, loads each one's built studio half and lets it register pages,
 * entries of the top bar, sections of the settings and of the space page, parts of the space page,
 * and cards of the space assistant's chat.
 *
 * A plugin's script is built to take React, the router and the studio's own components from
 * here (`__WIZARDS_STUDIO__`), so what it draws is part of this app, not a second one beside it.
 */

const shared = {
  react: React,
  jsx,
  reactDom: { createPortal, flushSync },
  // What a page of a plugin needs of the router and of the query cache; not all of either.
  router: { Link, Navigate, NavLink, useLocation, useNavigate, useParams, useSearchParams },
  query: { useMutation, useQuery, useQueryClient },
  ui,
  sdk,
};

declare global {
  var __WIZARDS_STUDIO__: typeof shared;
}
globalThis.__WIZARDS_STUDIO__ = shared;

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  generation: number;
  /** Why the server half did not load. */
  error: string | null;
  script: string | null;
  styles: string | null;
  tools: { id: string; title: string }[];
}

interface Listing {
  plugins: PluginInfo[];
  canReload: boolean;
  problems: { path: string; message: string }[];
}

/** What a plugin registered: whose it is, and a number no other registration has. */
type Of<T> = T & { plugin: string; serial: number };
let serials = 0;

export interface StudioPlugins extends Listing {
  /** `ready`: every plugin's studio half ran, so every page it adds is known. */
  status: "idle" | "loading" | "ready";
  /** Studio halves that did not load, by plugin. */
  failed: Record<string, string>;
  pages: Of<StudioPage>[];
  nav: Of<StudioNavEntry>[];
  sections: Of<StudioSettingsSection>[];
  spaceSections: Of<StudioSpaceSection>[];
  spaceParts: Of<StudioSpacePart>[];
  /** The menus of the plugins' space parts, by part, as the drawn part says them. */
  spaceMenus: Record<string, StudioSpaceMenuEntry[]>;
  shareSections: Of<StudioShareSection>[];
  shareSetups: Of<StudioShareSetup>[];
  cards: Of<StudioAssistantCard>[];
}

let state: StudioPlugins = {
  status: "idle",
  plugins: [],
  canReload: false,
  problems: [],
  failed: {},
  pages: [],
  nav: [],
  sections: [],
  spaceSections: [],
  spaceParts: [],
  spaceMenus: {},
  shareSections: [],
  shareSetups: [],
  cards: [],
};
const listeners = new Set<() => void>();

function set(patch: Partial<StudioPlugins>) {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

export function useStudioPlugins(): StudioPlugins {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Addresses the studio keeps for itself, and the sections of its own settings. */
const OWN_PAGES = new Set(["", "new", "edit", "settings", "space", "setup", "sign-in"]);
const OWN_SECTIONS = new Set(["account", "project", "connectors", "models", "build", "plugins"]);
/** The space page's own parts. */
const OWN_PARTS = new Set(["info", "knowledge", "data", "results"]);

interface Mounted {
  /** The built files this was loaded from; other files mean: load again. */
  key: string;
  disposers: (() => void)[];
  link: HTMLLinkElement | null;
}
const mounted = new Map<string, Mounted>();
let me: Me | null = null;

const keyOf = (plugin: PluginInfo) => `${plugin.script}|${plugin.styles}`;
const globalName = (id: string) => `__wizardsPlugin_${id.replaceAll("-", "_")}`;

/** What one run of a plugin's studio half registered, before it counts. */
interface Draft {
  pages: Of<StudioPage>[];
  nav: Of<StudioNavEntry>[];
  sections: Of<StudioSettingsSection>[];
  spaceSections: Of<StudioSpaceSection>[];
  spaceParts: Of<StudioSpacePart>[];
  shareSections: Of<StudioShareSection>[];
  shareSetups: Of<StudioShareSetup>[];
  cards: Of<StudioAssistantCard>[];
  disposers: (() => void)[];
}

/** The space the studio shows, as a plugin sees it; the same object while nothing changes. */
function useSpace(): StudioSpace | null {
  const { project } = useCurrentProject();
  const id = project?.id;
  const name = project?.name ?? "";
  const readOnly = project?.readOnly ?? false;
  const brand = JSON.stringify({
    name: project?.brand.name ?? "",
    colors: (project?.brand.colors ?? []).map(({ name, value }) => ({ name, value })),
    fonts: (project?.brand.fonts ?? []).map(({ family, role, weights }) => ({
      family,
      role,
      weights,
    })),
  });
  return useMemo(
    () => (id ? { id, name, readOnly, brand: JSON.parse(brand) } : null),
    [id, name, readOnly, brand],
  );
}

/** The space part a plugin's component is drawn in: where its `useSpaceMenu` goes. */
const PartContext = createContext<string | null>(null);

/** Draws a plugin's space part; what it says of its menu goes to the page's menu. */
export function SpacePartFrame({ part, children }: { part: string; children: ReactNode }) {
  return <PartContext.Provider value={part}>{children}</PartContext.Provider>;
}

function useSpaceMenu(entries: StudioSpaceMenuEntry[]) {
  const part = useContext(PartContext);
  const key = JSON.stringify(entries.map((e) => [e.id, e.label]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the entries count by their ids and labels.
  useEffect(() => {
    if (!part) {
      return;
    }
    set({ spaceMenus: { ...state.spaceMenus, [part]: entries } });
    return () => {
      const { [part]: _gone, ...rest } = state.spaceMenus;
      set({ spaceMenus: rest });
    };
  }, [part, key]);
}

/** The studio's assistant on a plugin's page: told it is that page, and what to say there. */
function PluginAssistant({ plugin, ...page }: StudioAssistantProps & { plugin: string }) {
  useAssistantPage({ ...page, plugin });
  return null;
}

function contextFor(plugin: PluginInfo, draft: Draft): StudioPluginContext {
  const { id } = plugin;
  const own = (path: string) =>
    `/api/studio/plugins/${id}${path.startsWith("/") ? path : `/${path}`}`;
  // What the plugin itself registered before is about to be replaced: only the others count.
  const others = <T extends { plugin: string }>(list: T[]) => list.filter((x) => x.plugin !== id);
  return {
    plugin: { id, name: plugin.name, version: plugin.version },
    registerPage(page) {
      const first = page.path.split("/")[1] ?? "";
      if (!page.path.startsWith("/") || OWN_PAGES.has(first)) {
        throw new Error(`"${page.path}" is an address of the studio itself.`);
      }
      if ([...others(state.pages), ...draft.pages].some((p) => p.path === page.path)) {
        throw new Error(`"${page.path}" is registered already.`);
      }
      draft.pages.push({ ...page, plugin: id, serial: ++serials });
    },
    registerNav(entry) {
      draft.nav.push({ ...entry, plugin: id, serial: ++serials });
    },
    registerSettingsSection(section) {
      const taken = [...others(state.sections), ...draft.sections].some((s) => s.id === section.id);
      if (OWN_SECTIONS.has(section.id) || taken) {
        throw new Error(`The settings have a section "${section.id}" already.`);
      }
      draft.sections.push({ ...section, plugin: id, serial: ++serials });
    },
    registerSpaceSection(section) {
      const taken = [...others(state.spaceSections), ...draft.spaceSections].some(
        (s) => s.id === section.id,
      );
      if (OWN_SPACE_SECTIONS.includes(section.id) || taken) {
        throw new Error(`The space page has a section "${section.id}" already.`);
      }
      draft.spaceSections.push({ ...section, plugin: id, serial: ++serials });
    },
    registerSpacePart(part) {
      const taken = [...others(state.spaceParts), ...draft.spaceParts].some(
        (p) => p.id === part.id,
      );
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(part.id) || OWN_PARTS.has(part.id) || taken) {
        throw new Error(`The space page has a part "${part.id}" already.`);
      }
      draft.spaceParts.push({ ...part, plugin: id, serial: ++serials });
    },
    registerShareSection(section) {
      const taken = [...others(state.shareSections), ...draft.shareSections].some(
        (s) => s.runner === section.runner,
      );
      if (taken) {
        throw new Error(`The runner "${section.runner}" has a share section already.`);
      }
      draft.shareSections.push({ ...section, plugin: id, serial: ++serials });
    },
    registerShareSetup(setup) {
      const taken = [...others(state.shareSetups), ...draft.shareSetups].some(
        (s) => s.runner === setup.runner,
      );
      if (taken) {
        throw new Error(`The runner "${setup.runner}" has a share setup already.`);
      }
      draft.shareSetups.push({ ...setup, plugin: id, serial: ++serials });
    },
    registerAssistantCard(card) {
      if (draft.cards.some((c) => c.tool === card.tool)) {
        throw new Error(`The tool "${card.tool}" has a card already.`);
      }
      draft.cards.push({ ...card, plugin: id, serial: ++serials });
    },
    useSpace,
    useSpaceMenu,
    useCrumbs,
    Assistant: (props) => <PluginAssistant plugin={id} {...props} />,
    useAssistantPage: (page) => useAssistantPage({ ...page, plugin: id }),
    useAssistantTool: (name, tool, run) =>
      useAssistantTool(`${id.replaceAll("-", "_")}_${name}`, tool, run),
    i18n: {
      register: (messages) => (key, vars) => {
        let text = messages[lang]?.[key] ?? messages.de[key] ?? key;
        for (const [name, value] of Object.entries(vars ?? {})) {
          text = text.replace(`{${name}}`, String(value));
        }
        return text;
      },
      lang: () => lang,
    },
    api: {
      get: (path) => api.get(own(path)),
      post: (path, body) => api.post(own(path), body),
      put: (path, body) => api.put(own(path), body),
      patch: (path, body) => api.patch(own(path), body),
      del: (path) => api.del(own(path)),
    },
    me: () => ({
      user: { id: me!.user.id, name: me!.user.name, email: me!.user.email },
      tenant: me!.tenant,
      mode: me!.mode,
    }),
    onUnload(dispose) {
      draft.disposers.push(dispose);
    },
  };
}

function loadScript(src: string): Promise<void> {
  return new Promise((done, fail) => {
    const script = document.createElement("script");
    script.src = src;
    // Once it ran, the element is of no further use.
    script.onload = () => {
      script.remove();
      done();
    };
    script.onerror = () => {
      script.remove();
      fail(new Error("The plugin's script did not load."));
    };
    document.head.append(script);
  });
}

/** The plugin's styles are in before its pages draw. */
function loadStyles(id: string, href: string): Promise<HTMLLinkElement> {
  return new Promise((done) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.plugin = id;
    link.onload = () => done(link);
    link.onerror = () => done(link);
    document.head.append(link);
  });
}

/** Undoes what a load of a plugin left besides its registrations. */
function release(id: string, disposers: (() => void)[], link: HTMLLinkElement | null) {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch (err) {
      console.error(`[plugin ${id}]`, err);
    }
  }
  link?.remove();
}

/** Takes a plugin out of the studio: what it registered, its styles, and why it failed. */
function unmount(id: string) {
  const was = mounted.get(id);
  mounted.delete(id);
  release(id, was?.disposers ?? [], was?.link ?? null);
  const { [id]: _gone, ...failed } = state.failed;
  set({
    failed,
    pages: state.pages.filter((p) => p.plugin !== id),
    nav: state.nav.filter((n) => n.plugin !== id),
    sections: state.sections.filter((s) => s.plugin !== id),
    spaceSections: state.spaceSections.filter((s) => s.plugin !== id),
    spaceParts: state.spaceParts.filter((s) => s.plugin !== id),
    shareSections: state.shareSections.filter((s) => s.plugin !== id),
    shareSetups: state.shareSetups.filter((s) => s.plugin !== id),
    cards: state.cards.filter((c) => c.plugin !== id),
  });
}

/**
 * Loads a plugin's studio half and puts what it registers in the place of what the plugin had
 * before, in one step: a page that is open stays open while its plugin loads again.
 */
async function mount(plugin: PluginInfo) {
  const { id } = plugin;
  const draft: Draft = {
    pages: [],
    nav: [],
    sections: [],
    spaceSections: [],
    spaceParts: [],
    shareSections: [],
    shareSetups: [],
    cards: [],
    disposers: [],
  };
  let link: HTMLLinkElement | null = null;
  try {
    if (plugin.styles) {
      link = await loadStyles(id, withBase(plugin.styles));
    }
    await loadScript(withBase(plugin.script!));
    const globals = globalThis as Record<string, unknown>;
    const name = globalName(id);
    const built = globals[name] as StudioPlugin | { default?: StudioPlugin } | undefined;
    // A script's `var` cannot be deleted; emptied, a stale one is never taken for a fresh load.
    globals[name] = undefined;
    const run = typeof built === "function" ? built : built?.default;
    if (typeof run !== "function") {
      throw new Error("The plugin's script has no default export.");
    }
    run(contextFor(plugin, draft));
  } catch (err) {
    console.error(`[plugin ${id}]`, err);
    release(id, draft.disposers, link);
    // A studio half that breaks is out until it is mended, as a server half is.
    unmount(id);
    mounted.set(id, { key: keyOf(plugin), disposers: [], link: null });
    set({ failed: { ...state.failed, [id]: (err as Error).message } });
    return;
  }
  const was = mounted.get(id);
  mounted.set(id, { key: keyOf(plugin), disposers: draft.disposers, link });
  const { [id]: _mended, ...failed } = state.failed;
  set({
    failed,
    pages: [...state.pages.filter((p) => p.plugin !== id), ...draft.pages],
    nav: [...state.nav.filter((n) => n.plugin !== id), ...draft.nav],
    sections: [...state.sections.filter((s) => s.plugin !== id), ...draft.sections],
    spaceSections: [...state.spaceSections.filter((s) => s.plugin !== id), ...draft.spaceSections],
    spaceParts: [...state.spaceParts.filter((s) => s.plugin !== id), ...draft.spaceParts],
    shareSections: [...state.shareSections.filter((s) => s.plugin !== id), ...draft.shareSections],
    shareSetups: [...state.shareSetups.filter((s) => s.plugin !== id), ...draft.shareSetups],
    cards: [...state.cards.filter((c) => c.plugin !== id), ...draft.cards],
  });
  release(id, was?.disposers ?? [], was?.link ?? null);
}

/** One at a time: a change may be told while the last one is still being loaded. */
let turn: Promise<void> = Promise.resolve();

function sync(): Promise<void> {
  turn = turn
    .catch(() => undefined)
    .then(async () => {
      const listing = await api.get<Listing>("/api/studio/plugins");
      for (const id of [...mounted.keys()]) {
        if (!listing.plugins.some((p) => p.id === id && p.script)) {
          unmount(id);
        }
      }
      set(listing);
      for (const plugin of listing.plugins) {
        if (plugin.script && mounted.get(plugin.id)?.key !== keyOf(plugin)) {
          await mount(plugin);
        }
      }
    })
    .catch((err) => console.error("[plugins]", err))
    .finally(() => set({ status: "ready" }));
  return turn;
}

let events: EventSource | null = null;

/** Called by a signed-in studio: loads the tenant's plugins once and keeps them current. */
export function startStudioPlugins(who: Me) {
  me = who;
  if (state.status !== "idle") {
    return;
  }
  set({ status: "loading" });
  void sync().then(() => {
    // Plugins change while the app runs only where it runs alone.
    if (state.canReload && !events) {
      events = new EventSource(withBase("/api/studio/plugins/-/events"), { withCredentials: true });
      events.addEventListener("change", () => void sync());
    }
  });
}

/** Loads one plugin again from its files, or looks for all of them again. */
export async function reloadPlugins(id?: string): Promise<void> {
  await api.post(id ? `/api/studio/plugins/-/reload/${id}` : "/api/studio/plugins/-/reload");
  await sync();
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error("[plugin]", err);
  }

  render() {
    return this.state.failed ? <ui.Empty>{t("plugins.crashed")}</ui.Empty> : this.props.children;
  }
}

/**
 * What a plugin draws. The mark is what the plugin's own styles hold on to; a plugin that
 * throws while drawing takes down its own part, not the studio.
 */
export function PluginFrame({
  of,
  children,
}: {
  of: { plugin: string; serial: number };
  children: ReactNode;
}) {
  return (
    <div data-plugin={of.plugin} className="contents">
      {/* A plugin that loaded again starts with a clean slate. */}
      <Boundary key={of.serial}>{children}</Boundary>
    </div>
  );
}
