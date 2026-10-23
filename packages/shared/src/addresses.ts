/**
 * The addresses an organization or a person is found under on the web: a website, a blog, its
 * profiles on social networks. The studio's first visit offers them to tick and reads them into
 * the space.
 */

/** Addresses anyone can have: they say nothing about a business. */
export const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "gmx.at",
  "gmx.de",
  "gmx.net",
  "web.de",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "yahoo.de",
  "aon.at",
  "a1.net",
  "chello.at",
  "t-online.de",
  "proton.me",
  "protonmail.com",
]);

/** The domain of an e-mail address that belongs to an organization; null for free mail. */
export function organizationDomain(email: string): string | null {
  const domain = (email.split("@")[1] ?? "").trim().toLowerCase();
  return domain.includes(".") && !FREE_MAIL.has(domain) ? domain : null;
}

export const ADDRESS_KINDS = [
  "website",
  "blog",
  "linkedin",
  "instagram",
  "facebook",
  "youtube",
  "x",
  "xing",
  "tiktok",
] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

/** How a kind of address is called, the same in both languages. */
export const ADDRESS_NAMES: Record<AddressKind, string> = {
  website: "Website",
  blog: "Blog",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  x: "X",
  xing: "XING",
  tiktok: "TikTok",
};

const NETWORKS: [AddressKind, RegExp][] = [
  ["linkedin", /(^|\.)linkedin\.com$/],
  ["instagram", /(^|\.)instagram\.com$/],
  ["facebook", /(^|\.)(facebook|fb)\.com$/],
  ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/],
  ["x", /(^|\.)(x|twitter)\.com$/],
  ["xing", /(^|\.)xing\.com$/],
  ["tiktok", /(^|\.)tiktok\.com$/],
];

/** An address as a full URL: `baeckerei-huber.at` becomes `https://baeckerei-huber.at/`; null when it is none. */
export function addressUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) {
    return null;
  }
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.includes(".") ? url.href : null;
  } catch {
    return null;
  }
}

/** What an address is, by its host: a network's profile, a blog, else a website. */
export function addressKind(raw: string): AddressKind {
  const url = addressUrl(raw);
  if (!url) {
    return "website";
  }
  const { hostname, pathname } = new URL(url);
  const host = hostname.toLowerCase().replace(/^www\./, "");
  for (const [kind, pattern] of NETWORKS) {
    if (pattern.test(host)) {
      return kind;
    }
  }
  return /^blog\./.test(host) ||
    /^\/blog(\/|$)/.test(pathname) ||
    /(^|\.)(medium|substack)\.com$/.test(host)
    ? "blog"
    : "website";
}
