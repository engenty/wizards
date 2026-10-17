import type { BrowserTool } from "@engenty-wizards/shared/assistant";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { SCROLL_ROOT_ID } from "../AppFrame";

/**
 * What the studio assistant may do in the browser: open a page, point at a place, look at what
 * is on the screen, read one area, fill a field (unsaved), scroll. No clicks: the person presses
 * the buttons. A page adds tools of its own with `useAssistantTool`. Each turn sends the tools
 * as JSON Schema (AG-UI's `tools`); a `tool_call` for one of them runs here.
 */

type Run = (args: Record<string, unknown>) => unknown | Promise<unknown>;

interface Registered extends BrowserTool {
  run: Run;
}

// --- targets -----------------------------------------------------------------------------

/** Where the assistant looks: the page, not the assistant itself or the app bar. */
const pageRoot = () => document.getElementById(SCROLL_ROOT_ID) ?? document.body;

const ITEM =
  "[data-assist],h1,h2,h3,h4,button,a[href],input,textarea,select,[role=switch],[role=checkbox],[role=tab],[contenteditable=true]";
const MAX_ITEMS = 150;
let refs = 0;

/** A name for an element the model can point at again: its `data-assist`, else a fresh ref. */
function refOf(el: HTMLElement): string {
  if (el.dataset.assist) {
    return el.dataset.assist;
  }
  if (!el.dataset.assistRef) {
    refs += 1;
    el.dataset.assistRef = `e${refs}`;
  }
  return el.dataset.assistRef;
}

const clean = (s: string | null | undefined, max = 120) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function labelOf(el: HTMLElement): string {
  if (el.dataset.assistLabel) {
    return clean(el.dataset.assistLabel);
  }
  const aria = el.getAttribute("aria-label");
  if (aria) {
    return clean(aria);
  }
  // An area is called by its heading.
  if (el.dataset.assist && !el.matches("input,textarea,select,button,a")) {
    const heading = el.querySelector("h1,h2,h3,h4,[data-assist-section]");
    if (heading) {
      return clean(heading.getAttribute("data-assist-section") || heading.textContent);
    }
  }
  if (el.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (label) {
      return clean(label.textContent);
    }
  }
  const wrapping = el.closest("label");
  if (wrapping && wrapping !== el) {
    return clean(wrapping.textContent);
  }
  // A field under a label of the same block: the studio's `Label` stands before its input.
  const prev = el.parentElement?.querySelector("label");
  if (prev && (el.matches("input,textarea,select") || el.getAttribute("role") === "switch")) {
    return clean(prev.textContent);
  }
  return clean(
    el.textContent || (el as HTMLInputElement).placeholder || el.getAttribute("title") || "",
  );
}

function fieldValue(el: HTMLElement): unknown {
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") {
      return el.value ? "••••" : "";
    }
    if (el.type === "checkbox" || el.type === "radio") {
      return el.checked;
    }
    return el.value.slice(0, 300);
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value.slice(0, 600);
  }
  if (el instanceof HTMLSelectElement) {
    return clean(el.selectedOptions[0]?.textContent ?? el.value);
  }
  const role = el.getAttribute("role");
  if (role === "switch" || role === "checkbox") {
    return el.getAttribute("aria-checked") === "true";
  }
  if (el.isContentEditable) {
    return clean(el.textContent, 600);
  }
  return undefined;
}

function kindOf(el: HTMLElement): string {
  if (el.dataset.assist && !el.matches("input,textarea,select,button,a")) {
    return "area";
  }
  if (/^H[1-4]$/.test(el.tagName)) {
    return "heading";
  }
  if (el.matches("input,textarea,select,[role=switch],[role=checkbox],[contenteditable=true]")) {
    return "field";
  }
  if (el.getAttribute("role") === "tab") {
    return "tab";
  }
  return el.tagName === "A" ? "link" : "button";
}

