import { kernelShell } from "@engenty/wizards-shared/kernel-file";
import { capabilitiesOf, costTierOf, effortOf } from "@engenty/wizards-shared/marketplace";
import { describe, expect, it } from "vitest";
import { kernelCatalog } from "../src/kernel/catalog.js";

/**
 * A template in version 0.3.0 as its page shows it: what it needs and about how long it takes, read
 * from its file, and its steps and their asks, read from its step files.
 */
const definition = kernelShell({
  version: "0.3.0",
  title: "Post with a picture",
  description: "",
  avatar: "round",
  requires: { models: ["low", "image"], tools: ["web_search"] },
  input: {
    fields: [
      { id: "topic", label: "Topic", kind: "text", required: true },
      { id: "photo", label: "Photo", kind: "image" },
    ],
  },
  start: "post",
  edges: { post: ["visual", "check"], visual: ["check"], check: ["end", "post"] },
} as never);

const files = {
  "steps/post.ts": `/**
 * Write the post
 */
export default async (run, ask) => ({ value: await ask({ type: "agent", model: "low", instructions: "Write a post about " + run.input.topic, tools: ["web_search"] }) });
`,
  "steps/visual.ts": `/**
 * Draw the picture
 */
export default async (run, ask) => ({ value: await ask({ type: "generate", asset: "image", prompt: "A picture" }) });
`,
  "steps/check.ts": `export default async (run, ask) => ({ value: await ask({ type: "review", show: ["post", "visual"], approve: true }) });
`,
};

describe("a template in version 0.3.0", () => {
  it("needs what its file declares, and takes about as long", () => {
    const capabilities = capabilitiesOf(definition);
    expect(capabilities).toEqual(expect.arrayContaining(["text", "image", "web", "documents"]));
    expect(costTierOf(capabilities)).toBe("medium");
    expect(effortOf(definition)).toEqual({ fields: 2, required: 1, reviews: 0, minutes: 3 });
  });

  it("shows its steps in the order of the map, with their titles and ways", async () => {
    const { outline } = await kernelCatalog(definition, files);
    expect(outline.map((s) => [s.id, s.type, s.title])).toEqual([
      ["post", "agent", "Write the post"],
      ["visual", "generate", "Draw the picture"],
      ["check", "review", "check"],
    ]);
    expect(outline[0].branches).toEqual([{ to: "check", when: "" }]);
    expect(outline[1].asset).toBe("image");
  });

  it("prices the asks a model answers as the steps they stand for", async () => {
    const { priced } = await kernelCatalog(definition, files);
    expect(priced.steps.map((s) => [s.type, (s as { model?: string }).model ?? (s as { asset?: string }).asset])).toEqual([
      ["agent", "low"],
      ["generate", "image"],
    ]);
  });
});
