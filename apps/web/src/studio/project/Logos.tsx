import {
  type BrandRule,
  type LogoSection,
  mainLogo,
  PROJECT_LIMITS,
  type ProjectFileView,
} from "@engenty-wizards/shared/projects";
import { FolderPlus, Link, ListChecks, Upload } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { cn } from "../../ui";
import { type ProjectFiles, useAutosave, useFileActions } from "./data";
import { FromUrl, LOGO_DRAG, type MoveTo, Tiles } from "./Files";
import {
  type AddEntry,
  AddMenu,
  newId,
  RuleRows,
  Section,
  SubSectionHead,
  useRuleRows,
} from "./Section";

/** A group of logos that takes a logo dragged onto it. */
function DropGroup({
  onLogo,
  children,
  className,
}: {
  onLogo?: (fileId: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const [over, setOver] = useState(false);
  if (!onLogo) {
    return <div className={className}>{children}</div>;
  }
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(LOGO_DRAG)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(LOGO_DRAG);
        setOver(false);
        if (id) {
          e.preventDefault();
          onLogo(id);
        }
      }}
      className={cn(
        "-m-2 rounded-xl p-2 transition",
        over && "bg-paper-2 ring-1 ring-focus",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The space's logos. The standard ones come first, without a title; the first of them is the
 * logo end users see. Two optional parts: sections for further variants, each with a title and
 * when to use it, and rules for how the logos may be used, one per row ("✅ …", "❌ …"). They wait
 * behind the switches `brandSections` (without it every logo stands with the standard ones) and
 * `brandRules`.
 */
export function Logos({
  projectId,
  data,
  readOnly,
  sections: savedSections,
  rules: savedRules,
  sectioned,
  ruled,
  save,
}: {
  projectId: string;
  data: ProjectFiles;
  readOnly?: boolean;
  sections: LogoSection[];
  rules: BrandRule[];
  /** Sections are shown and can be added. */
  sectioned: boolean;
  /** Rules are shown and can be added. */
  ruled: boolean;
  save: (patch: { logoSections: LogoSection[]; logoRules: BrandRule[] }) => Promise<unknown>;
}) {
  const actions = useFileActions(projectId, readOnly);
  const [sections, setSections] = useState(savedSections);
  const rules = useRuleRows(savedRules);
  const [titleFor, setTitleFor] = useState<string | null>(null);

  const [fromUrl, setFromUrl] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const status = useAutosave({ logoSections: sections, logoRules: rules.rules }, save);
  const logos = data.files.filter((f) => f.kind === "logo");
  const byId = new Map(logos.map((f) => [f.id, f]));
  const shown = sectioned ? sections : [];
  const grouped = new Set(shown.flatMap((s) => s.logos));
  const standard = logos.filter((f) => !grouped.has(f.id));
  const mainId = mainLogo(logos, sections)?.id;

  /** Takes a logo out of every section and, with `to`, puts it at the end of that one. */
  const place = (fileId: string, to: string | null) =>
    setSections((all) =>
      all.map((s) => {
        const rest = s.logos.filter((id) => id !== fileId);
        return { ...s, logos: s.id === to ? [...rest, fileId] : rest };
      }),
    );
  const set = (id: string, patch: Partial<LogoSection>) =>
    setSections((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const upload = async (picked: File[], to: string | null) => {
    const taken = await actions.upload("logo", picked);
    for (const file of taken) {
      place(file.id, to);
    }
  };

  const moveTo: MoveTo | undefined = shown.length
    ? {
        options: [
          { value: "", label: t("project.sectionStandard") },
          ...shown.map((s) => ({
            value: s.id,
            label: s.title || t("project.sectionUntitled"),
          })),
        ],
        current: (file) => shown.find((s) => s.logos.includes(file.id))?.id ?? "",
        onMove: (file, value) => place(file.id, value || null),
      }
    : undefined;
  const tiles = (files: ProjectFileView[], to: string | null, add: boolean) => (
    <Tiles
      projectId={projectId}
      kind="logo"
      files={files}
      actions={actions}
      accept="image/*"
      addLabel={add ? t("project.logoAdd") : undefined}
      onUpload={(picked) => void upload(picked, to)}
      mainId={mainId}
      onMakeMain={(file) => {
        // The main logo is the first standard one: one from a section comes back to them.
        place(file.id, null);
        void actions.order("logo", [
          file.id,
          ...logos.filter((f) => f.id !== file.id).map((f) => f.id),
        ]);
      }}
      moveTo={moveTo}
      onRemove={(file) => {
        if (confirm(t("project.removeConfirm", { name: file.name }))) {
          void actions.remove(file.id);
          place(file.id, null);
        }
      }}
    />
  );
  const drop = readOnly ? undefined : (to: string | null) => (id: string) => place(id, to);

  const add: AddEntry[] = [
    {
      label: t("project.logoUpload"),
      icon: <Upload className="size-4 shrink-0" />,
      onPick: () => picker.current?.click(),
    },
    {
      label: t("project.logoFromUrl"),
      icon: <Link className="size-4 shrink-0" />,
      onPick: () => setFromUrl(true),
    },
    ...(sectioned && sections.length < PROJECT_LIMITS.logoSections
      ? [
          {
            label: t("project.logoSectionAdd"),
            icon: <FolderPlus className="size-4 shrink-0" />,
            onPick: () => {
              const id = newId();
              setTitleFor(id);
              setSections((all) => [...all, { id, title: "", description: "", logos: [] }]);
            },
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
      title={t("project.logos")}
      hint={t("project.logosHint")}
      save={status}
      action={readOnly ? null : <AddMenu entries={add} />}
    >
      <input
        ref={picker}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) {
            void upload(files, null);
          }
        }}
      />
      <div className="flex flex-col gap-7">
        {/* The standard logos: no title, they are what a logo is unless a section says otherwise. */}
        <DropGroup onLogo={drop?.(null)}>{tiles(standard, null, true)}</DropGroup>

        {shown.map((s) => (
          <div key={s.id} className="group/section">
            <DropGroup onLogo={drop?.(s.id)} className="flex flex-col gap-3">
              <SubSectionHead
                title={s.title}
                description={s.description}
                titlePlaceholder={t("project.logoSectionTitle")}
                descriptionPlaceholder={t("project.logoSectionUse")}
                autoFocus={titleFor === s.id}
                readOnly={readOnly}
                onChange={(patch) => set(s.id, patch)}
                onRemove={() => {
                  if (
                    !s.logos.length ||
                    confirm(
                      t("project.logoSectionRemoveConfirm", {
                        name: s.title || t("project.sectionUntitled"),
                      }),
                    )
                  ) {
                    setSections((all) => all.filter((x) => x.id !== s.id));
                  }
                }}
              />
              {tiles(
                s.logos.map((id) => byId.get(id)).filter((f): f is ProjectFileView => !!f),
                s.id,
                true,
              )}
            </DropGroup>
          </div>
        ))}

        {ruled ? (
          <RuleRows
            rules={rules}
            placeholder={t("project.logoRulePlaceholder")}
            readOnly={readOnly}
          />
        ) : null}
      </div>
      {actions.error ? <p className="mt-3 text-[0.875rem] text-rose">{actions.error}</p> : null}
      {fromUrl ? (
        <FromUrl
          kind="logo"
          onClose={() => setFromUrl(false)}
          fetchUrl={(url) => actions.fromUrl("logo", url)}
          onAdded={(files) => {
            for (const file of files) {
              place(file.id, null);
            }
          }}
        />
      ) : null}
    </Section>
  );
}