function shown(el: HTMLElement): boolean {
  if (el.closest("[data-assistant-ui],[aria-hidden=true]")) {
    return false;
  }
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function onScreen(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function listOf(root: HTMLElement, visibleOnly: boolean) {
  const items: Record<string, unknown>[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(ITEM)) {
    if (items.length >= MAX_ITEMS) {
      break;
    }
    if (!shown(el) || (visibleOnly && !onScreen(el))) {
      continue;
    }
    const kind = kindOf(el);
    const label = labelOf(el);
    if (!label && kind !== "field") {
      continue;
    }
    const value = kind === "field" ? fieldValue(el) : undefined;
    const disabled =
      (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
    items.push({
      ref: refOf(el),
      kind,
      label,
      ...(value !== undefined ? { value } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(el.getAttribute("aria-current") || el.getAttribute("aria-selected") === "true"
        ? { current: true }
        : {}),
    });
  }
  return items;
}

/** The element the model names: a `data-assist` id, a ref from look_at_page, an id, or a label. */
function find(target: string): HTMLElement | null {
  const root = pageRoot();
  const t = target.trim();
  const byAttr =
    document.querySelector<HTMLElement>(`[data-assist="${CSS.escape(t)}"]`) ??
    document.querySelector<HTMLElement>(`[data-assist-ref="${CSS.escape(t)}"]`) ??
    (/^[A-Za-z][\w-]*$/.test(t) ? document.getElementById(t) : null);
  if (byAttr) {
    return byAttr;
  }
  const wanted = t.toLowerCase();
  let best: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>(ITEM)) {
    if (!shown(el)) {
      continue;
    }
    const label = labelOf(el).toLowerCase();
    if (label === wanted) {
      return el;
    }
    if (!best && label.includes(wanted)) {
      best = el;
    }
  }
  return best;
}

const missing = (target: string) => ({
  error: `Nothing on the page is "${target}". look_at_page lists what is there.`,
});

// --- highlight -----------------------------------------------------------------------------

export interface Highlight {
  id: number;
  el: HTMLElement;
  mode: "spotlight" | "ring";
  title?: string;
  text?: string;
  buttons: string[];
}

let highlight: Highlight | null = null;
let highlights = 0;
const highlightListeners = new Set<() => void>();

export function setHighlight(next: Highlight | null) {
  highlight = next;
  for (const listener of highlightListeners) {
    listener();
  }
}

export function useHighlight(): Highlight | null {
  return useSyncExternalStore(
    (listener) => {
      highlightListeners.add(listener);
      return () => highlightListeners.delete(listener);
    },
    () => highlight,
  );
}

// --- navigation ----------------------------------------------------------------------------

let go: ((to: string) => void) | null = null;
let known: () => string[] = () => [];

/** The router's navigate and the studio's addresses, from a component inside the router. */
export function bindNavigation(navigate: (to: string) => void, routes: () => string[]) {
  go = navigate;
  known = routes;
}

function routeAllowed(path: string): boolean {
  const bare = path.split(/[?#]/)[0] || "/";
  return known().some((pattern) => {
    const re = new RegExp(
      `^${pattern
        .split("/")
        .map((part) =>
          part.startsWith(":")
            ? part.endsWith("?")
              ? "(?:[^/]+)?"
              : "[^/]+"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/")}/?$`,
    );
    return re.test(bare);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

/** Opens a studio address an answer links to, in the app; false for any other address. */
export function openStudioLink(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//") || /^\/(api|w|s)\//.test(href)) {
    return false;
  }
  if (!(go && routeAllowed(href))) {
    return false;
  }
  go(href);
  return true;
}

// --- the tools -----------------------------------------------------------------------------

const target = { type: "string", description: "A ref or area from look_at_page, or the label" };

/** The tools pages add while they are shown, by name. */
const added = new Map<string, Registered>();

/** The tools of the page shown now, as page_tool takes them. */
function pageTools() {
  return [...added.values()].map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

const BUILT_IN: Registered[] = [
  {
    name: "navigate",
    description:
      "Open a page of the studio by its address (/settings/models, /space/knowledge, /space/data, a plugin's page). The chat stays open.",
    parameters: {
      type: "object",
      properties: { to: { type: "string", description: "The studio address, starting with /" } },
      required: ["to"],
    },
    run: async ({ to }) => {
      const path = String(to ?? "");
      if (!(path.startsWith("/") && routeAllowed(path))) {
        return { error: `The studio has no page "${path}".`, pages: known() };
      }
      go?.(path);
      await settle();
      // The page now shown may offer tools of its own: page_tool runs them.
      return { opened: path, pageTools: pageTools() };
    },
  },
  {
    name: "highlight",
    description:
      "Point at one element: `spotlight` dims the page except it, `ring` only rings it. A small card beside it shows a title, a text and buttons; a button the person presses comes back as their next message. Scrolls it into view.",
    parameters: {
      type: "object",
      properties: {
        target,
        mode: { type: "string", enum: ["spotlight", "ring"] },
        title: { type: "string", maxLength: 80 },
        text: { type: "string", maxLength: 400 },
        buttons: {
          type: "array",
          items: { type: "string", maxLength: 40 },
          maxItems: 3,
          description: "Answers the person can give with one click",
        },
      },
      required: ["target"],
    },
    run: async ({ target: name, mode, title, text, buttons }) => {
      const el = find(String(name ?? ""));
      if (!el) {
        return missing(String(name));
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await settle();
      highlights += 1;
      setHighlight({
        id: highlights,
        el,
        mode: mode === "ring" ? "ring" : "spotlight",
        title: title ? String(title) : undefined,
        text: text ? String(text) : undefined,
        buttons: Array.isArray(buttons) ? buttons.map(String).slice(0, 3) : [],
      });
      return { shown: labelOf(el) };
    },
  },
  {
    name: "look_at_page",
    description:
      "What is on the screen now, as a list: headings, areas, buttons, links, tabs and fields with their values, each with a ref to point at (at most 150). Not a picture.",
    parameters: { type: "object", properties: {} },
    run: () => ({
      route: window.location.pathname,
      scrolled: Math.round(pageRoot().scrollTop),
      items: listOf(pageRoot(), true),
      pageTools: pageTools(),
    }),
  },
  {
    name: "read_section",
    description:
      "Everything in one area of the page, also what is scrolled away: its elements with values, and its text.",
    parameters: { type: "object", properties: { target }, required: ["target"] },
    run: ({ target: name }) => {
      const el = find(String(name ?? ""));
      if (!el) {
        return missing(String(name));
      }
      return {
        area: labelOf(el),
        items: listOf(el, false),
        text: clean(el.innerText, 4000),
      };
    },
  },
  {
    name: "fill_field",
    description:
      "Put a value into a field of the page, as if typed: text, a choice by its label, yes/no for a switch. Not saved by you: the person checks and saves.",
    parameters: {
      type: "object",
      properties: { target, value: { type: ["string", "number", "boolean"] } },
      required: ["target", "value"],
    },
    run: async ({ target: name, value }) => {
      const el = find(String(name ?? ""));
      if (!el) {
        return missing(String(name));
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        if (el.checked !== Boolean(value)) {
          el.click();
        }
      } else if (el.getAttribute("role") === "switch" || el.getAttribute("role") === "checkbox") {
        if ((el.getAttribute("aria-checked") === "true") !== Boolean(value)) {
          el.click();
        }
      } else if (el instanceof HTMLSelectElement) {
        const option = [...el.options].find(
          (o) =>
            o.value === String(value) ||
            clean(o.textContent).toLowerCase() === String(value).toLowerCase(),
        );
        if (!option) {
          return {
            error: "No such choice.",
            choices: [...el.options].map((o) => clean(o.textContent)),
          };
        }
        el.value = option.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.disabled || el.readOnly) {
          return { error: "The field takes nothing here." };
        }
        // React keeps its own value: set the element's through the prototype, then say so.
        const proto =
          el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, String(value));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        return { error: "That is not a field." };
      }
      el.focus({ preventScroll: true });
      return { filled: labelOf(el), value: fieldValue(el) };
    },
  },
  {
    name: "page_tool",
    description:
      "Runs a tool the page shown now offers, by its name, with its arguments: a page opened during this answer brings tools that are not among yours (navigate and look_at_page list them with their parameters).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        args: { type: "object", description: "The tool's arguments, as its parameters say" },
      },
      required: ["name"],
    },
    run: async ({ name, args }) => {
      const tool = added.get(String(name ?? ""));
      if (!tool) {
        return { error: `The page offers no tool "${String(name)}".`, pageTools: pageTools() };
      }
      return tool.run((args ?? {}) as Record<string, unknown>);
    },
  },
  {
    name: "scroll_to",
    description: "Scroll an element of the page into view.",
    parameters: { type: "object", properties: { target }, required: ["target"] },
    run: async ({ target: name }) => {
      const el = find(String(name ?? ""));
      if (!el) {
        return missing(String(name));
      }
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      await settle();
      return { at: labelOf(el) };
    },
  },
];

// --- what pages add ------------------------------------------------------------------------

/**
 * A tool of the page while it is shown, e.g. the shop's "filter the products". `parameters` is
 * the JSON Schema of its arguments; `run` returns what the assistant learns.
 */
export function useAssistantTool(
  name: string,
  tool: { description: string; parameters?: Record<string, unknown> },
  run: Run,
) {
  const latest = useRef(run);
  latest.current = run;
  const key = JSON.stringify(tool);
  useEffect(() => {
    if (BUILT_IN.some((b) => b.name === name)) {
      throw new Error(`"${name}" is a tool of the assistant itself.`);
    }
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(name)) {
      throw new Error(`"${name}": a tool's name is lower case letters, digits and _.`);
    }
    const { description, parameters } = JSON.parse(key) as typeof tool;
    added.set(name, {
      name,
      description,
      parameters: parameters ?? { type: "object", properties: {} },
      run: (args) => latest.current(args),
    });
    return () => {
      added.delete(name);
    };
  }, [name, key]);
}

/** The tools a turn hands the assistant. */
export function browserTools(): BrowserTool[] {
  return [...BUILT_IN, ...added.values()].map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

/** Runs a tool the assistant called; null when it is none of the browser's. */
export async function runBrowserTool(
  name: string,
  args: unknown,
): Promise<{ result: unknown } | null> {
  const tool = BUILT_IN.find((b) => b.name === name) ?? added.get(name);
  if (!tool) {
    return null;
  }
  try {
    return { result: await tool.run((args ?? {}) as Record<string, unknown>) };
  } catch (err) {
    return { result: { error: (err as Error).message } };
  }
}
