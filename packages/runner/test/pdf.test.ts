import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileName, jsonContent, markdownContent, pdfDocument, ROBOTO } from "../src/pdf";

type Runs = { text: { text: string }[]; style?: string };

describe("a written output as pdfmake content", () => {
  it("maps Markdown: headings, runs with bold and links, lists, tables, code", () => {
    const content = markdownContent(
      [
        "## Einschätzung",
        "",
        "Ein **fetter** Satz mit [Link](https://x.test) &amp; mehr.",
        "",
        "- eins",
        "- zwei",
        "",
        "1. a",
        "2. b",
        "",
        "| Pos | Preis |",
        "|---|---:|",
        "| Fenster | 1.200 € |",
        "",
        "```",
        "code",
        "```",
      ].join("\n"),
    );
    expect(content[0]).toEqual({ style: "h2", text: [{ text: "Einschätzung" }] });
    expect((content[1] as Runs).style).toBe("p");
    expect((content[1] as Runs).text).toEqual([
      { text: "Ein " },
      { text: "fetter", bold: true },
      { text: " Satz mit " },
      { text: "Link", link: "https://x.test", color: "#1a5fb4", decoration: "underline" },
      { text: " & mehr." },
    ]);
    expect(content[2]).toEqual({
      ul: [{ text: [{ text: "eins" }] }, { text: [{ text: "zwei" }] }],
      style: "list",
    });
    expect(content[3]).toMatchObject({ ol: [{ text: [{ text: "a" }] }, { text: [{ text: "b" }] }], start: 1 });
    const table = content[4] as { table: { body: unknown[][]; widths: string[] } };
    expect(table.table.widths).toEqual(["*", "*"]);
    expect(table.table.body[0][0]).toEqual({ text: [{ text: "Pos" }], alignment: "left", style: "th" });
    expect(table.table.body[1][1]).toEqual({ text: [{ text: "1.200 €" }], alignment: "right" });
    expect(content[5]).toEqual({ text: "code", style: "code", preserveLeadingSpaces: true });
  });

  it("writes a plain text as one paragraph, and raw HTML as its text", () => {
    expect(markdownContent("Nur ein Satz.")).toEqual([{ text: [{ text: "Nur ein Satz." }], style: "p" }]);
    expect(markdownContent("<div>Im <b>Tag</b></div>")).toEqual([{ text: "Im Tag", style: "p" }]);
  });

  it("lays a structured output out as the result page does: label, value, list, table", () => {
    const content = jsonContent(
      {
        ok: true,
        note: "Hallo\nWelt",
        tags: ["a", "b"],
        rows: [{ pos: "Fenster", preis: 1200 }, { pos: "Tür" }],
      },
      (key) => (key === "rows" ? "Positionen" : key),
    );
    expect(content[0]).toEqual({ text: "ok", style: "label" });
    expect(content[1]).toEqual({ text: "Yes", style: "p" });
    expect(content[3]).toEqual({ text: "Hallo\nWelt", style: "p" });
    expect(content[5]).toEqual({ ul: ["a", "b"], style: "list" });
    expect(content[6]).toEqual({ text: "Positionen", style: "label" });
    const table = content[7] as { table: { body: unknown[][] } };
    expect(table.table.body[0]).toEqual([
      { text: "pos", style: "th" },
      { text: "preis", style: "th" },
    ]);
    expect(table.table.body[2]).toEqual([{ text: "Tür" }, { text: "" }]);
    expect(jsonContent("just text")).toEqual([{ text: '"just text"', style: "code" }]);
  });

  it("puts the title first and the wizard with the page number at the foot", () => {
    const doc = pdfDocument({ title: "Angebot", text: "Hallo", foot: "Was kostet das? · 11.10.2026" });
    expect(doc.info).toEqual({ title: "Angebot" });
    expect((doc.content as unknown[])[0]).toEqual({ text: "Angebot", style: "title" });
    const footer = (doc.footer as (page: number, pages: number) => { columns: { text: string }[] })(2, 5);
    expect(footer.columns[0].text).toBe("Was kostet das? · 11.10.2026");
    expect(footer.columns[1].text).toBe("2 / 5");
    expect(doc.defaultStyle?.font).toBe("Roboto");
  });

  it("names the file after the title, without what a file system refuses", () => {
    expect(fileName("Angebot: Fenster/Türen?")).toBe("Angebot- Fenster-Türen-");
    expect(fileName("  ")).toBe("result");
  });

  it("renders through pdfmake with Roboto, umlauts and Czech included", async () => {
    // The server build of the same library, the fonts as files: what the browser build does
    // with the same document and its virtual file system.
    const pdfMake = (await import("pdfmake")).default as unknown as {
      addFonts(fonts: Record<string, Record<string, string>>): void;
      createPdf(doc: unknown): { getBuffer(): Promise<Buffer> };
    };
    const vfs = (await import("pdfmake/build/vfs_fonts")).default as unknown as Record<
      string,
      string
    >;
    const dir = mkdtempSync(join(tmpdir(), "wizards-pdf-"));
    const cuts = Object.entries(ROBOTO.Roboto).map(([cut, name]) => {
      writeFileSync(join(dir, name), Buffer.from(vfs[name], "base64"));
      return [cut, join(dir, name)];
    });
    pdfMake.addFonts({ Roboto: Object.fromEntries(cuts) });
    const doc = pdfDocument({
      title: "Test",
      text: "# Überschrift\n\nÄöü ß ř ł — ein **Satz**.\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      foot: "Wizard · heute",
    });
    const buffer = await pdfMake.createPdf(doc).getBuffer();
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(10_000);
  });
});
