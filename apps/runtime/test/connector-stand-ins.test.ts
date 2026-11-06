import { describe, expect, it } from "vitest";
import {
  parseStandIns,
  standInFor,
  standInUrl,
  withStandIns,
} from "../src/connectors/stand-ins";

const pairs = parseStandIns(
  [
    "https://gmail.googleapis.com=http://localhost:4002",
    "https://oauth2.googleapis.com/token=http://localhost:4002/oauth2/token,",
    "https://Accounts.Google.com/=http://localhost:4002/",
    "not-a-pair",
    "ftp://files.example.com=http://localhost:1",
    "https://slack.com=",
  ].join("\n"),
);

describe("parseStandIns", () => {
  it("keeps pairs of two http addresses, the longest address first", () => {
    expect(pairs).toEqual([
      ["https://oauth2.googleapis.com/token", "http://localhost:4002/oauth2/token"],
      ["https://gmail.googleapis.com", "http://localhost:4002"],
      ["https://accounts.google.com", "http://localhost:4002"],
    ]);
  });

  it("is empty without a setting", () => {
    expect(parseStandIns(undefined)).toEqual([]);
    expect(parseStandIns("")).toEqual([]);
  });
});

describe("standInFor", () => {
  it("keeps the rest of the address", () => {
    expect(standInFor("https://gmail.googleapis.com/gmail/v1/users/me/threads?q=a%20b", pairs)).toBe(
      "http://localhost:4002/gmail/v1/users/me/threads?q=a%20b",
    );
    expect(standInFor("https://oauth2.googleapis.com/token", pairs)).toBe(
      "http://localhost:4002/oauth2/token",
    );
  });

  it("reads the host as a request names it", () => {
    expect(standInFor("https://GMAIL.googleapis.com:443/upload/gmail/v1", pairs)).toBe(
      "http://localhost:4002/upload/gmail/v1",
    );
  });

  it("fits whole parts of an address only", () => {
    expect(standInFor("https://oauth2.googleapis.com/tokeninfo", pairs)).toBeNull();
    expect(standInFor("https://gmail.googleapis.com.example.org/gmail/v1", pairs)).toBeNull();
    expect(standInFor("https://gmail.googleapis.com@example.org/gmail/v1", pairs)).toBeNull();
  });

  it("leaves every other address alone", () => {
    expect(standInFor("https://people.googleapis.com/v1/people/me", pairs)).toBeNull();
    expect(standInFor("no address", pairs)).toBeNull();
    expect(standInFor("https://gmail.googleapis.com/gmail/v1", [])).toBeNull();
  });
});

describe("standInUrl", () => {
  it("sends the sign-in page to the stand-in and keeps its query", () => {
    expect(
      standInUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=a&state=b", pairs),
    ).toBe("http://localhost:4002/o/oauth2/v2/auth?client_id=a&state=b");
    expect(standInUrl("https://slack.com/oauth/v2/authorize?state=b", pairs)).toBe(
      "https://slack.com/oauth/v2/authorize?state=b",
    );
  });
});

describe("withStandIns", () => {
  const seen: string[] = [];
  const fetchNamed = (name: string) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${name} ${init?.method ?? "GET"} ${String(input)}`);
      return new Response(name);
    }) as typeof fetch;

  it("is the guarded fetch itself where nothing is named", () => {
    const guarded = fetchNamed("guarded");
    expect(withStandIns(guarded, [])).toBe(guarded);
  });

  it("sends a named address to its stand-in through the local check, the rest through the guard", async () => {
    const fetchImpl = withStandIns(fetchNamed("guarded"), pairs, fetchNamed("local"));
    await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST" });
    await fetchImpl(new URL("https://gmail.googleapis.com/gmail/v1/users/me/labels"));
    await fetchImpl("https://api.hubapi.com/crm/v3/objects/contacts");
    expect(seen).toEqual([
      "local POST http://localhost:4002/oauth2/token",
      "local GET http://localhost:4002/gmail/v1/users/me/labels",
      "guarded GET https://api.hubapi.com/crm/v3/objects/contacts",
    ]);
  });
});
