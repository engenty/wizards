import { PROVIDERS as SOURCES } from "@engenty/model-sources/providers";
import { PROVIDERS } from "@engenty/wizards-shared/providers";
import { describe, expect, it } from "vitest";

// The studio's list of providers (classes, models per capability, texts) and the list of
// @engenty/model-sources (who a provider is, its key) name the same providers the same way. The
// shared package does not import the other: the portal and the runner install it, and need no
// model.
describe("the providers the studio offers", () => {
  it("are named, and get their key, as @engenty/model-sources says", () => {
    for (const provider of PROVIDERS) {
      const source = SOURCES[provider.id];
      expect({
        id: provider.id,
        name: provider.name,
        keyUrl: provider.keyUrl,
        keyPlaceholder: provider.keyPlaceholder,
      }).toEqual({
        id: source.id,
        name: source.name,
        keyUrl: source.keyUrl,
        keyPlaceholder: source.keyPlaceholder,
      });
    }
  });

  it("run the Standard class on the model the package asks first", () => {
    for (const provider of PROVIDERS) {
      const first = SOURCES[provider.id].model;
      // The AI Gateway's models are bound without a provider in front.
      const bound = first && (provider.id === "gateway" ? first : `${provider.id}:${first}`);
      expect(provider.text?.standard).toBe(bound);
    }
  });
});
