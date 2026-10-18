import type { ResultStep, ShareOption, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { ShareTargetInfo } from "@engenty/wizards-shared/sharing";
import { useQuery } from "@tanstack/react-query";
import { createContext } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";

/**
 * Where a result is sent or published, as the editor shows it: a row per target, on or off.
 * The wizard file keeps it as before: no list (the default targets), a list, or an empty list.
 */

/** Every target a wizard of this project can name, with whether it works here. */
export function useShareTargets(wizardId: string | undefined) {
  return useQuery({
    queryKey: ["share-targets", wizardId, lang],
    queryFn: () =>
      api.get<ShareTargetInfo[]>(`/api/studio/wizards/${wizardId}/share-targets?lang=${lang}`),
    enabled: Boolean(wizardId),
    staleTime: 60_000,
  });
}

/**
 * Opens the result page where it is not in view (a phone, a tablet); null where it shows beside
 * the flow anyway.
 */
export const ResultPageOpener = createContext<(() => void) | null>(null);

export type ShareMode = "default" | "own" | "off";

export function shareMode(step: ResultStep): ShareMode {
  return !step.share ? "default" : step.share.length ? "own" : "off";
}

/** One target of the result: offered (on), or off and ready to be switched on. */
export interface ShareRow {
  /** Stays the same when the default targets become a list of the wizard's own. */
  key: string;
  target: string;
  /** Unknown where the wizard names a target this project does not have. */
  info: ShareTargetInfo | undefined;
  /** Its place in the wizard's own list; null where it is not listed. */
  index: number | null;
  option: ShareOption | null;
  on: boolean;
  /** How the result page names it. */
  name: string;
}

const ready = (k: ShareTargetInfo) => k.byDefault && k.usable;

/**
 * The result's targets: the listed or default ones first, then those that could be switched on.
 * `unset` holds the default targets that are not set up on this server.
 */
export function shareRows(
  step: ResultStep,
  known: ShareTargetInfo[],
): { mode: ShareMode; rows: ShareRow[]; unset: ShareTargetInfo[] } {
  const mode = shareMode(step);
  const listed = step.share ?? [];
  const seen = new Map<string, number>();
  const keyOf = (target: string) => {
    const n = seen.get(target) ?? 0;
    seen.set(target, n + 1);
    return `${target}#${n}`;
  };
  const off = (k: ShareTargetInfo): ShareRow => ({
    key: keyOf(k.id),
    target: k.id,
    info: k,
    index: null,
    option: null,
    on: false,
    name: k.name,
  });
  if (mode === "default") {
    const rows = known.filter(ready).map((k) => ({ ...off(k), on: true }));
    return { mode, rows, unset: known.filter((k) => k.byDefault && !k.usable) };
  }
  const rows: ShareRow[] = listed.map((option, index) => {
    const info = known.find((k) => k.id === option.target);
    return {
      key: keyOf(option.target),
      target: option.target,
      info,
      index,
      option,
      on: true,
      name: option.label || info?.name || option.target,
    };
  });
  const named = new Set(listed.map((o) => o.target));
  rows.push(...known.filter((k) => ready(k) && !named.has(k.id)).map(off));
  return {
    mode,
    rows,
    unset: known.filter((k) => k.byDefault && !k.usable && !named.has(k.id)),
  };
}

/** Who gets which row: visitors, only the owner (an agent's, by default), nobody (not set up). */
export function audiences(mode: ShareMode, rows: ShareRow[]) {
  const working = rows.filter((r) => r.on && r.info?.usable);
  return {
    visitors: working.filter((r) => !(mode === "default" && r.info?.agent)),
    onlyYou: mode === "default" ? working.filter((r) => r.info?.agent) : [],
    broken: rows.filter((r) => r.on && !r.info?.usable),
  };
}

/** The default targets as a list of the wizard's own: what visitors get now, agents left out. */
function defaultList(known: ShareTargetInfo[]): ShareOption[] {
  return known.filter((k) => ready(k) && !k.agent).map((k) => ({ target: k.id }));
}

function baseList(step: ResultStep, known: ShareTargetInfo[]): ShareOption[] {
  const mode = shareMode(step);
  return mode === "own" ? (step.share ?? []) : mode === "default" ? defaultList(known) : [];
}

/** The result's list with a row switched on or off; switched off, the last one leaves none. */
export function switchRow(
  step: ResultStep,
  known: ShareTargetInfo[],
  row: ShareRow,
  on: boolean,
): ShareOption[] {
  const list = baseList(step, known);
  if (on) {
    return [...list, { target: row.target }];
  }
  return row.index !== null
    ? list.filter((_, i) => i !== row.index)
    : list.filter((o) => o.target !== row.target);
}

/** The result's list with what a row's form starts with. */
export function prefillRow(
  step: ResultStep,
  known: ShareTargetInfo[],
  row: ShareRow,
  option: ShareOption,
): ShareOption[] {
  const list = baseList(step, known);
  const at = row.index ?? list.findIndex((o) => o.target === row.target);
  return at === -1 ? [...list, option] : list.map((o, i) => (i === at ? option : o));
}

/** A target added from the ones a result does not offer by itself. */
export function addTarget(step: ResultStep, known: ShareTargetInfo[], target: string) {
  return [...baseList(step, known), { target }];
}

/** Targets that work here and no row shows: connectors that can write, and the like. */
export function extraTargets(rows: ShareRow[], known: ShareTargetInfo[]): ShareTargetInfo[] {
  const shown = new Set(rows.map((r) => r.target));
  return known.filter((k) => k.usable && !k.byDefault && !shown.has(k.id));
}

/** What a prefilled field can take: answers, written results, the brand's name. */
export interface Placeholder {
  ref: string;
  label: string;
}

export function placeholdersFor(def: WizardDefinition, step: ResultStep): Placeholder[] {
  const before = def.steps.slice(0, def.steps.indexOf(step));
  return [
    ...before.flatMap((s) =>
      s.type === "page"
        ? s.fields
            .filter((f) => f.kind !== "image" && f.kind !== "file" && f.kind !== "signature")
            .map((f) => ({ ref: f.id, label: f.label }))
        : [],
    ),
    ...before.flatMap((s) =>
      s.type === "agent" && s.output.format !== "json"
        ? [{ ref: `steps.${s.id}`, label: s.title }]
        : [],
    ),
    { ref: "brand.name", label: t("shareEditor.brandName") },
  ];
}

/** Names as a sentence lists them: "Link, Email and S3 Bucket". */
export function listText(names: string[]): string {
  return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, {
    style: "long",
    type: "conjunction",
  }).format(names);
}
