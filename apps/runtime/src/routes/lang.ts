import { type Lang, localLang } from "@engenty-wizards/shared/definition";
import type { Gap } from "@engenty-wizards/shared/texts";
import type { Context } from "hono";
import { type ServerKey, serverText } from "../texts.js";

/**
 * The language a visitor's request asks for, as the studio starts in it (`localLang`): the
 * first of the browser's languages engenty speaks other than English, else English. The
 * browser's `Accept-Language` names them in its order; the server has no time zone to go by.
 */
export function requestLang(c: Context): Lang {
  const asked = (c.req.header("accept-language") ?? "")
    .split(",")
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter(Boolean);
  return localLang(asked) ?? "en";
}

/** A line of the server's table the person reads, in the language their request asks for. */
export function say(c: Context, key: ServerKey, params?: Record<string, Gap | undefined>): string {
  return serverText(requestLang(c), key, params);
}

/** A 404 the person may read: a sentence in their language, the machine code beside it. */
export function notFoundAnswer(c: Context): { error: string; code: "not_found" } {
  return {
    error: say(c, "notFound"),
    code: "not_found",
  };
}
