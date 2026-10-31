import type { AssistantPage } from "@engenty/wizards-shared/assistant";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { STUDIO_ROOT } from "../../lib/base";
import { currentCrumbs, SCROLL_ROOT_ID } from "../AppFrame";

/**
 * What a page tells the studio assistant: the words of its panel (title, hello, suggestions,
 * placeholder) and what it shows (an open item, a selection, a summary, fields). Every message
 * carries the page's snapshot; the route and the title come from the address and the top bar's
 * trail, so a page that registers nothing still says where it is.
 */

/** A row under the hello: a question the person can ask with one click. */
export interface AssistantSuggestion {
  label: string;
  /** What is sent; the label where left out. */
  message?: string;
  /** Put into the field to finish ("The loafer costs … now") instead of sent at once. */
  fill?: boolean;
}

export interface PageAssistant
  extends Pick<AssistantPage, "open" | "selection" | "summary" | "fields" | "plugin"> {
  /** The opened panel's heading before the first message. */
  title?: string;
  hello?: string;
  /** More about the page, where the chat stands at its top: what goes in and what it is for. */
  about?: string;
  placeholder?: string;
  suggestions?: AssistantSuggestion[];
  /** A page of full-height tables: the assistant starts small here unless opened. */
  compact?: boolean;
  /** The page has its own input (a new wizard's wish, a Work chat): Goose stays small there. */
  ownInput?: boolean;
  /** The assistant changed the space or the plugin's data: read the page's data again. */
  onChanged?: () => void;
}

const entries = new Map<string, PageAssistant>();
let merged: PageAssistant = {};
const listeners = new Set<() => void>();

function publish() {
  // Where two registrations set the same word, the later one's stands.
  merged = Object.assign({}, ...entries.values());
  for (const listener of listeners) {
    listener();
  }
}

/** What the pages shown now tell the assistant, together. */
export function usePageAssistant(): PageAssistant {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => merged,
  );
}

/** Every handler of the pages shown now that wants to know of a change. */
export function pageChanged() {
  for (const entry of entries.values()) {
    entry.onChanged?.();
  }
}

/**
 * Tells the assistant about the page while it is shown. Data may change on every render; the
 * assistant reads it when the person sends.
 */
export function useAssistantPage(page: PageAssistant) {
  const id = useId();
  const latest = useRef(page);
  latest.current = page;
  const { onChanged: _changed, ...data } = page;
  const key = JSON.stringify(data);
  useEffect(() => {
    entries.set(id, {
      ...(JSON.parse(key) as PageAssistant),
      onChanged: () => latest.current.onChanged?.(),
    });
    publish();
  }, [id, key]);
  useEffect(
    () => () => {
      entries.delete(id);
      publish();
    },
    [id],
  );
}

/** The section in view: the first `data-assist` area whose heading is on the screen. */
function sectionInView(): string | undefined {
  const root = document.getElementById(SCROLL_ROOT_ID);
  if (!root) {
    return undefined;
  }
  const top = root.getBoundingClientRect().top;
  for (const el of root.querySelectorAll<HTMLElement>("[data-assist-section]")) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > top + 40 && rect.top < window.innerHeight * 0.6) {
      return el.dataset.assistSection || undefined;
    }
  }
  return undefined;
}

/** The page as the next message sends it. */
export function pageSnapshot(): AssistantPage {
  const {
    title: _title,
    hello: _hello,
    about: _about,
    placeholder: _placeholder,
    suggestions: _suggestions,
    compact: _compact,
    ownInput: _ownInput,
    onChanged: _onChanged,
    ...shown
  } = merged;
  const trail = currentCrumbs().map((c) => c.label);
  const path = window.location.pathname;
  const route = path.startsWith(STUDIO_ROOT) ? path.slice(STUDIO_ROOT.length) || "/" : path;
  const view = sectionInView();
  // Cut to what the runtime takes: a page that says too much still gets its answer.
  const cut = (text: string | undefined, max: number) =>
    text && text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return {
    route: `${route}${window.location.search}`.slice(0, 400),
    ...(trail.length ? { title: cut(trail.join(" / "), 200) } : {}),
    ...(view ? { view: cut(view, 200) } : {}),
    ...(shown.open
      ? {
          open: {
            kind: shown.open.kind.slice(0, 60),
            ...(shown.open.id ? { id: shown.open.id.slice(0, 120) } : {}),
            label: cut(shown.open.label, 200) ?? "",
          },
        }
      : {}),
    ...(shown.selection
      ? { selection: shown.selection.slice(0, 100).map((id) => id.slice(0, 120)) }
      : {}),
    ...(shown.summary ? { summary: cut(shown.summary, 2000) } : {}),
    ...(shown.fields
      ? {
          fields: shown.fields.slice(0, 60).map((f) => ({
            id: f.id.slice(0, 120),
            label: cut(f.label, 200) ?? "",
            value: f.value,
          })),
        }
      : {}),
    ...(shown.plugin ? { plugin: shown.plugin } : {}),
  };
}
