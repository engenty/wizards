import { describe, expect, it } from "vitest";
import { parseWizard } from "@engenty-wizards/shared/definition";
import { TableColumnValueError } from "@engenty-wizards/shared/engenty/data-tables";
import { firstRowAt, type ListDef, listAsMarkdown, newCells, patchCells, rowKey } from "@engenty-wizards/shared/store";

const providers: ListDef = {
  id: "providers",
  title: "Anbieter",
  key: "provider",
  columns: [
    { id: "provider", name: "Anbieter", type: "text", required: true },
    { id: "amount", name: "Betrag", type: "number", format: { style: "currency", currency: "EUR" } },
    { id: "last", name: "Zuletzt", type: "date", format: { kind: "date" } },
    { id: "path", name: "Weg", type: "text", format: { style: "multiline" } },
  ],
};

describe("when a row is saved", () => {
  it("stands after every row the list holds, even within one millisecond", () => {
    const now = Date.now();
    expect(firstRowAt([])).toBeGreaterThanOrEqual(now);
    // A row saved this very millisecond (or stamped ahead): the next one comes after it.
    expect(firstRowAt([{ createdAt: new Date(now + 5) }, { createdAt: new Date(now - 9) }])).toBe(now + 6);
  });
});

describe("list rows", () => {
  it("types cells by column and refuses a bad value", () => {
    expect(newCells(providers, { provider: "Notion", amount: "96", last: "2026-09-03" })).toEqual({
      provider: "Notion",
      amount: 96,
      last: "2026-09-03",
      path: null,
    });
    expect(() => newCells(providers, { provider: "Notion", last: "3.9.2026" })).toThrow(
      TableColumnValueError,
    );
    expect(() => newCells(providers, { amount: 5 })).toThrow(/required/);
    expect(() => newCells(providers, { provider: "x", iban: "AT…" })).toThrow(/unknown column/);
  });

  it("matches rows on the key column whatever the spelling", () => {
    expect(rowKey(providers, { provider: " Notion " })).toBe("notion");
    expect(rowKey(providers, { provider: "" })).toBeNull();
    expect(rowKey({ ...providers, key: undefined }, { provider: "Notion" })).toBeNull();
  });

  it("changes only the cells a patch names and drops cells of removed columns", () => {
    const current = { provider: "Notion", amount: 96, last: "2026-08-03", path: "Mail", old: "x" };
    expect(patchCells(providers, current, { last: "2026-09-03" })).toEqual({
      provider: "Notion",
      amount: 96,
      last: "2026-09-03",
      path: "Mail",
    });
  });

  it("reads as a Markdown table of raw values", () => {
    const text = listAsMarkdown(providers, [
      { id: "1", cells: { provider: "Notion", amount: 96, last: "2026-09-03" }, updatedAt: "" },
    ]);
    expect(text).toContain("| provider | amount | last | path |");
    expect(text).toContain("| Notion | 96 | 2026-09-03 |  |");
    expect(listAsMarkdown(providers, [])).toBe("(empty)");
  });
});

const wizard = {
  title: "Rechnungen",
  lists: [providers],
  connections: [{ id: "mailbox", kind: "mail" }],
  steps: [
    {
      id: "start",
      type: "page",
      title: "Start",
      fields: [
        { id: "mail", label: "Postfach", kind: "connection", connection: "mailbox", required: true },
        { id: "known", label: "Anbieter", kind: "list", list: "providers" },
        { id: "docs", label: "Auszüge", kind: "file", multiple: true, camera: true },
      ],
    },
    {
      id: "collect",
      type: "agent",
      title: "Sammeln",
      instructions: "Bekannt: {{lists.providers}}. Dateien: {{docs}}",
      connections: ["mailbox"],
      tools: ["browser"],
      output: { format: "json" },
    },
    { id: "check", type: "review", title: "Prüfen", show: ["collect", "lists.providers"] },
    {
      id: "done",
      type: "result",
      title: "Fertig",
      deliverables: [
        { from: "collect", formats: ["zip", "xlsx"] },
        { from: "lists.providers", formats: ["xlsx"] },
      ],
    },
  ],
};

describe("lists and connections in a wizard", () => {
  it("accepts a wizard that keeps a list and reads a mailbox", () => {
    const parsed = parseWizard(wizard);
    expect(parsed.ok && parsed.issues).toEqual([]);
  });

  it("names what a reference points at when it is missing", () => {
    const broken = structuredClone(wizard) as any;
    broken.steps[0].fields[0].connection = "bank";
    broken.steps[0].fields[1].list = "customers";
    broken.steps[1].instructions = "{{lists.customers}}";
    broken.steps[1].connections = ["bank"];
    broken.steps[3].deliverables[1].from = "lists.customers";
    broken.lists[0].key = "name";
    const parsed = parseWizard(broken);
    const messages = parsed.ok ? parsed.issues.map((i) => i.message).join("\n") : "";
    expect(messages).toContain('key "name" is not one of its columns');
    expect(messages).toContain('Field "mail" needs "connection"');
    expect(messages).toContain('Field "known" needs "list"');
    expect(messages).toContain("refers to an unknown list");
    expect(messages).toContain('unknown connection "bank"');
    expect(messages).toContain('Deliverable from unknown list "lists.customers"');
  });

  it("takes a connection to an imported connector, with its actions and policy", () => {
    const withConnector = structuredClone(wizard) as any;
    withConnector.connections.push({
      id: "notion",
      connector: "notion-mcp",
      actions: ["search", "create_pages"],
      policy: { search: "allow" },
    });
    const parsed = parseWizard(withConnector);
    expect(parsed.ok && parsed.issues).toEqual([]);

    withConnector.connections.push({ id: "both", kind: "mail", connector: "notion-mcp" });
    withConnector.connections.push({ id: "neither" });
    const broken = parseWizard(withConnector);
    const messages = broken.ok ? broken.issues.map((i) => i.message) : [];
    expect(messages).toContain('Connection "both" needs either "kind" or "connector", not both.');
    expect(messages).toContain('Connection "neither" needs either "kind" or "connector", not both.');
  });

  it("refuses a list column the data-table schema does not know", () => {
    const broken = structuredClone(wizard) as any;
    broken.lists[0].columns[1] = { id: "amount", name: "Betrag", type: "number" };
    expect(parseWizard(broken).ok).toBe(false);
  });
});
