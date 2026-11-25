import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fieldFilled, ViewRenderer } from "./chat.js";

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

describe("a Field of a Form", () => {
  it("that must be answered is sent only when it holds something", () => {
    expect(fieldFilled({ required: true, value: undefined })).toBe(false);
    expect(fieldFilled({ required: true, value: "" })).toBe(false);
    expect(fieldFilled({ required: true, value: [] })).toBe(false);
    expect(fieldFilled({ required: true, value: "Monday" })).toBe(true);
    expect(fieldFilled({ required: true, value: false })).toBe(true);
    expect(fieldFilled({ required: false, value: undefined })).toBe(true);
  });
});
