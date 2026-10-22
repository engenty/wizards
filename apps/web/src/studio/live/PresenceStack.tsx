import type { PresenceEntry, PresenceKind } from "@engenty/wizards-shared/live";
import { Bot } from "lucide-react";
import { lang, t } from "../../lib/i18n";
import { cn } from "../../ui";
import { usePresence } from "./presence";

/**
 * Who else is in this wizard, page or table (docs/plans/live-changes.md, 8): their faces in the
 * editor's header, a robot for an AI. A signal for awareness; nobody is locked out.
 */

/** A colour of its own for each person or client, the same in every studio. */
export function presenceColor(who: string): string {
  let h = 0;
  for (const ch of who) {
    h = (h * 31 + ch.charCodeAt(0)) % 360;
  }
  return `oklch(72% 0.13 ${h})`;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(
    Math.abs(s) < 60 ? -Math.abs(s) : -Math.round(Math.abs(s) / 60),
    Math.abs(s) < 60 ? "second" : "minute",
  );
}

/** How one entry is said: who, what they do, where. */
export function presenceLine(e: PresenceEntry): string {
  const who =
    e.whoKind === "assistant"
      ? t("presence.assistant", { person: e.client ?? t("presence.someone") })
      : e.whoKind === "agent"
        ? e.client
          ? t("presence.agentFor", { name: e.name, person: e.client, ago: ago(e.seenAt) })
          : t("presence.agent", { name: e.name, ago: ago(e.seenAt) })
        : t(e.state === "editing" ? "presence.editing" : "presence.viewing", { name: e.name });
  return e.placeLabel ? t("presence.at", { who, place: e.placeLabel }) : who;
}

/** The faces of who else is here; nothing when nobody is. */
export function PresenceStack({
  kind,
  item,
  me,
  className,
}: {
  kind: PresenceKind;
  item: string | undefined;
  me: string | undefined;
  className?: string;
}) {
  const others = usePresence(kind, item, me);
  // One face per person or client, its liveliest entry.
  const byWho = new Map<string, PresenceEntry>();
  for (const e of others) {
    const was = byWho.get(e.who);
    if (!was || (e.state === "editing" && was.state !== "editing")) {
      byWho.set(e.who, e);
    }
  }
  const shown = [...byWho.values()];
  if (!shown.length) {
    return null;
  }
  return (
    <ul
      aria-label={t("presence.here")}
      className={cn("flex shrink-0 items-center -space-x-1.5", className)}
    >
      {shown.slice(0, 4).map((e) => (
        <li
          key={e.who}
          title={presenceLine(e)}
          aria-label={presenceLine(e)}
          className={cn(
            "relative grid size-7 place-items-center rounded-full font-semibold text-[0.6875rem] ring-2 ring-background",
            e.state === "editing" && "outline-2 outline-offset-1",
          )}
          // Dark letters: the colours are light, in either theme.
          style={{
            background: presenceColor(e.who),
            outlineColor: presenceColor(e.who),
            color: "oklch(24% 0.03 260)",
          }}
        >
          {e.whoKind === "person" ? initials(e.name) : <Bot className="size-3.5" />}
        </li>
      ))}
      {shown.length > 4 ? (
        <li className="grid size-7 place-items-center rounded-full bg-paper-2 text-[0.6875rem] text-ink-3 ring-2 ring-background">
          +{shown.length - 4}
        </li>
      ) : null}
    </ul>
  );
}

/** Who else edits the same place as this tab: a quiet hint, never a block. */
export function useAlsoHere(
  kind: PresenceKind,
  item: string | undefined,
  me: string | undefined,
  place: string | null | undefined,
): PresenceEntry | null {
  const others = usePresence(kind, item, me);
  if (!place) {
    return null;
  }
  return (
    others.find((e) => e.place === place && e.state === "editing" && e.whoKind === "person") ?? null
  );
}

/** Who else edits the item now, to name in a merge. */
export function useEditingOthers(
  kind: PresenceKind,
  item: string | undefined,
  me: string | undefined,
) {
  return usePresence(kind, item, me).filter((e) => e.state === "editing");
}
