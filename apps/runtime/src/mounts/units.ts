/**
 * A mounted file's text in passages that say where they stand in it: its headings, the page of
 * the original, and the characters from `start` to `end`. The text itself is not kept (decision
 * D3): the words go into a contentless index once, and a snippet or a vector reads the passage
 * from the original again by its place. Cut as Wissen's pages are (space-index.ts): at headings,
 * a long section at its paragraphs.
 */

export interface TextUnit {
  heading: string | null;
  sheet: number | null;
  start: number;
  end: number;
}

/** A passage longer than this is cut at paragraphs into parts about PART_CHARS long. */
const SECTION_CHARS = 2400;
const PART_CHARS = 1800;
/** Passages of one file; a longer one keeps its start. */
export const MAX_TEXT_UNITS = 2000;

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
/** A page's start: Wissen's mark, or the converter's page break. */
const SHEET = /^\s*(?:<!--\s*S\.\s*(\d+)\s*-->|<page-break number="(\d+)"[^>]*><\/page-break>)\s*$/;

/** The parts of [start, end) of `text`, cut at blank lines, none much longer than PART_CHARS. */
function parts(text: string, start: number, end: number): [number, number][] {
  if (end - start <= SECTION_CHARS) {
    return [[start, end]];
  }
  const out: [number, number][] = [];
  let from = start;
  const blank = /\n\s*\n/g;
  blank.lastIndex = start;
  let cut = start;
  for (let m = blank.exec(text); m && m.index < end; m = blank.exec(text)) {
    if (m.index - from > PART_CHARS && cut > from) {
      out.push([from, cut]);
      from = cut;
    }
    cut = m.index + m[0].length;
  }
  // What has no blank line to cut at is cut at the length.
  while (end - from > SECTION_CHARS) {
    out.push([from, from + PART_CHARS]);
    from += PART_CHARS;
  }
  out.push([from, end]);
  return out;
}

export function textUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  const stack: { level: number; text: string }[] = [];
  let sheet: number | null = null;
  let heading: string | null = null;
  let sectionSheet: number | null = null;
  let start = 0;
  let fence = false;
  const close = (end: number) => {
    if (text.slice(start, end).trim()) {
      for (const [s, e] of parts(text, start, end)) {
        if (text.slice(s, e).trim()) {
          units.push({ heading, sheet: sectionSheet, start: s, end: e });
        }
      }
    }
  };
  let at = 0;
  for (const line of text.split("\n")) {
    const lineEnd = at + line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
    }
    const mark = fence ? null : SHEET.exec(line);
    const h = fence || mark ? null : HEADING.exec(line);
    if (mark) {
      sheet = Number(mark[1] ?? mark[2]);
      if (!text.slice(start, at).trim()) {
        sectionSheet = sheet;
      }
    } else if (h) {
      close(at);
      const level = h[1].length;
      while (stack.length && (stack.at(-1) as { level: number }).level >= level) {
        stack.pop();
      }
      stack.push({ level, text: h[2].trim() });
      heading = stack.map((s) => s.text).join(" › ");
      sectionSheet = sheet;
      start = lineEnd;
    }
    at = lineEnd;
  }
  close(text.length);
  return units.slice(0, MAX_TEXT_UNITS);
}

/** A passage's text, as its words were indexed and its vector made. */
export function unitText(text: string, unit: Pick<TextUnit, "heading" | "start" | "end">): string {
  const body = text
    .slice(unit.start, unit.end)
    .replace(/<page-break[^>]*><\/page-break>/g, "")
    .trim();
  return unit.heading ? `## ${unit.heading}\n\n${body}` : body;
}

/** A path in the mount as the words that find it: `Kunden › A1 › angebot.pdf`. */
export const pathWords = (path: string) => path.split("/").join(" › ");
