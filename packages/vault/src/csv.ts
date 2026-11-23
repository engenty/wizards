import { loopbackHost } from "./origins.js";
import { authenticatorKey } from "./totp.js";

// Passwords exported from a password manager as CSV: Chrome, 1Password, Bitwarden and most
// others name their columns alike. Archived items, passkeys and rows without a password or a
// website are left out; an authenticator key comes along when the export has one.

export interface ImportedLogin {
  label: string;
  origin: string;
  username: string;
  password: string;
  authenticator?: string;
}

export interface Imported {
  logins: ImportedLogin[];
  /** Rows that could not be read: a broken row or a website that is no address. */
  unreadable: number;
  /** Authenticator keys that are not valid; their logins come without them. */
  badKeys: number;
}

const COLUMNS = {
  url: ["url", "login_uri", "website", "login uri", "web site"],
  username: ["username", "login_username", "user name", "login"],
  email: ["email", "e-mail"],
  password: ["password", "login_password"],
  label: ["title", "name"],
  archived: ["archived"],
  authenticator: ["otpauth", "login_totp", "totp"],
};

export class CsvRefused extends Error {}

/** The rows of a CSV text: quoted fields with "" inside, commas, CRLF or LF. */
function rowsOf(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let start = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"' && start) {
      quoted = true;
      start = false;
    } else if (char === ",") {
      row.push(field);
      field = "";
      start = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      rows.push([...row, field]);
      row = [];
      field = "";
      start = true;
    } else {
      field += char;
      start = false;
    }
  }
  if (quoted) throw new CsvRefused("The file has a quoted field that never ends. Export it again.");
  if (field || row.length) rows.push([...row, field]);
  return rows.filter((values) => values.some((value) => value.trim()));
}

/** The origin of an exported website, https unless it is this computer. */
function originOf(address: string): string | undefined {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `https://${address}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.protocol === "http:" && !loopbackHost(url.hostname)) url.protocol = "https:";
    return url.origin;
  } catch {
    return undefined;
  }
}

export function parsePasswordCsv(text: string): Imported {
  const [header = [], ...rows] = rowsOf(text.replace(/^﻿/, ""));
  const names = header.map((name) => name.trim().toLowerCase());
  const column = (keys: string[]) =>
    keys.map((key) => names.indexOf(key)).find((index) => index >= 0) ?? -1;
  const at = {
    url: column(COLUMNS.url),
    username: column(COLUMNS.username),
    email: column(COLUMNS.email),
    password: column(COLUMNS.password),
    label: column(COLUMNS.label),
    archived: column(COLUMNS.archived),
    authenticator: column(COLUMNS.authenticator),
  };
  if (at.url < 0 || at.password < 0)
    throw new CsvRefused(
      "This is no export of a password manager: it has no website or password column.",
    );
  let unreadable = 0;
  let badKeys = 0;
  const logins: ImportedLogin[] = [];
  for (const row of rows) {
    const value = (index: number) => (index < 0 ? "" : (row[index] ?? ""));
    if (row.length !== names.length) {
      unreadable++;
      continue;
    }
    if (!value(at.password) || value(at.archived).trim().toLowerCase() === "true") continue;
    const origin = value(at.url)
      .split(/[\s,]+/)
      .map(originOf)
      .find(Boolean);
    if (!origin) {
      unreadable++;
      continue;
    }
    const rawKey = value(at.authenticator).trim();
    const key = rawKey ? authenticatorKey(rawKey) : undefined;
    if (rawKey && !key) badKeys++;
    logins.push({
      label: value(at.label).trim() || new URL(origin).hostname,
      origin,
      username: value(at.username).trim() || value(at.email).trim(),
      password: value(at.password),
      ...(key ? { authenticator: key } : {}),
    });
  }
  return { logins, unreadable, badKeys };
}
