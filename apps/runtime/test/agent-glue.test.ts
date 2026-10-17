import { describe, expect, it } from "vitest";
import { totalUsage } from "../src/models.js";
import { imageOutput } from "../src/tools/shared.js";

describe("imageOutput", () => {
  it("shows a screenshot to the model beside the rest as JSON", () => {
    expect(imageOutput("screenshot")({ url: "https://a.example", screenshot: "iVBO" })).toEqual({
      type: "content",
      value: [
        { type: "text", text: '{"url":"https://a.example"}' },
        { type: "image-data", data: "iVBO", mediaType: "image/png" },
      ],
    });
  });

  it("takes the picture's type and a text of the caller's", () => {
    const out = imageOutput("image", (rest) => String(rest.name))({
      name: "logo.webp",
      image: "UklG",
      mime: "image/webp",
    });
    expect(out).toEqual({
      type: "content",
      value: [
        { type: "text", text: "logo.webp" },
        { type: "image-data", data: "UklG", mediaType: "image/webp" },
      ],
    });
  });

  it("sends a result without a picture, or a failure, as JSON", () => {
    const shape = imageOutput("screenshot");
    expect(shape({ url: "x" })).toEqual({ type: "json", value: { url: "x" } });
    expect(shape({ error: "gone", screenshot: "iVBO" })).toEqual({
      type: "json",
      value: { error: "gone", screenshot: "iVBO" },
    });
    expect(shape(undefined)).toEqual({ type: "json", value: undefined });
  });
});

describe("totalUsage", () => {
  it("prefers the usage of all steps, from a stream or a finished call", async () => {
    expect(
      await totalUsage({
        totalUsage: Promise.resolve({ inputTokens: 30 }),
        usage: Promise.resolve({ inputTokens: 10 }),
      }),
    ).toEqual({ inputTokens: 30 });
    expect(await totalUsage({ totalUsage: { inputTokens: 30 }, usage: { inputTokens: 10 } })).toEqual(
      { inputTokens: 30 },
    );
  });

  it("falls back to the call's usage", async () => {
    expect(await totalUsage({ usage: Promise.resolve({ inputTokens: 10 }) })).toEqual({
      inputTokens: 10,
    });
    expect(await totalUsage({})).toBeUndefined();
  });
});
