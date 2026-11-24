import { describe, expect, it } from "vitest";
import { checkView } from "./check.js";
import { chatViewPrompt } from "./library.js";

const view = (...lines: string[]) => lines.join("\n");

describe("checkView", () => {
  it("takes a view of the catalog", () => {
    const check = checkView(
      view(
        "root = Column([title, days])",
        'title = Text("Next week", "h3")',
        "days = List([mon])",
        'mon = Row("Monday", "Site visit", "9:00")',
      ),
    );
    expect(check.issues).toEqual([]);
    expect(check.asks).toBe(false);
  });

  it("knows a view that asks", () => {
    const form = checkView(
      view(
        "root = Column([form])",
        'form = Form([when], "Send")',
        'when = Field("when", "date", "When?", true)',
      ),
    );
    expect(form.issues).toEqual([]);
    expect(form.asks).toBe(true);
    const ask = checkView(
      view("root = Column([b])", 'b = Button("Plan it", @ToAssistant("Plan Wednesday"))'),
    );
    expect(ask.issues).toEqual([]);
    expect(ask.asks).toBe(true);
  });

  it("refuses what the parser would drop", () => {
    expect(checkView('root = Column([a])\na = Nope("x")').issues.length).toBeGreaterThan(0);
    expect(checkView('root = Column([a, b])\na = Text("x")').issues).toContain(
      '"b" is used but never defined.',
    );
    expect(checkView('root = Column([])\nlost = Text("x")').issues[0]).toContain('"lost"');
  });

  it("refuses tools, state and addresses on the web", () => {
    expect(checkView('root = Column([])\nq = Query("get_users", {})').issues.join(" ")).toContain(
      "Query",
    );
    expect(checkView('$n = 1\nroot = Column([t])\nt = Text("x")').issues.join(" ")).toContain(
      "$variables",
    );
    expect(
      checkView('root = Column([i])\ni = Image("https://example.com/a.png")').issues.join(" "),
    ).toContain("never an address on the web");
  });

  it("refuses a view that is too large", () => {
    expect(checkView(`root = Column([t])\nt = Text("${"x".repeat(70_000)}")`).issues[0]).toContain(
      "bytes",
    );
  });
});

describe("chatViewPrompt", () => {
  it("names every component and the rules", () => {
    const prompt = chatViewPrompt("You show views.");
    for (const name of ["Column", "Metric", "Form", "Field", "@Format", "@Map", "@Open"]) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain("never an address on the web");
  });
});
