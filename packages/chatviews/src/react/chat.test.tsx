import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewRenderer } from "./chat.js";

const draw = (program: string) =>
  renderToStaticMarkup(<ViewRenderer program={program} host={{ assetUrl: (id) => `/f/${id}` }} />);

describe("ViewRenderer", () => {
  it("draws a program with the catalog's components", () => {
    const html = draw(
      [
        "root = Column([title, figures, days])",
        'title = Text("Next week", "h3")',
        "figures = Grid([open], 2)",
        'open = Metric("Open", @Format(0.25, "{}", "percent"))',
        "days = List([mon])",
        'mon = Row("Monday", "Site visit", @Map(true, {"true": "booked"}))',
      ].join("\n"),
    );
    expect(html).toContain("Next week");
    expect(html).toContain("25%");
    expect(html).toContain("Monday");
    expect(html).toContain("booked");
  });

  it("draws a Form with its Fields", () => {
    const html = draw(
      [
        "root = Column([form])",
        'form = Form([note], "Send", "A question")',
        'note = Field("note", "textarea", "Your note", true)',
      ].join("\n"),
    );
    expect(html).toContain("A question");
    expect(html).toContain("Your note");
    expect(html).toContain("Send");
  });
});
