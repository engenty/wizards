import { describe, expect, it } from "vitest";
import { CsvRefused, parsePasswordCsv } from "./csv.js";
import { fits, OriginRefused, originsOf, siteOrigin } from "./origins.js";
import { authenticatorCode, authenticatorKey } from "./totp.js";

describe("siteOrigin", () => {
  it("keeps protocol, host and port, https by default", () => {
    expect(siteOrigin("example.com")).toBe("https://example.com");
    expect(siteOrigin("https://www.example.com/uk/?a=1#x")).toBe("https://www.example.com");
    expect(siteOrigin("http://localhost:4310/login")).toBe("http://localhost:4310");
  });

  it("refuses plain http elsewhere, credentials in the address and half domains", () => {
    expect(() => siteOrigin("http://example.com")).toThrow(OriginRefused);
    expect(() => siteOrigin("https://ada:pw@example.com")).toThrow(/user name and password/);
    expect(() => siteOrigin("example")).toThrow(/incomplete/);
    expect(() => siteOrigin("ftp://example.com")).toThrow(OriginRefused);
  });
});

describe("which pages a login fits", () => {
  it("pairs a registrable domain with its www twin and nothing else", () => {
    expect(originsOf("https://example.com")).toEqual([
      "https://example.com",
      "https://www.example.com",
    ]);
    expect(originsOf("https://www.example.co.uk")).toEqual([
      "https://www.example.co.uk",
      "https://example.co.uk",
    ]);
    expect(originsOf("https://login.example.com")).toEqual(["https://login.example.com"]);
    expect(originsOf("http://localhost:4310")).toEqual(["http://localhost:4310"]);
  });

  it("follows Nod's table", () => {
    const saved = "https://example.com";
    expect(fits(saved, "https://example.com/weekly")).toBe(true);
    expect(fits(saved, "https://www.example.com")).toBe(true);
    expect(fits(saved, "https://login.example.com")).toBe(false);
    expect(fits(saved, "http://example.com")).toBe(false);
    expect(fits(saved, "https://example.com:8443")).toBe(false);
    expect(fits(saved, "not a url")).toBe(false);
  });
});

describe("authenticator codes", () => {
  // RFC 6238, appendix B: the SHA-1 key "12345678901234567890" in base32.
  const key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("normalises a setup key and an otpauth link", () => {
    expect(authenticatorKey(`${key.slice(0, 8)} ${key.slice(8)}`)).toBe(
      `otpauth://totp/?secret=${key}&algorithm=SHA1&digits=6&period=30`,
    );
    expect(authenticatorKey(`otpauth://totp/Site:ada?secret=${key}&digits=8`)).toBe(
      `otpauth://totp/?secret=${key}&algorithm=SHA1&digits=8&period=30`,
    );
    expect(authenticatorKey("not a key")).toBeUndefined();
    expect(authenticatorKey(`otpauth://hotp/?secret=${key}`)).toBeUndefined();
  });

  it("makes the RFC's codes", () => {
    const eight = `otpauth://totp/?secret=${key}&digits=8`;
    expect(authenticatorCode(eight, 59_000)).toBe("94287082");
    expect(authenticatorCode(eight, 1_111_111_109_000)).toBe("07081804");
    expect(authenticatorCode(key, 59_000)).toBe("287082");
  });
});

describe("parsePasswordCsv", () => {
  it("reads a Chrome export", () => {
    const csv =
      'name,url,username,password,note\r\nReports,https://reports.example.com/login,ada@example.com,"pa,ss""word",\r\n';
    expect(parsePasswordCsv(csv)).toEqual({
      logins: [
        {
          label: "Reports",
          origin: "https://reports.example.com",
          username: "ada@example.com",
          password: 'pa,ss"word',
        },
      ],
      unreadable: 0,
      badKeys: 0,
    });
  });

  it("reads a Bitwarden export with its authenticator key and skips what it can't use", () => {
    const csv = [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      ",,login,Bank,,,0,bank.example.com,ada,secret,GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      ",,login,Broken key,,,0,https://x.example.com,ada,secret,nope",
      ",,login,No password,,,0,https://y.example.com,ada,,",
      ",,login,Nowhere,,,0,javascript:alert(1),ada,secret,",
      ",,note,Short row",
    ].join("\n");
    const result = parsePasswordCsv(csv);
    expect(result.logins.map((l) => [l.label, l.origin, Boolean(l.authenticator)])).toEqual([
      ["Bank", "https://bank.example.com", true],
      ["Broken key", "https://x.example.com", false],
    ]);
    expect(result).toMatchObject({ unreadable: 2, badKeys: 1 });
  });

  it("refuses a file without a website or password column", () => {
    expect(() => parsePasswordCsv("a,b\n1,2")).toThrow(CsvRefused);
    expect(() => parsePasswordCsv('url,password\n"open')).toThrow(/never ends/);
  });
});
