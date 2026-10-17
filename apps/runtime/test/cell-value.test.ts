import type { TableColumn } from "@engenty-wizards/shared/engenty/data-tables";
import { cellValue } from "@engenty-wizards/shared/store";
import { describe, expect, it } from "vitest";

const col = (c: Record<string, unknown>) => ({ id: "c", name: "C", ...c }) as unknown as TableColumn;

describe("cellValue", () => {
  it("sends a blank cell as null", () => {
    expect(cellValue(col({ type: "text" }), "  ")).toBeNull();
    expect(cellValue(col({ type: "number", format: {} }), "")).toBeNull();
  });

  it("reads numbers and durations as people write them", () => {
    expect(cellValue(col({ type: "number", format: {} }), "12,5")).toBe(12.5);
    expect(cellValue(col({ type: "number", format: {} }), "1234.50")).toBe(1234.5);
    expect(cellValue(col({ type: "duration", format: { inputUnit: "hours" } }), "1,5")).toBe(1.5);
  });

  it("leaves what is no number for the runtime to refuse", () => {
    expect(cellValue(col({ type: "number", format: {} }), "zwölf")).toBe("zwölf");
    expect(cellValue(col({ type: "number", format: {} }), "1.234,50")).toBe("1.234,50");
  });

  it("takes a checkbox's text as a boolean", () => {
    expect(cellValue(col({ type: "boolean" }), "true")).toBe(true);
    expect(cellValue(col({ type: "boolean" }), "false")).toBe(false);
  });

  it("sends a picked date and time as ISO, a day and a time as typed", () => {
    const at = cellValue(col({ type: "date", format: { kind: "datetime" } }), "2026-03-01T09:30");
    expect(at).toBe(new Date("2026-03-01T09:30").toISOString());
    expect(cellValue(col({ type: "date", format: { kind: "datetime" } }), "soon")).toBe("soon");
    expect(cellValue(col({ type: "date", format: { kind: "date" } }), "2026-03-01")).toBe(
      "2026-03-01",
    );
    expect(cellValue(col({ type: "date", format: { kind: "time" } }), "09:30")).toBe("09:30");
  });

  it("keeps text as typed", () => {
    expect(cellValue(col({ type: "text" }), " Notion ")).toBe(" Notion ");
  });
});
