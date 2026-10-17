import type {
  BrandColor,
  BrandGradient,
  BrandPattern,
  BrandRule,
  ColorSection,
} from "@engenty-wizards/shared/projects";
import { PROJECT_LIMITS } from "@engenty-wizards/shared/projects";
import {
  ArrowUp,
  Blend,
  Check,
  FolderPlus,
  Grid2x2,
  Link,
  ListChecks,
  Palette,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { Button, Chip, cn, Dialog, IconButton, Input, Label, Swatch } from "../../ui";
import { type ProjectFiles, useAutosave, useFileActions } from "./data";
import { GradientCard, GradientEditor, PatternCard, PatternEditor } from "./Gradients";
import {
  type AddEntry,
  AddMenu,
  AddRow,
  MoveButton,
  newId,
  RuleRows,
  Section,
  SubSectionHead,
  useRuleRows,
} from "./Section";

const HEX = /^#[0-9a-fA-F]{6}$/;

type Row = BrandColor & { id: string };

/** Colours read off a web page's stylesheet, to pick the brand's from. */
function ColorsFromUrl({
  projectId,
  onAdd,
  onClose,
}: {
  projectId: string;
  onAdd: (colors: BrandColor[]) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<BrandColor[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const { colors } = await api.post<{ colors: BrandColor[] }>(
        `/api/studio/projects/${projectId}/colors/scan`,
        { url: url.trim() },
      );
      if (colors.length) {
        setFound(colors);
        setPicked([]);
      } else {
        setError(t("project.colorsNoneFound"));
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
      title={found ? t("project.colorsFound") : t("project.colorsFromUrl")}
    >
      {found ? (
        <div className="flex flex-col gap-5">
          <p className="-mt-2 text-[0.875rem] text-ink-3">{t("project.colorsFoundHint")}</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {found.map((c) => {
              const on = picked.includes(c.value);
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setPicked((all) => (on ? all.filter((v) => v !== c.value) : [...all, c.value]))
                  }
                  className={cn(
                    "relative flex flex-col overflow-hidden rounded-lg text-left ring-1 transition",
                    on ? "ring-2 ring-ember" : "ring-border-soft hover:ring-ink-4",
                  )}
                >
                  <span className="h-16" style={{ background: c.value }} />
                  <span className="flex flex-col px-2.5 py-2">
                    <span className="truncate text-[0.8125rem] text-ink-2">{c.name || "—"}</span>
                    <span className="font-mono text-[0.75rem] text-ink-3">{c.value}</span>
                  </span>
                  {on ? (
                    <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-ember text-white">
                      <Check className="size-3.5" />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFound(null)}>
              {t("run.back")}
            </Button>
            <Button
              disabled={!picked.length}
              onClick={() => {
                onAdd(found.filter((c) => picked.includes(c.value)));
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
            <p className="mt-1.5 text-[0.8125rem] text-ink-3">{t("project.colorsUrlHint")}</p>
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

/**
 * The brand's colours by name. The standard ones come first; the first of them is the accent.
 * Two optional parts, as for the logos: sections for a further palette of its own use, and rules
 * for how the colours may be used. They wait behind the switches `brandSections` (without it every
 * colour stands with the standard ones, and gradients and patterns are not shown) and
 * `brandRules`.
 */
export function Colors({
  projectId,
  data,
  colors,
  sections: savedSections,
  gradients: savedGradients,
  patterns: savedPatterns,
  rules: savedRules,
  sectioned,
  ruled,
  save,
  readOnly,
}: {
  projectId: string;
  /** The space's files: a pattern's picture is one of them. */
  data: ProjectFiles;
  colors: BrandColor[];
  sections: ColorSection[];
  gradients: BrandGradient[];
  patterns: BrandPattern[];
  rules: BrandRule[];
  /** Sections (gradients and patterns among them) are shown and can be added. */
  sectioned: boolean;
  /** Rules are shown and can be added. */
  ruled: boolean;
  save: (patch: {
    colors: BrandColor[];
    colorSections: ColorSection[];
    gradients: BrandGradient[];
    patterns: BrandPattern[];
    colorRules: BrandRule[];
  }) => Promise<unknown>;
  /** The colours are there to see: no value is changed, none added, moved or removed. */
  readOnly?: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(() => colors.map((c) => ({ ...c, id: newId() })));
  const [sections, setSections] = useState(savedSections);
  const [gradients, setGradients] = useState(savedGradients);
  const [patterns, setPatterns] = useState(savedPatterns);
  const [editing, setEditing] = useState<BrandGradient | null>(null);
  const [tiling, setTiling] = useState<BrandPattern | null>(null);
  const actions = useFileActions(projectId, readOnly);
  const rules = useRuleRows(savedRules);
  const [titleFor, setTitleFor] = useState<string | null>(null);
  /** The row just added: its name is where the cursor goes. */
  const [fresh, setFresh] = useState<string | null>(null);
  const [fromUrl, setFromUrl] = useState(false);
  // A value still being typed is not a colour yet: it is saved once it is one.
  const status = useAutosave(
    {
      colors: rows
        .filter((r) => HEX.test(r.value))
        .map(({ name, value, section }) => ({
          name: name.trim(),
          value,
          ...(section ? { section } : {}),
        })),
      colorSections: sections,
      gradients,
      patterns,
      colorRules: rules.rules,
    },
    save,
  );
  const shown = sectioned ? sections : [];
  const colourSections = shown.filter((s) => (s.kind ?? "colors") === "colors");
  const known = (r: Row) => colourSections.some((s) => s.id === r.section);
  const standard = rows.filter((r) => !known(r));
  const accentId = (standard[0] ?? rows[0])?.id;
  const set = (id: string, patch: Partial<Row>) =>
    setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const append = (added: BrandColor[]) =>
    setRows((all) =>
      [...all, ...added.map((c) => ({ ...c, id: newId() }))].slice(0, PROJECT_LIMITS.colors),
    );
  const moveOptions = [
    { value: "", label: t("project.sectionStandard") },
    ...colourSections.map((s) => ({
      value: s.id,
      label: s.title || t("project.sectionUntitled"),
    })),
  ];
  const newSection = (kind: ColorSection["kind"], title: string) => {
    const id = newId();
    setTitleFor(id);
    setSections((all) => [...all, { id, title, ...(kind === "colors" ? {} : { kind }) }]);
  };
  /** A first gradient from the brand's own colours. */
  const freshGradient = (section: string): BrandGradient => ({
    id: newId(),
    name: "",
    section,
    type: "linear",
    angle: 90,
    stops: [
      { color: rows[0]?.value && HEX.test(rows[0].value) ? rows[0].value : "#4b73ff", at: 0 },
      { color: rows[1]?.value && HEX.test(rows[1].value) ? rows[1].value : "#ff6d1b", at: 100 },
    ],
  });
  const fileName = (id: string) => data.files.find((f) => f.id === id)?.name ?? "pattern";

  const add: AddEntry[] = [
    ...(rows.length < PROJECT_LIMITS.colors
      ? [
          {
            label: t("project.colorNew"),
            icon: <Plus className="size-4 shrink-0" />,
            onPick: () => addRow(),
          },
          {
            label: t("project.colorsFromUrl"),
            icon: <Link className="size-4 shrink-0" />,
            onPick: () => setFromUrl(true),
          },
        ]
      : []),
    ...(sectioned && sections.length < PROJECT_LIMITS.logoSections
      ? [
          {
            label: t("project.colorSectionAdd"),
            icon: <FolderPlus className="size-4 shrink-0" />,
            onPick: () => newSection("colors", ""),
          },
          {
            label: t("project.gradientSectionAdd"),
            icon: <Blend className="size-4 shrink-0" />,
            onPick: () => newSection("gradients", t("project.gradientSectionTitle")),
          },
          {
            label: t("project.patternSectionAdd"),
            icon: <Grid2x2 className="size-4 shrink-0" />,
            onPick: () => newSection("patterns", t("project.patternSectionTitle")),
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

  const row = (r: Row) => (
    <div key={r.id} className="group/row flex items-center gap-2">
      <Swatch
        value={HEX.test(r.value) ? r.value : "#888888"}
        onChange={(e) => set(r.id, { value: e.target.value })}
      />
      <Input
        value={r.name}
        autoFocus={r.id === fresh}
        placeholder={t("project.colorName")}
        maxLength={120}
        onChange={(e) => set(r.id, { name: e.target.value })}
        className="min-w-0 flex-1"
      />
      <Input
        value={r.value}
        placeholder="#e0531b"
        spellCheck={false}
        onChange={(e) => set(r.id, { value: e.target.value.trim() })}
        className="w-28 font-mono text-[0.8125rem]"
      />
      <div className="flex w-28 shrink-0 items-center justify-end max-sm:w-auto">
        {r.id === accentId ? (
          <span className="mr-1 max-sm:hidden">
            <Chip tone="ember">{t("project.colorAccent")}</Chip>
          </span>
        ) : readOnly ? null : (
          <IconButton
            label={t("project.colorFirst")}
            onClick={() =>
              setRows((all) => [{ ...r, section: undefined }, ...all.filter((x) => x.id !== r.id)])
            }
            className="opacity-0 transition focus:opacity-100 group-hover/row:opacity-100 coarse:opacity-100"
          >
            <ArrowUp className="size-4" />
          </IconButton>
        )}
        {readOnly || !colourSections.length ? null : (
          <MoveButton
            options={moveOptions}
            value={known(r) ? (r.section ?? "") : ""}
            onChange={(value) => set(r.id, { section: value || undefined })}
            className="opacity-0 focus-within:opacity-100 group-hover/row:opacity-100 coarse:opacity-100"
          />
        )}
        {readOnly ? null : (
          <IconButton
            label={t("project.remove")}
            onClick={() => setRows((all) => all.filter((x) => x.id !== r.id))}
            className="opacity-0 transition focus:opacity-100 group-hover/row:opacity-100 coarse:opacity-100 hover:text-rose"
          >
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
    </div>
  );
  /** A new row in place, its name to type; a section's when `section` is given. */
  const addRow = (section?: string) => {
    const id = newId();
    setFresh(id);
    setRows((all) => [...all, { id, name: "", value: "#888888", ...(section ? { section } : {}) }]);
  };

  return (
    <Section
      title={t("project.colors")}
      hint={t("project.colorsHint")}
      save={status}
      locked={readOnly}
      action={readOnly ? null : <AddMenu entries={add} />}
    >
      <div className="flex flex-col gap-7">
        {standard.length ? (
          <div>
            <div className="flex flex-col gap-2">{standard.map(row)}</div>
            {readOnly ? null : (
              <p className="mt-1.5 text-[0.8125rem] text-ink-3">{t("project.colorUse")}</p>
            )}
          </div>
        ) : rows.length ? null : (
          <p className="text-[0.875rem] text-ink-3">{t("project.colorsEmpty")}</p>
        )}

        {shown.map((s) => {
          const kind = s.kind ?? "colors";
          const own = rows.filter((r) => r.section === s.id);
          const fills = gradients.filter((g) => g.section === s.id);
          const tiles = patterns.filter((p) => p.section === s.id);
          const filled =
            kind === "gradients" ? fills.length : kind === "patterns" ? tiles.length : own.length;
          return (
            <div key={s.id} className="group/section flex flex-col gap-3">
              <SubSectionHead
                title={s.title}
                titlePlaceholder={t(
                  kind === "gradients"
                    ? "project.gradientSectionTitlePlaceholder"
                    : kind === "patterns"
                      ? "project.patternSectionTitlePlaceholder"
                      : "project.colorSectionTitle",
                )}
                kind={
                  kind === "gradients"
                    ? { icon: <Blend />, label: t("project.kindGradients") }
                    : kind === "patterns"
                      ? { icon: <Grid2x2 />, label: t("project.kindPatterns") }
                      : { icon: <Palette />, label: t("project.kindColors") }
                }
                autoFocus={titleFor === s.id}
                readOnly={readOnly}
                onChange={(patch) =>
                  setSections((all) => all.map((x) => (x.id === s.id ? { ...x, ...patch } : x)))
                }
                onRemove={() => {
                  if (
                    !filled ||
                    confirm(
                      t(
                        kind === "colors"
                          ? "project.colorSectionRemoveConfirm"
                          : "project.fillSectionRemoveConfirm",
                        { name: s.title || t("project.sectionUntitled") },
                      ),
                    )
                  ) {
                    setSections((all) => all.filter((x) => x.id !== s.id));
                    setRows((all) =>
                      all.map((r) => (r.section === s.id ? { ...r, section: undefined } : r)),
                    );
                    setGradients((all) => all.filter((g) => g.section !== s.id));
                    for (const p of tiles) {
                      void actions.remove(p.file);
                    }
                    setPatterns((all) => all.filter((p) => p.section !== s.id));
                  }
                }}
              />
              {kind === "gradients" ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                  {fills.map((g) => (
                    <GradientCard
                      key={g.id}
                      gradient={g}
                      readOnly={readOnly}
                      onEdit={() => setEditing(g)}
                      onChange={(patch) =>
                        setGradients((all) =>
                          all.map((x) => (x.id === g.id ? { ...x, ...patch } : x)),
                        )
                      }
                      onRemove={() => setGradients((all) => all.filter((x) => x.id !== g.id))}
                    />
                  ))}
                  {readOnly || gradients.length >= PROJECT_LIMITS.gradients ? null : (
                    <button
                      type="button"
                      onClick={() => setEditing(freshGradient(s.id))}
                      className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-input border-dashed text-[0.875rem] text-ink-3 transition hover:border-ink-4 hover:text-ink"
                    >
                      <Plus className="size-5" />
                      {t("project.gradientAdd")}
                    </button>
                  )}
                </div>
              ) : kind === "patterns" ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                  {tiles.map((p) => (
                    <PatternCard
                      key={p.id}
                      projectId={projectId}
                      pattern={p}
                      fileName={fileName(p.file)}
                      readOnly={readOnly}
                      onEdit={() => setTiling(p)}
                      onChange={(patch) =>
                        setPatterns((all) =>
                          all.map((x) => (x.id === p.id ? { ...x, ...patch } : x)),
                        )
                      }
                      onRemove={() => {
                        void actions.remove(p.file);
                        setPatterns((all) => all.filter((x) => x.id !== p.id));
                      }}
                    />
                  ))}
                  {readOnly || patterns.length >= PROJECT_LIMITS.files.pattern ? null : (
                    <button
                      type="button"
                      onClick={() => setTiling({ id: newId(), name: "", section: s.id, file: "" })}
                      className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-input border-dashed text-[0.875rem] text-ink-3 transition hover:border-ink-4 hover:text-ink"
                    >
                      <Plus className="size-5" />
                      {t("project.patternAdd")}
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {own.map(row)}
                  {readOnly || rows.length >= PROJECT_LIMITS.colors ? null : (
                    <AddRow label={t("project.colorAdd")} onClick={() => addRow(s.id)} />
                  )}
                </div>
              )}
            </div>
          );
        })}

        {ruled ? (
          <RuleRows
            rules={rules}
            placeholder={t("project.colorRulePlaceholder")}
            readOnly={readOnly}
          />
        ) : null}
      </div>
      {actions.error ? <p className="mt-3 text-[0.875rem] text-rose">{actions.error}</p> : null}
      {editing ? (
        <GradientEditor
          projectId={projectId}
          gradient={editing}
          isNew={!gradients.some((x) => x.id === editing.id)}
          brand={rows.filter((r) => HEX.test(r.value))}
          onClose={() => setEditing(null)}
          onSave={(g) =>
            setGradients((all) =>
              all.some((x) => x.id === g.id)
                ? all.map((x) => (x.id === g.id ? g : x))
                : [...all, g],
            )
          }
        />
      ) : null}
      {tiling ? (
        <PatternEditor
          projectId={projectId}
          pattern={tiling}
          isNew={!patterns.some((x) => x.id === tiling.id)}
          fileName={fileName}
          busy={actions.busy}
          error={actions.error}
          upload={async (file) => (await actions.upload("pattern", [file]))[0] ?? null}
          removeFile={(id) => void actions.remove(id)}
          onClose={() => setTiling(null)}
          onSave={(p) =>
            setPatterns((all) =>
              all.some((x) => x.id === p.id)
                ? all.map((x) => (x.id === p.id ? p : x))
                : [...all, p],
            )
          }
        />
      ) : null}
      {fromUrl ? (
        <ColorsFromUrl projectId={projectId} onClose={() => setFromUrl(false)} onAdd={append} />
      ) : null}
    </Section>
  );
}
