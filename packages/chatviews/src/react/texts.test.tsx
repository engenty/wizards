import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SurfaceView } from "./surface.js";
import { configureViews } from "./texts.js";

// Its own file: the words a host hands in stay for the module's life.
it("says its words through the host", () => {
  configureViews({ text: (key) => `[${key}]`, lang: () => "de" });
  const html = renderToStaticMarkup(
    <SurfaceView
      surface={{
        components: [{ id: "root", component: "Checklist", items: ["a", "b"] }],
        data: {},
      }}
      assetUrl={(id) => id}
    />,
  );
  expect(html).toContain("[surface.done]");
});
