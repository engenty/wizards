import { describe, expect, it } from "vitest";
import { initialsOf } from "./session";

describe("initialsOf", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsOf("Anna Wagner")).toBe("AW");
    expect(initialsOf("Mein Computer")).toBe("MC");
    expect(initialsOf("anna")).toBe("A");
    expect(initialsOf("")).toBe("");
  });

  it("skips a bracket or a sign before a word, and a word without a letter", () => {
    expect(initialsOf("E-Mail (SMTP)")).toBe("ES");
    expect(initialsOf("Wagner & Söhne")).toBe("WS");
    expect(initialsOf("„Bäckerei“ Wagner")).toBe("BW");
    expect(initialsOf("S3 Bucket")).toBe("SB");
    expect(initialsOf("3 Brüder")).toBe("3B");
  });
});
