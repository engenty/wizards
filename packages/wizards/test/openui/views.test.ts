import { createParser } from "@openuidev/lang-core";
import { describe, expect, it } from "vitest";
import { wizardsChatLibrarySpec } from "../../src/openui/server.js";

describe("wizardsChatLibrarySpec", () => {
  it("is engenty's views with the Wizard among them", () => {
    const prompt = wizardsChatLibrarySpec.prompt();
    for (const name of ["Wizard(", "Metric(", "Form(", "@Format"]) {
      expect(prompt).toContain(name);
    }
    const parser = createParser(wizardsChatLibrarySpec.toJSONSchema(), wizardsChatLibrarySpec.root);
    const parsed = parser.parse(
      'root = Column([note, w])\nnote = Text("Your offer, step by step")\nw = Wizard("abc123")',
    );
    expect(parsed.meta.errors).toEqual([]);
    expect(JSON.stringify(parsed.root)).toContain('"typeName":"Wizard"');
  });
});
