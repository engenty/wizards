import { describe, expect, it } from "vitest";
import { bound, validateSurface } from "./surface.js";

describe("surface", () => {
  it("reads a prop from the data, the row and a calculation", () => {
    const data = { title: "Plan", spent: 30, budget: 120 };
    expect(bound({ path: "/title" }, data)).toBe("Plan");
    expect(bound({ path: "name" }, data, { name: "Monday" })).toBe("Monday");
    expect(bound({ path: "minutes", format: "{} min" }, data, { minutes: 20 })).toBe("20 min");
    expect(bound({ calc: "spent / budget", as: "percent" }, data, undefined, "en")).toBe("25%");
    expect(bound({ path: "ok", map: { true: "yes" } }, data, { ok: true })).toBe("yes");
  });

  it("finds what is wrong with a surface", () => {
    expect(
      validateSurface([
        { id: "root", component: "Column", children: ["t"] },
        { id: "t", component: "Text", text: "Hello" },
      ]),
    ).toEqual([]);
    const issues = validateSurface([{ id: "root", component: "Column", children: ["gone"] }]);
    expect(issues.map((i) => i.message).join(" ")).toContain('"gone"');
  });
});
