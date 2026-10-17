import { describe, expect, it } from "vitest";
import { safeJson } from "../src/api.js";

describe("safeJson", () => {
  it("reads a JSON body", () => {
    expect(safeJson('{"error":"nope","fields":{"a":"x"}}')).toEqual({
      error: "nope",
      fields: { a: "x" },
    });
  });

  it("takes a body that is no JSON as its error", () => {
    expect(safeJson("<html>Bad Gateway</html>")).toEqual({ error: "<html>Bad Gateway</html>" });
  });
});
