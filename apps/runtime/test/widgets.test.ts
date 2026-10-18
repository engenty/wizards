import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseWizard } from "@engenty/wizards-shared/definition";
import { cleanPath, mimeForPath, type WorkspaceFile } from "@engenty/wizards-shared/workspace";

// The blob store lives under DATA_DIR; keep the tests out of the real one.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-test-"));

let putBlob: (data: Uint8Array) => Promise<string>;
let bundleWidget: typeof import("../src/widgets/bundle").bundleWidget;
let inTenant: typeof import("../src/tenants/tenant").inTenant;

beforeAll(async () => {
  ({ putBlob } = await import("../src/files/blobs"));
  ({ bundleWidget } = await import("../src/widgets/bundle"));
  ({ inTenant } = await import("../src/tenants/tenant"));
});

async function file(path: string, content: string): Promise<WorkspaceFile> {
  const data = Buffer.from(content, "utf8");
  return { path, hash: await putBlob(data), mime: mimeForPath(path), size: data.byteLength };
}

describe("workspace paths", () => {
  it("accepts relative paths and refuses escapes", () => {
    expect(cleanPath("weather/index.html")).toBe("weather/index.html");
    expect(cleanPath("./lib/d3.min.js")).toBe("lib/d3.min.js");
    expect(cleanPath("../secret")).toBeNull();
    expect(cleanPath("a/../../b")).toBeNull();
    expect(cleanPath(".env")).toBeNull();
    expect(cleanPath("a//b")).toBeNull();
  });
});

const widgetWizard = {
  title: "Wetter",
  steps: [
    { id: "start", type: "page", title: "See", fields: [{ id: "lake", label: "See", kind: "text" }] },
    {
      id: "forecast",
      type: "agent",
      title: "Prognose",
      instructions: "Wetter für {{lake}}",
      tools: [],
      output: { format: "json", fields: [{ id: "hours", kind: "table", columns: ["time", "wind"] }] },
    },
    {
      id: "map",
      type: "widget",
      title: "Karte",
      entry: "map/index.html",
      data: { lake: "lake", hours: "steps.forecast.hours" },
      sample: "map/sample.json",
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [{ from: "map", formats: ["html", "mp4"] }] },
  ],
};

describe("widget steps", () => {
  it("are valid when their files exist", () => {
    const parsed = parseWizard(widgetWizard, ["map/index.html", "map/sample.json"]);
    expect(parsed.ok && parsed.issues).toEqual([]);
  });

  it("report a missing entry and an unknown data source", () => {
    const def = structuredClone(widgetWizard);
    (def.steps[2] as { data: Record<string, string> }).data.extra = "steps.later";
    const parsed = parseWizard(def, []);
    const text = parsed.ok ? parsed.issues.map((i) => i.message).join("\n") : "";
    expect(text).toContain('Widget entry "map/index.html" is not in the workspace');
    expect(text).toContain("steps.later");
  });
});

describe("bundleWidget", () => {
  it("inlines scripts, styles and images and carries the data safely", () =>
    inTenant("local", async () => {
    const files = [
      await file(
        "map/index.html",
        `<!doctype html><html><head><link rel="stylesheet" href="style.css"><script src="../lib/tiny.js"></script></head>
<body><img src="pin.svg"><div id="app"></div><script>document.getElementById("app").textContent = wizard.data.lake;</script></body></html>`,
      ),
      await file("map/style.css", "body{background:url(pin.svg)}"),
      await file("map/pin.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'),
      await file("lib/tiny.js", "window.tiny = 1; // </script> inside code"),
      await file("lakes/attersee.json", '{"type":"Polygon"}'),
    ];
    const html = await bundleWidget({
      entry: "map/index.html",
      files,
      data: { lake: "</script><script>alert(1)</script>" },
      brand: { name: "Test", accent: null, logo: null },
    });
    // The network lock comes first in <head>, before any script.
    const head = html.slice(html.indexOf("<head>"));
    expect(head.indexOf("Content-Security-Policy")).toBeLessThan(head.indexOf("<script"));
    expect(html).not.toContain('src="../lib/tiny.js"');
    expect(html).toContain("window.tiny = 1; // <\\/script> inside code");
    expect(html).not.toContain('href="style.css"');
    expect(html).toContain("background:url(\"data:image/svg+xml;base64,");
    expect(html).toContain('<img src="data:image/svg+xml;base64,');
    // Data cannot close the payload script.
    expect(html).not.toContain("</script><script>alert(1)");
    // Files the HTML did not inline stay readable through wizard.file().
    expect(html).toContain("lakes/attersee.json");
    }));
});
