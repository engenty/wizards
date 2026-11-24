import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SurfaceComponent } from "../surface.js";
import { SurfaceView } from "./surface.js";

const draw = (components: SurfaceComponent[], data: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <SurfaceView surface={{ components, data }} assetUrl={(id) => `/assets/${id}`} />,
  );

describe("SurfaceView", () => {
  it("draws text, rows and metrics bound to the data", () => {
    const html = draw(
      [
        { id: "root", component: "Column", children: ["title", "list", "budget"] },
        { id: "title", component: "Text", text: { path: "/title" }, variant: "h3" },
        { id: "list", component: "List", children: { path: "/days", componentId: "day" } },
        {
          id: "day",
          component: "Row",
          title: { path: "name" },
          meta: { path: "minutes", format: "{} min" },
        },
        {
          id: "budget",
          component: "Metric",
          label: "Spent",
          value: { calc: "spent / budget", as: "percent" },
        },
      ],
      {
        title: "Week plan",
        days: [
          { name: "Monday", minutes: 20 },
          { name: "Tuesday", minutes: 35 },
        ],
        spent: 30,
        budget: 120,
      },
    );
    expect(html).toContain("Week plan");
    expect(html).toContain("Monday");
    expect(html).toContain("35 min");
    expect(html).toContain("25%");
  });

  it("draws a chat's Form by the host", () => {
    const html = renderToStaticMarkup(
      <SurfaceView
        surface={{
          components: [
            { id: "root", component: "Form", children: ["f"], submit: "Send" },
            { id: "f", component: "Field", name: "note", kind: "text", label: "Note" },
          ],
          data: {},
        }}
        assetUrl={(id) => id}
        chat={{ href: () => null, form: (c) => <p>form {c.id}</p> }}
      />,
    );
    expect(html).toContain("form root");
  });
});
