// Where a search hit stands, shown once the item it opens has drawn: a table's row, a PDF's page,
// or the block of a page whose words the hit has. The page scrolls to it and it flashes. Found in
// what the page draws, so the editor, the tables and the viewers need not know the search.

import { SCROLL_ROOT_ID } from "../AppFrame";

export interface Place {
  /** A table's row: `tr[data-row]`. */
  rowId?: string | null;
  /** A file's page, opened in the viewer: `[data-page]`. */
  page?: number | null;
  /** Words of the hit's passage: the first block that has the most of them. */
  words?: string[];
}

/** How long the item may take to load and draw before the place is given up. */
const WAIT = 5000;
/** How long the page draws nothing before a block with some of the words counts. */
const QUIET = 400;
const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, dt, dd";

export const fold = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** Up to four words of a passage that find it again: long ones, without Markdown around them. */
export function wordsOf(text: string): string[] {
  return [...new Set((fold(text).match(/[\p{L}\p{N}]{4,}/gu) ?? []).slice(0, 4))];
}

/** The place, and whether it is sure: a row or a page, or a block with all the words. */
function find(root: HTMLElement, place: Place): { el: HTMLElement; sure: boolean } | null {
  const exact = place.rowId
    ? root.querySelector<HTMLElement>(`tr[data-row="${CSS.escape(place.rowId)}"]`)
    : place.page
      ? root.querySelector<HTMLElement>(`[data-page="${place.page}"]`)
      : null;
  if (exact || place.rowId || place.page) {
    return exact ? { el: exact, sure: true } : null;
  }
  const words = place.words ?? [];
  // The block with most of the words: a passage may run over a heading and its list. The menu
  // beside the page (`aside`) names items too.
  let best: HTMLElement | null = null;
  let most = Math.min(2, words.length) - 1;
  for (const el of root.querySelectorAll<HTMLElement>(BLOCKS)) {
    if (el.closest("aside")) {
      continue;
    }
    const text = fold(el.textContent ?? "");
    const has = words.filter((w) => text.includes(w)).length;
    if (has > most) {
      best = el;
      most = has;
      if (has === words.length) {
        break;
      }
    }
  }
  return best ? { el: best, sure: most === words.length } : null;
}

function flash(el: HTMLElement, block: ScrollLogicalPosition) {
  el.scrollIntoView({ block, behavior: "smooth" });
  el.classList.remove("reveal-flash");
  // A second flash of the same block starts the animation again.
  void el.offsetWidth;
  el.classList.add("reveal-flash");
  el.addEventListener("animationend", () => el.classList.remove("reveal-flash"), { once: true });
}

let watching: (() => void) | null = null;

/**
 * Waits for the place to be drawn, then scrolls to it and flashes it. A block with only some of
 * the words counts once the page has stopped drawing (QUIET). A new reveal ends the last.
 */
export function reveal(place: Place) {
  watching?.();
  const root = document.getElementById(SCROLL_ROOT_ID) ?? document.body;
  let frame = 0;
  let quiet = 0;
  const look = (settled: boolean) => {
    const found = find(root, place);
    if (found && (found.sure || settled)) {
      stop();
      // A PDF's page is taller than the frame: its top.
      flash(found.el, place.page ? "start" : "center");
    }
  };
  // Looks again whenever the page draws: the item loads, then its text.
  const observer = new MutationObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => look(false));
    clearTimeout(quiet);
    quiet = window.setTimeout(() => look(true), QUIET);
  });
  const timeout = setTimeout(() => stop(), WAIT);
  // The item already open draws nothing new.
  quiet = window.setTimeout(() => look(true), QUIET);
  const stop = () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(timeout);
    clearTimeout(quiet);
    watching = null;
  };
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  watching = stop;
}
