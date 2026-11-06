import { CONNECTION_LIMITS, type SpaceConnectionView } from "@engenty/wizards-shared/connectors";
import { lang, t } from "../../lib/i18n";

/*
 * A connection's limits and use in words (docs/plans/capabilities-next.md, 2b): calls per run
 * and per day, empty for none. What a field shows, what a typed text means and what the page
 * says of today's calls all come from the connection's own numbers.
 */

/** A limit as its field shows it: the number, or nothing where there is none. */
export function limitText(limit: number | null): string {
  return limit === null ? "" : String(limit);
}

/**
 * What a typed limit means: null for an empty field (no limit), a whole number from 1 up to the
 * most a limit may name, and undefined for anything else, which changes nothing.
 */
export function readLimit(text: string): number | null | undefined {
  const typed = text.trim();
  if (!typed) {
    return null;
  }
  if (!/^\d+$/.test(typed)) {
    return undefined;
  }
  const limit = Number(typed);
  return limit >= 1 && limit <= CONNECTION_LIMITS.calls ? limit : undefined;
}

/** Today's calls: against the limit per day where there is one, else counted alone. */
export function usedToday(c: Pick<SpaceConnectionView, "callsToday" | "callsPerDay">): string {
  return c.callsPerDay === null
    ? t("connection.callsToday", { n: c.callsToday })
    : t("connection.callsTodayOf", {
        n: c.callsToday.toLocaleString(lang),
        limit: c.callsPerDay.toLocaleString(lang),
      });
}
