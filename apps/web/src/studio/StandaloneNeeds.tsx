import { FORMAT_LABEL } from "@engenty-wizards/runner";
import type { WizardDefinition } from "@engenty-wizards/shared/definition";
import {
  capabilityOf,
  type Need,
  type StandaloneFit,
  standaloneEntry,
} from "@engenty-wizards/shared/fit";
import { type Capability, marketLabel } from "@engenty-wizards/shared/marketplace";
import { Check, CircleAlert, CircleMinus } from "lucide-react";
import { useMemo } from "react";
import { type Key, lang, t } from "../lib/i18n";
import { Chip, cn } from "../ui";

/**
 * Whether a wizard runs on a WordPress site without an account, in the gallery's words: the chip
 * the share dialog and the plugin show, and the "Braucht" list of the entry dialog — every
 * capability with "nicht eingerichtet" (rose) or "geht auch ohne" (amber), what the gallery has
 * no word for by its need, the result formats that fall away. One function behind all of it
 * (packages/shared/src/fit.ts).
 */

export function useStandalone(def: WizardDefinition): StandaloneFit {
  return useMemo(() => standaloneEntry(def), [def]);
}

export function FitChip({ fit }: { fit: StandaloneFit["fit"] }) {
  return (
    <Chip tone={fit === "full" ? "live" : fit === "less" ? "warn" : "neutral"}>
      {t(fit === "full" ? "share.wpFull" : fit === "less" ? "share.wpLess" : "share.wpNo")}
    </Chip>
  );
}

type Line = { text: string; tone: "ok" | "missing" | "optional" };

/** What the gallery has no capability for, by its need id. */
const WORDED: Partial<Record<Need, Key>> = {
  lists: "need.lists",
  memory: "need.memory",
  each: "need.each",
  "field:slot": "need.field:slot",
  "asset:document": "need.asset:document",
  "asset:dashboard": "need.asset:dashboard",
  "tool:pages": "need.tool:pages",
};

export function needLines(def: WizardDefinition, fit: StandaloneFit): Line[] {
  const lines: Line[] = [];
  const seen = new Set<string>();
  const add = (key: string, line: Line) => {
    if (!seen.has(key)) {
      seen.add(key);
      lines.push(line);
    }
  };
  // Text is always there: the one thing the site's provider does.
  if (def.steps.some((s) => s.type === "agent" && !s.call)) {
    add("text", { text: marketLabel("capability", "text", lang), tone: "ok" });
  }
  for (const c of fit.missing) {
    add(c, { text: marketLabel("capability", c as Capability, lang), tone: "missing" });
  }
  for (const c of fit.optional) {
    add(c, { text: marketLabel("capability", c as Capability, lang), tone: "optional" });
  }
  for (const note of fit.notes) {
    const key = WORDED[note.need];
    if (key && !capabilityOf(note.need)) {
      add(note.need, { text: t(key), tone: note.hard ? "missing" : "optional" });
    }
  }
  for (const f of fit.without) {
    add(`format:${f}`, { text: t("need.format", { format: FORMAT_LABEL[f] }), tone: "optional" });
  }
  return lines;
}

export function NeedList({ def, fit }: { def: WizardDefinition; fit: StandaloneFit }) {
  const lines = needLines(def, fit);
  return (
    <ul className="flex flex-col gap-1.5 text-[0.8125rem]">
      {lines.map((line) => (
        <li key={line.text} className="flex items-center gap-2">
          {line.tone === "ok" ? (
            <Check className="size-4 shrink-0 text-cobalt" />
          ) : line.tone === "missing" ? (
            <CircleMinus className="size-4 shrink-0 text-rose" />
          ) : (
            <CircleAlert className="size-4 shrink-0 text-amber" />
          )}
          <span className={cn(line.tone === "missing" && "text-ink-2")}>{line.text}</span>
          {line.tone !== "ok" ? (
            <span
              className={cn("text-[0.75rem]", line.tone === "missing" ? "text-rose" : "text-amber")}
            >
              {t(line.tone === "missing" ? "need.missing" : "need.optional")}
            </span>
          ) : null}
        </li>
      ))}
      {fit.needs.length ? (
        <li className="flex items-center gap-2 text-ink-2">
          <CircleMinus className="size-4 shrink-0 text-rose" />
          {t("share.wpNeedsAccount", { list: fit.needs.join(", ") })}
        </li>
      ) : null}
    </ul>
  );
}
