import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveKey,
  keyCheckHolds,
  keyIdOf,
  keyRing,
  needsReseal,
  reseal,
  seal,
  sealKeyCheck,
  unseal,
  VaultError,
} from "./seal.js";

const key = (id: string) => ({ id, key: randomBytes(32) });
const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof VaultError ? error.reason : "other";
  }
  return "none";
};

describe("seal and unseal", () => {
  const ring = keyRing(key("k1"));
  const binding = ["team-a", "connection", "row-1"];

  it("opens what it sealed, with the same binding", () => {
    const sealed = seal(ring, binding, "token-ünicode");
    expect(sealed.startsWith("v2.k1.")).toBe(true);
    expect(unseal(ring, binding, sealed)).toBe("token-ünicode");
  });

  it("seals the same value differently each time", () => {
    expect(seal(ring, binding, "x")).not.toBe(seal(ring, binding, "x"));
  });

  it("doesn't open a value moved to another owner, row or purpose", () => {
    const sealed = seal(ring, binding, "token");
    expect(reasonOf(() => unseal(ring, ["team-b", "connection", "row-1"], sealed))).toBe(
      "not-opened",
    );
    expect(reasonOf(() => unseal(ring, ["team-a", "connection", "row-2"], sealed))).toBe(
      "not-opened",
    );
    expect(reasonOf(() => unseal(ring, ["team-a", "connection"], sealed))).toBe("not-opened");
  });

  it("doesn't open with another key, a changed key id or a changed byte", () => {
    const sealed = seal(ring, binding, "token");
    expect(reasonOf(() => unseal(keyRing(key("k1")), binding, sealed))).toBe("not-opened");
    const parts = sealed.split(".");
    expect(
      reasonOf(() =>
        unseal(
          keyRing(key("k2"), ring.current),
          binding,
          ["v2", "k2", ...parts.slice(2)].join("."),
        ),
      ),
    ).toBe("not-opened");
    const body = Buffer.from(parts[4] as string, "base64url");
    body[0] = (body[0] as number) ^ 1;
    expect(
      reasonOf(() =>
        unseal(ring, binding, [...parts.slice(0, 4), body.toString("base64url")].join(".")),
      ),
    ).toBe("not-opened");
  });

  it("says when the text is no sealed value or names a key it lacks", () => {
    expect(reasonOf(() => unseal(ring, binding, "v1.abc.def.ghi"))).toBe("format");
    expect(reasonOf(() => unseal(ring, binding, "plain text"))).toBe("format");
    const other = seal(keyRing(key("k9")), binding, "token");
    expect(reasonOf(() => unseal(ring, binding, other))).toBe("unknown-key");
  });

  it("seals an empty value", () => {
    expect(unseal(ring, binding, seal(ring, binding, ""))).toBe("");
  });
});

describe("key rings", () => {
  it("opens values of earlier keys and reseals them with the current one", () => {
    const old = keyRing(key("k1"));
    const binding = ["person", "secret", "gateway"];
    const sealed = seal(old, binding, "token");
    const ring = keyRing(key("k2"), old.current);
    expect(unseal(ring, binding, sealed)).toBe("token");
    expect(needsReseal(ring, sealed)).toBe(true);
    const again = reseal(ring, binding, sealed);
    expect(keyIdOf(again)).toBe("k2");
    expect(needsReseal(ring, again)).toBe(false);
    expect(reseal(ring, binding, again)).toBe(again);
    expect(unseal(keyRing(ring.current), binding, again)).toBe("token");
  });

  it("refuses two keys with one id, a bad id or a short key", () => {
    expect(() => keyRing(key("k1"), key("k1"))).toThrow(/same id/);
    expect(() => keyRing(key("k 1"))).toThrow(/key id/);
    expect(() => keyRing({ id: "k1", key: randomBytes(16) })).toThrow(/32 bytes/);
  });
});

describe("deriveKey", () => {
  const secret = "a secret of the install, long enough";

  it("gives the same key for the same secret and purpose, another for another purpose", () => {
    expect(deriveKey(secret, "stored-secrets").key).toEqual(
      deriveKey(secret, "stored-secrets").key,
    );
    expect(deriveKey(secret, "stored-secrets").key).not.toEqual(deriveKey(secret, "state").key);
    expect(deriveKey(secret, "team:a").key).not.toEqual(deriveKey(secret, "team:b").key);
  });

  it("names the key by the id it is given", () => {
    expect(deriveKey(secret, "x", "2026-11").id).toBe("2026-11");
  });

  it("refuses a short secret and an empty purpose", () => {
    expect(() => deriveKey("short", "x")).toThrow(/16 bytes/);
    expect(() => deriveKey(secret, "")).toThrow(/purpose/);
  });
});

describe("key check", () => {
  it("holds for the ring that sealed it and owner it names, and not otherwise", () => {
    const ring = keyRing(key("k1"));
    const check = sealKeyCheck(ring, "team-a");
    expect(keyCheckHolds(ring, "team-a", check)).toBe(true);
    expect(keyCheckHolds(ring, "team-b", check)).toBe(false);
    expect(keyCheckHolds(keyRing(key("k1")), "team-a", check)).toBe(false);
    expect(keyCheckHolds(ring, "team-a", "garbage")).toBe(false);
  });
});
