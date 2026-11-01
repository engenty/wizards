// The block editor's round trip, as peer-it's docs app checks it (docs-ui/scripts/round-trip.ts):
// every page under fixtures/ (pages of engrd.at as Wissen reads a website) is opened the way the
// block editor opens it and written back.
// - unchanged: a save without edits gives the same text, byte for byte;
// - written: how many blocks the editor can show come back as their source when written anew
//   (the rest render the same, in the editor's style);
// - edited: a word typed into a block changes only the lines of that block.
// ROUND_TRIP_DIR=<folder of .md> runs it over more pages (pages exported from a space) and prints
// the numbers: `ROUND_TRIP_DIR=… pnpm --filter @engenty/wizards-studio exec vitest run blocks`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { type Json, parseMarkdown, serializeBlock, toMarkdown } from "./markdown";
import { blockExtensions } from "./schema";

const schema = getSchema(blockExtensions());

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? pages(p) : name.endsWith(".md") ? [p] : [];
  });
}

/** The page as the editor holds it: parsed, then through the schema. */
function open(text: string) {
  const parsed = parseMarkdown(text);
  const nodes: Json[] = [];
  schema.nodeFromJSON(parsed.doc).forEach((n) => {
    nodes.push(n.toJSON() as Json);
  });
  return { parsed, nodes, source: { parsed, keys: nodes.map((n) => JSON.stringify(n)) } };
}

/** Lines that differ once the lines both texts start and end with are taken off. */
function changedLines(a: string, b: string): number {
  const x = a.split("\n");
  const y = b.split("\n");
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) {
    start++;
  }
  let end = 0;
  while (
    end < x.length - start &&
    end < y.length - start &&
    x[x.length - 1 - end] === y[y.length - 1 - end]
  ) {
    end++;
  }
  return x.length - start - end + (y.length - start - end);
}

/** " edited" after the first text outside code and links; null for a block with none. */
function typeInto(node: Json): Json | null {
  if (node.type === "rawMarkdown" || node.type === "codeBlock") {
    return null;
  }
  let done = false;
  const walk = (n: Json): Json => {
    if (done) {
      return n;
    }
    if (n.type === "text" && !n.marks?.some((m) => m.type === "code" || m.type === "link")) {
      done = true;
      return { ...n, text: `${n.text} edited` };
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  const out = walk(node);
  return done ? schema.nodeFromJSON(out).toJSON() : null;
}

function roundTrip(text: string) {
  const { parsed, nodes, source } = open(text);
  let raw = 0;
  let same = 0;
  let worst = 0;
  let lines = 0;
  let edits = 0;
  const notSame: string[] = [];
  nodes.forEach((node, i) => {
    const src = parsed.blocks[i]?.raw ?? "";
    if (node.type === "rawMarkdown") {
      raw++;
      return;
    }
    if (serializeBlock(node) === src) {
      same++;
    } else {
      notSame.push(src);
    }
    // Long pages get a word typed into 60 of their blocks, spread over the page.
    const step = Math.max(1, Math.ceil(nodes.length / 60));
    const edited = i % step === 0 ? typeInto(node) : null;
    if (edited) {
      const next = toMarkdown(
        nodes.map((n, j) => (j === i ? edited : n)),
        source,
      );
      // An edited block may be written in the editor's style: its own lines change, no others.
      const n = changedLines(text, next);
      edits++;
      lines += n;
      worst = Math.max(worst, n - 2 * src.split("\n").length);
    }
  });
  return {
    saved: toMarkdown(nodes, source),
    blocks: nodes.length,
    raw,
    same,
    notSame,
    edits,
    lines,
    worst,
  };
}

const fixtures = pages(join(import.meta.dirname, "fixtures"));

describe("the block editor's round trip", () => {
  it.each(fixtures.map((f) => [f.split("/").pop(), f]))("%s", (_, file) => {
    const text = readFileSync(file as string, "utf8");
    const r = roundTrip(text);
    expect(r.saved).toBe(text);
    // Most blocks show as blocks; an edit changes no line outside its block.
    expect(r.raw).toBeLessThan(r.blocks / 2);
    expect(r.worst).toBeLessThanOrEqual(0);
  });

  it("keeps Windows line breaks and the blank lines between blocks", () => {
    const text = "# Title\r\n\r\n\r\nText\r\n- a\r\n- b\r\n";
    expect(roundTrip(text).saved).toBe(text);
  });

  it("keeps what it can't show as Markdown blocks", () => {
    const text =
      "---\ntitle: x\n---\n\n<div>html</div>\n\n- [ ] task\n- item\n\nText[^1]\n\n[^1]: note\n";
    const { nodes } = open(text);
    expect(nodes.map((n) => n.type)).toEqual([
      "rawMarkdown",
      "rawMarkdown",
      "rawMarkdown",
      "paragraph",
      "rawMarkdown",
    ]);
    expect(roundTrip(text).saved).toBe(text);
  });

  it("changes only the edited line of a hard-wrapped paragraph", () => {
    const text = "One line\nand another\nand a third.\n\nNext.\n";
    const { nodes, source } = open(text);
    const p = nodes[0] as Json;
    const content = (p.content ?? []).map((n, i) => (i === 2 ? { ...n, text: "and one more" } : n));
    const next = toMarkdown([{ ...p, content }, ...nodes.slice(1)], source);
    expect(next).toBe("One line\nand one more\nand a third.\n\nNext.\n");
  });

  it("writes a new block in the editor's style between untouched ones", () => {
    const text = "* a\n* b\n\nText\n";
    const { nodes, source } = open(text);
    const added: Json = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
            },
          ],
        },
      ],
    };
    const next = toMarkdown(
      [nodes[0] as Json, schema.nodeFromJSON(added).toJSON(), nodes[1] as Json],
      source,
    );
    expect(next).toBe("* a\n* b\n\n| A |\n| --- |\n| 1 |\n\nText\n");
  });

  it("keeps a link to a table of Wissen alone on its line", () => {
    const text = "Prices:\n\n[Preise 2026](tables/preise-2026)\n";
    const { nodes } = open(text);
    expect(nodes[1]?.content?.[0]?.marks?.[0]).toEqual({
      type: "link",
      attrs: expect.objectContaining({ href: "tables/preise-2026" }),
    });
    expect(roundTrip(text).saved).toBe(text);
  });
});

const more = process.env.ROUND_TRIP_DIR;
describe.runIf(more)("pages from ROUND_TRIP_DIR", () => {
  it("open and save without a change", () => {
    const files = pages(more as string);
    const totals = {
      files: files.length,
      changed: 0,
      blocks: 0,
      raw: 0,
      same: 0,
      edits: 0,
      lines: 0,
      worst: 0,
    };
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const r = roundTrip(text);
      if (r.saved !== text) {
        totals.changed++;
        console.log(`changed on save: ${file}`);
      }
      totals.blocks += r.blocks;
      totals.raw += r.raw;
      totals.same += r.same;
      totals.edits += r.edits;
      totals.lines += r.lines;
      totals.worst = Math.max(totals.worst, r.worst);
    }
    console.log(totals);
    expect(totals.changed).toBe(0);
  }, 600_000);
});
