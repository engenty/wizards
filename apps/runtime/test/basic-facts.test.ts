import { BASIC_FACTS, basicFactOf } from "@engenty/wizards-shared/spaces";
import { describe, expect, it } from "vitest";

describe("common facts by label", () => {
  it("finds the studio's key for its labels in either language", () => {
    expect(basicFactOf("USt-IdNr.")).toBe("uid");
    expect(basicFactOf("vat id")).toBe("uid");
    expect(basicFactOf(" IBAN ")).toBe("iban");
    expect(basicFactOf("BIC")).toBe("bic");
    expect(basicFactOf("Bank")).toBe("bank");
    expect(basicFactOf("Postcode")).toBe("plz");
  });

  it("leaves other labels to a key of their own", () => {
    expect(basicFactOf("Bankverbindung")).toBeNull();
    expect(basicFactOf("Firmenbuchnummer")).toBeNull();
  });

  it("offers the bank's details as three facts", () => {
    expect(BASIC_FACTS).toEqual(expect.arrayContaining(["iban", "bic", "bank"]));
  });
});
