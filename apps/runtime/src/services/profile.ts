import { isLang, type Lang } from "@engenty-wizards/shared/definition";
import { z } from "zod";
import { linkedAccount } from "../auth/account.js";
import type { SessionUser } from "../auth/index.js";
import { managed } from "../manage.js";
import { readSetting, writeSetting } from "../settings.js";

/**
 * What a person says about themselves in the studio: how the app calls them and how to reach
 * them. A runtime that runs alone knows nobody — its one person starts as the machine's user
 * name and sets everything here. Managed, name and e-mail are the account's and stay with it; so
 * they are while a runtime that runs alone is linked to an account.
 */
export interface UserProfile {
  name: string;
  about: string;
  email: string;
  phone: string;
}

export const profileSchema = z.object({
  name: z.string().trim().max(80),
  about: z.string().trim().max(2000),
  email: z.string().trim().max(200),
  phone: z.string().trim().max(40),
});

const key = (user: SessionUser) => `profile:${user.tenantId}:${user.id}`;

/** The account whose name and e-mail the profile shows; null where the person sets them here. */
async function accountOf(user: SessionUser): Promise<{ name: string; email: string } | null> {
  if (managed) {
    return { name: user.name, email: user.email };
  }
  const linked = await linkedAccount();
  return linked ? { name: linked.name, email: linked.email } : null;
}

export async function userProfile(user: SessionUser): Promise<UserProfile> {
  const stored = (await readSetting<Partial<UserProfile>>(key(user))) ?? {};
  const account = await accountOf(user);
  return {
    name: account?.name || stored.name || user.name,
    about: stored.about ?? "",
    email: account ? account.email : stored.email || user.email,
    phone: stored.phone ?? "",
  };
}

const langKey = (user: SessionUser) => `lang:${user.tenantId}:${user.id}`;

/**
 * The language the person picked in the studio, kept with them rather than one browser: a new
 * browser or device opens in it. Null until they pick one; the browser's language stands then.
 */
export async function userLang(user: SessionUser): Promise<Lang | null> {
  const lang = await readSetting<unknown>(langKey(user));
  return isLang(lang) ? lang : null;
}

export async function saveUserLang(user: SessionUser, lang: Lang): Promise<void> {
  await writeSetting(langKey(user), lang);
}

export async function saveProfile(user: SessionUser, profile: UserProfile): Promise<UserProfile> {
  // Name and e-mail an account gives stay the person's own underneath: they come back unlinked.
  const stored = (await readSetting<Partial<UserProfile>>(key(user))) ?? {};
  const own = (await accountOf(user))
    ? { ...profile, name: stored.name ?? "", email: stored.email ?? "" }
    : profile;
  await writeSetting(key(user), own);
  return userProfile(user);
}
