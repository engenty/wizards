import { describe, expect, it } from "vitest";
import { REDACTED, redactor } from "./redact.js";

describe("redactor", () => {
  const secret = 's3cr3t/t0ken+with "quotes"&more';
  const r = redactor([secret]);

  it("replaces the value as it is, and as JSON, a URL and a form write it", () => {
    expect(r.text(`token ${secret} end`)).toBe(`token ${REDACTED} end`);
    expect(r.text(JSON.stringify({ token: secret }))).toBe(`{"token":"${REDACTED}"}`);
    expect(r.text(`https://x.test/?key=${encodeURIComponent(secret)}`)).toBe(
      `https://x.test/?key=${REDACTED}`,
    );
    expect(r.text(new URLSearchParams({ key: secret }).toString())).toBe(`key=${REDACTED}`);
  });

  it("replaces the trimmed value too", () => {
    expect(redactor(["  padded-secret-value \n"]).text("x padded-secret-value y")).toBe(
      `x ${REDACTED} y`,
    );
  });

  it("leaves short values alone", () => {
    expect(redactor(["1234"]).text("order 1234")).toBe("order 1234");
  });

  it("replaces a longer secret whole when a shorter one is inside it", () => {
    const both = redactor(["abcdefgh", "abcdefgh-ijklmnop"]);
    expect(both.text("abcdefgh-ijklmnop")).toBe(REDACTED);
  });

  it("copies data with every string redacted, keys included, and leaves the input as it was", () => {
    const input = {
      ok: true,
      n: 3,
      list: [secret, { [secret]: `Bearer ${secret}` }],
      at: new Date(0),
    };
    const out = r.value(input);
    expect(out).toEqual({
      ok: true,
      n: 3,
      list: [REDACTED, { [REDACTED]: `Bearer ${REDACTED}` }],
      at: new Date(0),
    });
    expect(input.list[0]).toBe(secret);
  });

  it("walks data that refers to itself", () => {
    const input: Record<string, unknown> = { token: secret };
    input.self = input;
    const out = r.value(input) as Record<string, unknown>;
    expect(out.token).toBe(REDACTED);
    expect(out.self).toBe(out);
  });

  it("with no secrets, hands back what it was given", () => {
    const none = redactor([]);
    const input = { a: "b" };
    expect(none.value(input)).toBe(input);
    expect(none.text("text")).toBe("text");
  });
});
