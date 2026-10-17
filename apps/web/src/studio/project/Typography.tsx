import {
  type BrandFont,
  type BrandRule,
  FONT_USES,
  FONT_WEIGHTS,
  type FontUse,
  PROJECT_LIMITS,
  type TextStyle,
} from "@engenty-wizards/shared/projects";
import { CaseUpper, Check, Link, ListChecks, Plus, Rows3, Trash2 } from "lucide-react";
import { type CSSProperties, type InputHTMLAttributes, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { Button, cn, Dialog, IconButton, Input, Label } from "../../ui";
import { useAutosave } from "./data";
import {
  type AddEntry,
  AddMenu,
  InlineText,
  newId,
  RuleRows,
  Section,
  useRuleRows,
} from "./Section";

/**
 * Loads a family for its preview from Bunny Fonts, the mirror of Google Fonts that keeps no
 * logs; a font installed on the computer shows either way. Each family is asked for once.
 */
const loaded = new Set<string>();
function useWebFont(family: string) {
  useEffect(() => {
    const slug = family.trim().toLowerCase().replace(/\s+/g, "-");
    if (!slug || loaded.has(slug)) {
      return;
    }
    loaded.add(slug);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.bunny.net/css?family=${encodeURIComponent(slug)}:${FONT_WEIGHTS.join(",")}&display=swap`;
    document.head.append(link);
  }, [family]);
}

const stack = (family: string | undefined) =>
  family ? `"${family}", system-ui, sans-serif` : "system-ui, sans-serif";

/** A number field small enough for a row of them, with its unit after it. */
function Num({
  unit,
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { unit: string; label: string }) {
  return (
    <label className="inline-flex items-center gap-1 text-[0.75rem] text-ink-3" title={label}>
      <input
        type="number"
        aria-label={label}
        className="h-8 w-14 rounded-md border border-input bg-card px-1.5 text-right text-[0.8125rem] text-ink tabular-nums outline-none transition focus:border-focus focus:ring-2 focus:ring-focus-glow"
        {...rest}
      />
      {unit}
    </label>
  );
}

const mini =
  "h-8 rounded-md border border-input bg-card px-1.5 text-[0.8125rem] text-ink outline-none transition focus:border-focus focus:ring-2 focus:ring-focus-glow";

/** A font as a card: the family drawn large, what it is for, the weights the brand uses. */
const USE_LABELS: Record<FontUse, Parameters<typeof t>[0]> = {
  web: "project.fontUseWeb",
  documents: "project.fontUseDocuments",
  print: "project.fontUsePrint",
  images: "project.fontUseImages",
  video: "project.fontUseVideo",
};

function FontCard({
  font,
  first,
  readOnly,
  autoFocus,
  onChange,
  onRemove,
}: {
  font: BrandFont;
  first: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  onChange: (patch: Partial<BrandFont>) => void;
  onRemove: () => void;
}) {
  useWebFont(font.family);
  return (
    <div className="group/font relative flex flex-col gap-2 rounded-lg bg-paper p-3 ring-1 ring-border-soft">
      <div
        className="flex h-28 items-end justify-between overflow-hidden rounded-md bg-card px-4 pb-3 ring-1 ring-border-soft"
        style={{ fontFamily: stack(font.family) }}
      >
        <span className="text-[3.5rem] text-ink leading-none">Aa</span>
        <span className="truncate pl-3 text-[0.875rem] text-ink-3">ABCDEFG abcdefg 0123456789</span>
      </div>
      {readOnly ? (
        <>
          <div className="font-medium text-[0.9375rem]">{font.family}</div>
          {font.role ? <p className="text-[0.875rem] text-ink-3">{font.role}</p> : null}
        </>
      ) : (
        <div>
          <InlineText
            value={font.family}
            label={t("project.fontFamily")}
            placeholder={t("project.fontFamily")}
            maxLength={80}
            autoFocus={autoFocus}
            onChange={(family) => onChange({ family })}
            className="font-medium text-[0.9375rem]"
          />
          <InlineText
            value={font.role}
            label={t("project.fontRole")}
            placeholder={first ? t("project.fontRoleFirst") : t("project.fontRole")}
            maxLength={200}
            onChange={(role) => onChange({ role })}
            className="text-[0.875rem] text-ink-3"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {FONT_WEIGHTS.map((w) => {
          const on = font.weights.includes(w);
          return (
            <button
              key={w}
              type="button"
              disabled={readOnly}
              aria-pressed={on}
              onClick={() =>
                onChange({
                  weights: on
                    ? font.weights.filter((x) => x !== w)
                    : [...font.weights, w].sort((a, b) => a - b),
                })
              }
              style={{ fontFamily: stack(font.family), fontWeight: w }}
              className={cn(
                "h-7 rounded-full px-2.5 text-[0.8125rem] tabular-nums transition",
                on ? "bg-ink text-paper" : "bg-paper-2 text-ink-3 hover:text-ink",
                readOnly && !on && "hidden",
              )}
            >
              {w}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-1">
        {readOnly ? (
          font.license ? (
            <p className="text-[0.8125rem] text-ink-3">{font.license}</p>
          ) : null
        ) : (
          <InlineText
            value={font.license ?? ""}
            label={t("project.fontLicense")}
            placeholder={t("project.fontLicensePlaceholder")}
            maxLength={200}
            onChange={(license) => onChange({ license })}
            className="text-[0.8125rem] text-ink-3"
          />
        )}
        {readOnly && !font.uses?.length ? null : (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[0.8125rem] text-ink-3">{t("project.fontUses")}</span>
            {FONT_USES.map((u) => {
              const on = Boolean(font.uses?.includes(u));
              return (
                <button
                  key={u}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={on}
                  onClick={() => {
                    const uses = on
                      ? (font.uses ?? []).filter((x) => x !== u)
                      : FONT_USES.filter((x) => x === u || font.uses?.includes(x));
                    onChange({ uses: uses.length ? uses : undefined });
                  }}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[0.8125rem] transition",
                    on
                      ? "bg-card text-ink ring-1 ring-border"
                      : "bg-paper-2 text-ink-3 hover:text-ink",
                    readOnly && !on && "hidden",
                  )}
                >
                  {on ? <Check className="size-3.5" /> : null}
                  {t(USE_LABELS[u])}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {readOnly ? null : (
        <IconButton
          label={t("project.remove")}
          onClick={onRemove}
          className="absolute top-4 right-4 size-8 bg-card opacity-0 shadow-soft transition focus:opacity-100 group-hover/font:opacity-100 coarse:opacity-100 hover:text-rose"
        >
          <Trash2 className="size-4" />
        </IconButton>
      )}
    </div>
  );
}

/** A text style: a line set in it, and what it is made of underneath. */
function StyleRow({
  style,
  fonts,
  sample,
  readOnly,
  autoFocus,
  onChange,
  onRemove,
}: {
  style: TextStyle;
  fonts: BrandFont[];
  sample: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  onChange: (patch: Partial<TextStyle>) => void;
  onRemove: () => void;
}) {
  const font = fonts.find((f) => f.id === style.font) ?? fonts[0];
  const look: CSSProperties = {
    fontFamily: stack(font?.family),
    fontWeight: style.weight,
    // Large sizes are drawn smaller here; the numbers say what they are.
    fontSize: `${Math.min(style.size, 56)}px`,
    lineHeight: `${style.lineHeight}%`,
    letterSpacing: `${style.tracking / 100}em`,
    textTransform: style.uppercase ? "uppercase" : undefined,
  };
  return (
    <li className="group/row flex flex-col gap-2 border-border-soft border-b py-4 first:pt-1 last:border-b-0">
      <div className="truncate text-ink" style={look}>
        {sample}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {readOnly ? (
          <span className="font-medium text-[0.8125rem] text-ink-2 uppercase tracking-wide">
            {style.name}
          </span>
        ) : (
          <div className="w-40">
            <InlineText
              value={style.name}
              label={t("project.styleName")}
              placeholder={t("project.styleName")}
              maxLength={60}
              autoFocus={autoFocus}
              onChange={(name) => onChange({ name })}
              className="font-medium text-[0.8125rem] text-ink-2 uppercase tracking-wide"
            />
          </div>
        )}
        <fieldset disabled={readOnly} className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {fonts.length > 1 ? (
            <select
              aria-label={t("project.styleFont")}
              value={font?.id ?? ""}
              onChange={(e) => onChange({ font: e.target.value })}
              className={cn(mini, "max-w-40")}
            >
              {fonts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.family || t("project.fontFamily")}
                </option>
              ))}
            </select>
          ) : null}
          <select
            aria-label={t("project.styleWeight")}
            value={style.weight}
            onChange={(e) => onChange({ weight: Number(e.target.value) })}
            className={mini}
          >
            {[...new Set([...FONT_WEIGHTS, style.weight])].sort().map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <Num
            unit="px"
            label={t("project.styleSize")}
            min={6}
            max={400}
            value={style.size}
            onChange={(e) => onChange({ size: Number(e.target.value) || 16 })}
          />
          <Num
            unit={t("project.styleLine")}
            label={t("project.styleLineLabel")}
            min={50}
            max={300}
            value={style.lineHeight}
            onChange={(e) => onChange({ lineHeight: Number(e.target.value) || 100 })}
          />
          <Num
            unit={t("project.styleTracking")}
            label={t("project.styleTrackingLabel")}
            min={-20}
            max={50}
            step={0.5}
            value={style.tracking}
            onChange={(e) => onChange({ tracking: Number(e.target.value) || 0 })}
          />
          <button
            type="button"
            aria-pressed={Boolean(style.uppercase)}
            title={t("project.styleUpper")}
            aria-label={t("project.styleUpper")}
            onClick={() => onChange({ uppercase: !style.uppercase })}
            className={cn(
              "grid size-8 place-items-center rounded-md transition",
              style.uppercase ? "bg-ink text-paper" : "text-ink-3 hover:bg-paper-2 hover:text-ink",
            )}
          >
            <CaseUpper className="size-4" />
          </button>
        </fieldset>
        {readOnly ? null : (
          <IconButton
            label={t("project.remove")}
            onClick={onRemove}
            className="ml-auto size-8 opacity-0 transition focus:opacity-100 group-hover/row:opacity-100 coarse:opacity-100 hover:text-rose"
          >
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
    </li>
  );
}

/** The fonts a web page uses, to pick the brand's from. */
function FontsFromUrl({
  projectId,
  onAdd,
  onClose,
}: {
  projectId: string;
  onAdd: (fonts: { family: string; weights: number[] }[]) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ family: string; weights: number[] }[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const { fonts } = await api.post<{ fonts: { family: string; weights: number[] }[] }>(
        `/api/studio/projects/${projectId}/fonts/scan`,
        { url: url.trim() },
      );
      if (fonts.length) {
        setFound(fonts);
        setPicked(fonts.slice(0, 2).map((f) => f.family));
      } else {
        setError(t("project.fontsNoneFound"));
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      wide={found ? true : undefined}
      title={found ? t("project.fontsFound") : t("project.fontsFromUrl")}
    >
      {found ? (
        <div className="flex flex-col gap-5">
          <p className="-mt-2 text-[0.875rem] text-ink-3">{t("project.fontsFoundHint")}</p>
          <div className="flex flex-col gap-2">
            {found.map((f) => (
              <FoundFont
                key={f.family}
                font={f}
                on={picked.includes(f.family)}
                onToggle={() =>
                  setPicked((all) =>
                    all.includes(f.family) ? all.filter((x) => x !== f.family) : [...all, f.family],
                  )
                }
              />
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFound(null)}>
              {t("run.back")}
            </Button>
            <Button
              disabled={!picked.length}
              onClick={() => {
                onAdd(found.filter((f) => picked.includes(f.family)));
                onClose();
              }}
            >
              {picked.length > 1 ? t("project.addMany", { n: picked.length }) : t("project.add")}
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
          className="flex flex-col gap-5"
        >
          <div>
            <Label>{t("project.logoUrl")}</Label>
            <Input
              autoFocus
              value={url}
              inputMode="url"
              placeholder="https://example.com"
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="mt-1.5 text-[0.8125rem] text-ink-3">{t("project.fontsUrlHint")}</p>
          </div>
          {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" busy={busy} disabled={!url.trim()}>
              {t("run.next")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function FoundFont({
  font,
  on,
  onToggle,
}: {
  font: { family: string; weights: number[] };
  on: boolean;
  onToggle: () => void;
}) {
  useWebFont(font.family);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "flex items-center gap-4 rounded-lg px-4 py-3 text-left ring-1 transition",
        on ? "ring-2 ring-ember" : "ring-border-soft hover:ring-ink-4",
      )}
    >
      <span
        className="text-[2rem] text-ink leading-none"
        style={{ fontFamily: stack(font.family) }}
      >
        Aa
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-[0.9375rem]">{font.family}</span>
        <span className="text-[0.8125rem] text-ink-3 tabular-nums">
          {font.weights.length ? font.weights.join(" · ") : t("project.fontWeightsUnknown")}
        </span>
      </span>
      {on ? (
        <span className="grid size-5 place-items-center rounded-full bg-ember text-white">
          <Check className="size-3.5" />
        </span>
      ) : null}
    </button>
  );
}

/**
 * The brand's type: its fonts, each with what it is for and the weights it uses; optionally a
 * type scale of named text styles, and rules for how type may be used (behind the switch
 * `brandRules`, as the other rules).
 */
export function Typography({
  projectId,
  fonts: savedFonts,
  styles: savedStyles,
  rules: savedRules,
  ruled,
  sample,
  save,
  readOnly,
}: {
  projectId: string;
  fonts: BrandFont[];
  styles: TextStyle[];
  rules: BrandRule[];
  /** Rules are shown and can be added. */
  ruled: boolean;
  /** What the text styles show: the space's title, or a line of its own. */
  sample: string;
  save: (patch: {
    fonts: BrandFont[];
    textStyles: TextStyle[];
    typeRules: BrandRule[];
  }) => Promise<unknown>;
  readOnly?: boolean;
}) {
  const [fonts, setFonts] = useState(savedFonts);
  const [styles, setStyles] = useState(savedStyles);
  const rules = useRuleRows(savedRules);
  const [focus, setFocus] = useState<string | null>(null);
  const [fromUrl, setFromUrl] = useState(false);
  const status = useAutosave({ fonts, textStyles: styles, typeRules: rules.rules }, save);
  const addFonts = (list: { family: string; weights: number[] }[], focusIt = false) => {
    const added = list.map((f) => ({
      id: newId(),
      family: f.family,
      role: "",
      weights: f.weights,
    }));
    if (focusIt && added[0]) {
      setFocus(added[0].id);
    }
    setFonts((all) => [...all, ...added].slice(0, PROJECT_LIMITS.fonts));
  };
  const addStyle = () => {
    const id = newId();
    setFocus(id);
    setStyles((all) => [
      ...all,
      { id, name: "", size: 16, weight: 400, lineHeight: 150, tracking: 0 },
    ]);
  };

  const add: AddEntry[] = [
    ...(fonts.length < PROJECT_LIMITS.fonts
      ? [
          {
            label: t("project.fontNew"),
            icon: <Plus className="size-4 shrink-0" />,
            onPick: () => addFonts([{ family: "", weights: [400, 700] }], true),
          },
          {
            label: t("project.fontsFromUrl"),
            icon: <Link className="size-4 shrink-0" />,
            onPick: () => setFromUrl(true),
          },
        ]
      : []),
    ...(styles.length < PROJECT_LIMITS.textStyles
      ? [
          {
            label: t("project.styleNew"),
            icon: <Rows3 className="size-4 shrink-0" />,
            onPick: addStyle,
          },
        ]
      : []),
    ...(!ruled || rules.full
      ? []
      : [
          {
            label: t("project.ruleNew"),
            icon: <ListChecks className="size-4 shrink-0" />,
            onPick: () => rules.add(),
          },
        ]),
  ];

  return (
    <Section
      title={t("project.typography")}
      hint={t("project.typographyHint")}
      save={status}
      action={readOnly ? null : <AddMenu entries={add} />}
    >
      <div className="flex flex-col gap-7">
        {fonts.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {fonts.map((f, i) => (
              <FontCard
                key={f.id}
                font={f}
                first={i === 0}
                readOnly={readOnly}
                autoFocus={focus === f.id}
                onChange={(patch) =>
                  setFonts((all) => all.map((x) => (x.id === f.id ? { ...x, ...patch } : x)))
                }
                onRemove={() => setFonts((all) => all.filter((x) => x.id !== f.id))}
              />
            ))}
          </div>
        ) : (
          <p className="text-[0.875rem] text-ink-3">{t("project.fontsEmpty")}</p>
        )}

        {styles.length ? (
          <div>
            <h3 className="font-medium text-[0.9375rem]">{t("project.styles")}</h3>
            {readOnly ? null : (
              <p className="text-[0.875rem] text-ink-3 leading-snug">{t("project.stylesHint")}</p>
            )}
            <ul className="mt-2 flex flex-col">
              {styles.map((s) => (
                <StyleRow
                  key={s.id}
                  style={s}
                  fonts={fonts}
                  sample={sample}
                  readOnly={readOnly}
                  autoFocus={focus === s.id}
                  onChange={(patch) =>
                    setStyles((all) => all.map((x) => (x.id === s.id ? { ...x, ...patch } : x)))
                  }
                  onRemove={() => setStyles((all) => all.filter((x) => x.id !== s.id))}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {ruled ? (
          <RuleRows
            rules={rules}
            placeholder={t("project.typeRulePlaceholder")}
            readOnly={readOnly}
          />
        ) : null}
      </div>
      {fromUrl ? (
        <FontsFromUrl
          projectId={projectId}
          onClose={() => setFromUrl(false)}
          onAdd={(list) => addFonts(list)}
        />
      ) : null}
    </Section>
  );
}
