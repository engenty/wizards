import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunFontFace } from "@engenty/wizards-shared/run";
import {
  freeThemeId,
  SHIPPED_FONTS,
  type Theme,
  type ThemeColors,
  type ThemeColours,
  type ThemeEffect,
  themeColors,
  themeIdFrom,
} from "@engenty/wizards-shared/theme";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { Button, cn, IconButton, Label, Segmented, Select, Swatch } from "../../ui";
import { LookPreview } from "./LookPreview";

type Update = (def: WizardDefinition) => void;
/** The brand's fonts for headings and text: what `brand` stands for in this space's themes. */
export type BrandFonts = { heading: string | null; text: string | null; faces: RunFontFace[] };
type ThemesAnswer = {
  themes: Theme[];
  usedBy: Record<string, { id: string; title: string }[]>;
  brandFonts: BrandFonts;
};
type Mode = "light" | "dark";

/**
 * How the wizard's pages look: the first theme the wizard names, edited in place. Behind the
 * scenes it is a theme of the space (docs/plans/themes.md); a wizard without one gets one named
 * after it with the first change. Folded, the section shows a preview.
 */
export function ThemeLook({
  def,
  update,
  projectId,
  wizardId,
}: {
  def: WizardDefinition;
  update: Update;
  projectId: string;
  wizardId: string;
}) {
  const qc = useQueryClient();
  const key = ["themes", projectId];
  const answer = useQuery({
    queryKey: key,
    queryFn: () => api.get<ThemesAnswer>(`/api/studio/projects/${projectId}/themes`),
  });
  const themes = answer.data?.themes ?? [];
  const chosen = def.themes?.[0];
  const stored = themes.find((x) => x.id === chosen);
  const [draft, setDraft] = useState<Theme | undefined>(stored);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const storedKey = JSON.stringify(stored ?? null);
  // A theme saved elsewhere, or another one chosen, shows as it is stored; a theme just made is
  // kept while the space's list does not have it yet.
  useEffect(() => {
    const s = JSON.parse(storedKey) as Theme | null;
    setDraft((d) => s ?? (d && d.id === chosen ? d : undefined));
  }, [storedKey, chosen]);

  const save = (theme: Theme) => {
    setDraft(theme);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void api
        .put(`/api/studio/projects/${projectId}/themes`, theme)
        .then(() => qc.invalidateQueries({ queryKey: key }));
    }, 350);
  };
  const choose = (id: string | undefined) => {
    const rest = (def.themes ?? []).filter((x) => x !== id);
    update({ ...def, themes: id ? [id, ...rest] : rest.length ? rest : undefined });
  };
  /** A change to the wizard's look: to its theme, or to a new one named after the wizard. */
  const change = (patch: (t: Theme) => Theme) => {
    if (draft) {
      save(patch(draft));
      return;
    }
    const id = freeThemeId(themeIdFrom(def.title), new Set(themes.map((x) => x.id)));
    const theme = patch({ id, name: def.title, version: "1.0.0", base: "brand" });
    save(theme);
    choose(id);
  };
  const copyForThis = () => {
    if (!draft) {
      return;
    }
    const id = freeThemeId(
      `${draft.id.replace(/^@[^/]+\//, "")}-copy`,
      new Set(themes.map((x) => x.id)),
    );
    const theme = { ...draft, id, name: t("inspector.lookCopyName", { name: draft.name }) };
    save(theme);
    choose(id);
  };

  const [open, setOpen] = useState(false);
  const head = useRef<HTMLButtonElement>(null);
  // Opened, the section moves up into view, so the settings it opens are seen.
  useEffect(() => {
    if (open) {
      head.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [open]);

  const others = (chosen ? (answer.data?.usedBy[chosen] ?? []) : []).filter(
    (w) => w.id !== wizardId,
  );
  const brandFonts = answer.data?.brandFonts;
  const preview = <LookPreview def={def} theme={draft} brandFonts={brandFonts} />;
  return (
    <div className="border-border-soft border-t px-5 py-5">
      <div className="flex flex-col gap-4">
        <button
          ref={head}
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-my-1 flex items-center justify-between text-left"
        >
          <span className="font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.07em]">
            {t("inspector.look")}
          </span>
          <ChevronDown className={cn("size-4 text-ink-4 transition", open && "rotate-180")} />
        </button>
        {open ? (
          <>
            <div>
              <Label>{t("inspector.lookTheme")}</Label>
              <Select
                value={chosen ?? ""}
                onChange={(v) => choose(v || undefined)}
                options={[
                  { value: "", label: t("inspector.lookThemeBrand") },
                  { value: "default", label: t("inspector.lookThemeDefault") },
                  ...themes.map((x) => ({ value: x.id, label: x.name })),
                ]}
              />
            </div>
            {preview}
          </>
        ) : (
          <button
            type="button"
            aria-label={t("inspector.lookOpen")}
            onClick={() => setOpen(true)}
            className="rounded-xl text-left transition hover:brightness-110"
          >
            {preview}
          </button>
        )}
        {open ? (
          <>
            {others.length ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-paper-2 px-3 py-2.5 text-[0.8125rem] text-ink-3">
                <span>
                  {t("inspector.lookAlsoUsedBy", {
                    wizards: others.map((w) => w.title).join(", "),
                  })}
                </span>
                <Button size="sm" variant="secondary" onClick={copyForThis}>
                  {t("inspector.lookCopy")}
                </Button>
              </div>
            ) : null}
            {chosen === "default" ? null : (
              <ThemeFields
                theme={draft}
                brandFonts={brandFonts}
                costume={def.costume}
                change={change}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ColourField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <div>
      <Label hint={value ? undefined : t("inspector.fromSpace")}>{label}</Label>
      <div className="flex items-center gap-2">
        <Swatch value={value ?? fallback} onChange={(e) => onChange(e.target.value)} />
        {value ? (
          <>
            <span className="font-mono text-[0.8125rem] text-ink-3">{value}</span>
            <IconButton label={t("inspector.lookReset")} onClick={() => onChange(undefined)}>
              <X className="size-4" />
            </IconButton>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Drops keys without a value, so a theme stores only what it sets. */
function compact<T extends object>(value: T): T | undefined {
  const kept = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length ? (kept as T) : undefined;
}

/** How the pages show light and dark: both with one first, or one only. */
const PAGES = ["darkFirst", "lightFirst", "dark", "light"] as const;
type Pages = (typeof PAGES)[number];

/**
 * The effect library as one row of chips. A group holds choices of one effect, so a chip of a
 * group takes the place of the group's other one.
 */
const CHIPS = [
  { chip: "glow", effect: { id: "glow" } },
  { chip: "fog", effect: { id: "fog" } },
  { chip: "webs", group: "corners", effect: { id: "corners", kind: "webs" } },
  { chip: "frost", group: "corners", effect: { id: "corners", kind: "frost" } },
  { chip: "embers", group: "particles", effect: { id: "particles", kind: "embers" } },
  { chip: "snow", group: "particles", effect: { id: "particles", kind: "snow" } },
  { chip: "confetti", group: "particles", effect: { id: "particles", kind: "confetti" } },
  { chip: "stars", group: "particles", effect: { id: "particles", kind: "stars" } },
  { chip: "dots", group: "pattern", effect: { id: "pattern", kind: "dots" } },
  { chip: "grid", group: "pattern", effect: { id: "pattern", kind: "grid" } },
  { chip: "figures", effect: { id: "figures" } },
] as const;

const chipOf = (e: ThemeEffect): string | undefined =>
  CHIPS.find((c) => c.effect.id === e.id && (!("kind" in c.effect) || c.effect.kind === e.kind))
    ?.chip;

function ThemeFields({
  theme,
  brandFonts,
  costume,
  change,
}: {
  theme: Theme | undefined;
  brandFonts: BrandFonts | undefined;
  /** The wizard's costume: the figures wear it. */
  costume: string | undefined;
  change: (patch: (t: Theme) => Theme) => void;
}) {
  // The theme's colours in their order: the first scheme shows first, one alone pins it.
  const listed = theme?.colors ?? [];
  const first: Mode = listed[0]?.scheme ?? "dark";
  const pages: Pages = listed.length === 1 ? first : first === "dark" ? "darkFirst" : "lightFirst";
  const modes: Mode[] =
    listed.length === 1 ? [first] : [first, first === "dark" ? "light" : "dark"];
  const entry = (list: ThemeColors[], scheme: Mode): ThemeColors =>
    list.find((c) => c.scheme === scheme) ?? { scheme };
  const colour = (mode: Mode, key: keyof ThemeColours, v: string | undefined) =>
    change((x) => {
      const list = x.colors ?? [];
      const next = { ...entry(list, mode), [key]: v } as ThemeColors;
      if (v === undefined) {
        delete next[key];
      }
      const colors = list.some((c) => c.scheme === mode)
        ? list.map((c) => (c.scheme === mode ? next : c))
        : [...list, next];
      return { ...x, colors };
    });
  const setPages = (p: Pages) =>
    change((x) => {
      const list = x.colors ?? [];
      const order: Mode[] =
        p === "darkFirst" ? ["dark", "light"] : p === "lightFirst" ? ["light", "dark"] : [p];
      return { ...x, colors: order.map((s) => entry(list, s)) };
    });
  // The brand's font for the role comes first; choosing it stores the role, never the family.
  const fonts = (family: string | null | undefined) => [
    {
      value: "brand",
      label: family ? t("inspector.lookFontBrandNamed", { family }) : t("inspector.lookFontBrand"),
    },
    ...SHIPPED_FONTS.map((f) => ({ value: f, label: f })),
  ];
  const shape = <K extends keyof NonNullable<Theme["shape"]>>(
    key: K,
    values: readonly string[],
  ) => (
    <div>
      <div className="mb-1 text-[0.8125rem] text-ink-3">{t(`inspector.lookShape.${key}`)}</div>
      <Select
        value={String(theme?.shape?.[key] ?? values[0])}
        options={values.map((v) => ({
          value: v,
          label: t(`inspector.lookShape.${key}.${v}` as never),
        }))}
        onChange={(v) => change((x) => ({ ...x, shape: compact({ ...x.shape, [key]: v }) }))}
      />
    </div>
  );
  const active = (theme?.effects ?? []).map(chipOf).filter((c): c is string => Boolean(c));
  const setChips = (on: string[]) =>
    change((x) => {
      const added = on.filter((c) => !active.includes(c));
      // A chip of a group takes the place of the group's chip that was on.
      const kept = on.filter((c) => {
        const group = CHIPS.find((x) => x.chip === c && "group" in x);
        if (!group || !("group" in group)) {
          return true;
        }
        const rival = added.find(
          (a) =>
            a !== c && CHIPS.some((x) => x.chip === a && "group" in x && x.group === group.group),
        );
        return !rival;
      });
      const figure = costume ?? "bat";
      const effects = kept.map((c) => {
        const found = CHIPS.find((x) => x.chip === c);
        return c === "figures"
          ? { id: "figures", costume: figure, motion: figure === "bat" ? "fly" : "peek" }
          : ({ ...found?.effect } as ThemeEffect);
      });
      const others = (x.effects ?? []).filter((e) => !chipOf(e));
      const all = [...effects, ...others];
      return { ...x, effects: all.length ? all : undefined };
    });
  return (
    <>
      <div>
        <Label hint={t("inspector.lookPagesHint")}>{t("inspector.lookPages")}</Label>
        <Segmented
          value={pages}
          options={[...PAGES]}
          label={(o) => t(`inspector.lookPages.${o as Pages}`)}
          onChange={setPages}
        />
      </div>
      {modes.map((mode) => (
        <div key={mode} className="grid grid-cols-2 gap-4">
          <ColourField
            label={t(`inspector.lookAccent.${mode}`)}
            value={themeColors(theme, mode)?.accent}
            fallback="#e0531b"
            onChange={(v) => colour(mode, "accent", v)}
          />
          <ColourField
            label={t(`inspector.lookBackground.${mode}`)}
            value={themeColors(theme, mode)?.background}
            fallback={mode === "dark" ? "#17131d" : "#faf8f5"}
            onChange={(v) => colour(mode, "background", v)}
          />
        </div>
      ))}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>{t("inspector.lookDisplayFont")}</Label>
          <Select
            value={theme?.fonts?.heading ?? "brand"}
            options={fonts(brandFonts?.heading)}
            onChange={(v) => change((x) => ({ ...x, fonts: compact({ ...x.fonts, heading: v }) }))}
          />
        </div>
        <div>
          <Label>{t("inspector.lookBodyFont")}</Label>
          <Select
            value={theme?.fonts?.text ?? "brand"}
            options={fonts(brandFonts?.text)}
            onChange={(v) => change((x) => ({ ...x, fonts: compact({ ...x.fonts, text: v }) }))}
          />
        </div>
      </div>
      <div>
        <Label>{t("inspector.lookShape")}</Label>
        <div className="grid grid-cols-3 gap-3">
          {shape("radius", ["soft", "sharp", "round"])}
          {shape("cards", ["solid", "outline", "glass"])}
          {shape("headings", ["normal", "uppercase"])}
        </div>
      </div>
      <div>
        <Label hint={t("inspector.lookEffectsHint")}>{t("inspector.lookEffects")}</Label>
        <Segmented
          multi
          value={active}
          options={CHIPS.map((c) => c.chip)}
          label={(o) => t(`inspector.lookChip.${o as (typeof CHIPS)[number]["chip"]}`)}
          onChange={setChips}
        />
      </div>
    </>
  );
}
