import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunFontFace } from "@engenty/wizards-shared/run";
import {
  freeThemeId,
  SHIPPED_FONTS,
  THEME_EFFECTS,
  type Theme,
  type ThemeColours,
  type ThemeEffect,
  type ThemeEffectId,
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

const PAGES = ["both", "dark", "light"] as const;
const OFF = "off";

/** The effects with one option to choose, and the option's values (THEME_EFFECTS). */
const CHOICES: { id: ThemeEffectId; option: string; values: readonly string[] }[] = [
  { id: "corners", option: "kind", values: THEME_EFFECTS.corners.kind },
  { id: "particles", option: "kind", values: THEME_EFFECTS.particles.kind },
  { id: "pattern", option: "kind", values: THEME_EFFECTS.pattern.kind },
];

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
          preview
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
              <ThemeFields theme={draft} brandFonts={brandFonts} change={change} />
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

function ThemeFields({
  theme,
  brandFonts,
  change,
}: {
  theme: Theme | undefined;
  brandFonts: BrandFonts | undefined;
  change: (patch: (t: Theme) => Theme) => void;
}) {
  const pages =
    theme?.light && !theme.dark ? "light" : theme?.dark && !theme.light ? "dark" : "both";
  const modes: Mode[] = pages === "both" ? ["light", "dark"] : [pages];
  const colour = (mode: Mode, key: keyof ThemeColours, v: string | undefined) =>
    change((x) => ({ ...x, [mode]: compact({ ...(x[mode] ?? {}), [key]: v }) }));
  const setPages = (p: (typeof PAGES)[number]) =>
    change((x) => ({
      ...x,
      light: p === "dark" ? undefined : (x.light ?? {}),
      dark: p === "light" ? undefined : (x.dark ?? {}),
      prefer: p === "both" ? x.prefer : undefined,
    }));
  // The brand's font for the role comes first; choosing it stores the role, never the family.
  const fonts = (family: string | null | undefined) => [
    {
      value: "brand",
      label: family ? t("inspector.lookFontBrandNamed", { family }) : t("inspector.lookFontBrand"),
    },
    ...SHIPPED_FONTS.map((f) => ({ value: f, label: f })),
  ];
  const effect = (id: string) => theme?.effects?.find((e) => e.id === id);
  const setEffect = (id: string, next: ThemeEffect | undefined) =>
    change((x) => {
      const rest = (x.effects ?? []).filter((e) => e.id !== id);
      const effects = next ? [...rest, next] : rest;
      return { ...x, effects: effects.length ? effects : undefined };
    });
  const figures = effect("figures");
  return (
    <>
      <div>
        <Label hint={t("inspector.lookPagesHint")}>{t("inspector.lookPages")}</Label>
        <Segmented
          value={pages}
          options={[...PAGES]}
          label={(o) => t(`inspector.lookPages.${o as (typeof PAGES)[number]}`)}
          onChange={setPages}
        />
      </div>
      {pages === "both" ? (
        <div>
          <Label>{t("inspector.lookPrefer")}</Label>
          <Segmented
            value={theme?.prefer ?? "dark"}
            options={["light", "dark"]}
            label={(o) => t(`inspector.lookMode.${o as Mode}`)}
            onChange={(o: Mode) => change((x) => ({ ...x, prefer: o }))}
          />
        </div>
      ) : null}
      {modes.map((mode) => (
        <div key={mode} className="grid grid-cols-2 gap-4">
          <ColourField
            label={t(`inspector.lookAccent.${mode}`)}
            value={theme?.[mode]?.accent}
            fallback="#e0531b"
            onChange={(v) => colour(mode, "accent", v)}
          />
          <ColourField
            label={t(`inspector.lookBackground.${mode}`)}
            value={theme?.[mode]?.background}
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
        <div className="flex flex-col gap-2">
          <Segmented
            value={theme?.shape?.radius ?? "soft"}
            options={["sharp", "soft", "round"]}
            label={(o) => t(`inspector.lookShape.radius.${o as "sharp" | "soft" | "round"}`)}
            onChange={(o: "sharp" | "soft" | "round") =>
              change((x) => ({ ...x, shape: compact({ ...x.shape, radius: o }) }))
            }
          />
          <Segmented
            value={theme?.shape?.cards ?? "solid"}
            options={["solid", "outline", "glass"]}
            label={(o) => t(`inspector.lookShape.cards.${o as "solid" | "outline" | "glass"}`)}
            onChange={(o: "solid" | "outline" | "glass") =>
              change((x) => ({ ...x, shape: compact({ ...x.shape, cards: o }) }))
            }
          />
          <Segmented
            value={theme?.shape?.headings ?? "normal"}
            options={["normal", "uppercase"]}
            label={(o) => t(`inspector.lookShape.headings.${o as "normal" | "uppercase"}`)}
            onChange={(o: "normal" | "uppercase") =>
              change((x) => ({ ...x, shape: compact({ ...x.shape, headings: o }) }))
            }
          />
        </div>
      </div>
      <div>
        <Label>{t("inspector.lookEffects")}</Label>
        <div className="flex flex-col gap-3">
          <Segmented
            multi
            value={["glow", "fog"].filter((id) => effect(id))}
            options={["glow", "fog"]}
            label={(o) => t(`inspector.lookEffect.${o as "glow" | "fog"}`)}
            onChange={(on: string[]) => {
              for (const id of ["glow", "fog"]) {
                if (on.includes(id) !== Boolean(effect(id))) {
                  setEffect(id, on.includes(id) ? { id } : undefined);
                }
              }
            }}
          />
          {CHOICES.map((c) => (
            <div key={c.id}>
              <div className="mb-1 text-[0.8125rem] text-ink-3">
                {t(`inspector.lookEffect.${c.id}`)}
              </div>
              <Segmented
                value={String(effect(c.id)?.[c.option] ?? OFF)}
                options={[OFF, ...c.values]}
                label={(o) => t(`inspector.lookEffectOption.${o}` as never)}
                onChange={(o: string) =>
                  setEffect(c.id, o === OFF ? undefined : { id: c.id, [c.option]: o })
                }
              />
            </div>
          ))}
          <div>
            <div className="mb-1 text-[0.8125rem] text-ink-3">
              {t("inspector.lookEffect.figures")}
            </div>
            <div className="flex flex-col gap-2">
              <Segmented
                value={String(figures?.costume ?? OFF)}
                options={[OFF, ...THEME_EFFECTS.figures.costume]}
                label={(o) =>
                  o === OFF
                    ? t("inspector.lookEffectOption.off")
                    : t(`inspector.costume.${o}` as never)
                }
                onChange={(o: string) =>
                  setEffect(
                    "figures",
                    o === OFF
                      ? undefined
                      : { id: "figures", costume: o, motion: String(figures?.motion ?? "fly") },
                  )
                }
              />
              {figures ? (
                <Segmented
                  value={String(figures.motion ?? "fly")}
                  options={[...THEME_EFFECTS.figures.motion]}
                  label={(o) => t(`inspector.lookEffectOption.${o}` as never)}
                  onChange={(o: string) => setEffect("figures", { ...figures, motion: o })}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
