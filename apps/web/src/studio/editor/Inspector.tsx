import { DataMenu, editableData, HtmlFrame, JsonSchemaDialog } from "@engenty-wizards/runner";
import {
  ASPECT_RATIOS,
  CONDITION_OPS,
  type Condition,
  conditionsOf,
  declaredShape,
  ENGENTY_KINDS,
  FIELD_KINDS,
  type Field,
  type Format,
  formatsFor,
  isDecisionStep,
  isOtherwise,
  isRealLanguage,
  langName,
  type NextRule,
  outputKeys,
  type PageStep,
  type Step,
  stepShape,
  TOOL_IDS,
  VIDEO_RESOLUTIONS,
  type VideoResolution,
  WIZARD_LANGS,
  type WizardDefinition,
} from "@engenty-wizards/shared/definition";
import { readNumber } from "@engenty-wizards/shared/numbers";
import type { BranchDecision, RunEstimate } from "@engenty-wizards/shared/run";
import type { WorkspaceFile } from "@engenty-wizards/shared/workspace";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Info,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base";
import { Mascot } from "../../brand";
import { lang, t } from "../../lib/i18n";
import { useStudioPlugins } from "../../plugins/host";
import {
  Button,
  cn,
  IconButton,
  Input,
  Label,
  Segmented,
  Select,
  Switch,
  Textarea,
} from "../../ui";
import {
  AddingCard,
  type AddKind,
  AddStepPanel,
  type AddWhen,
  type EmptyKind,
  placeText,
  type StepAssistant,
  uniqueId,
  withEmptyStep,
} from "./AddStep";
import { ModelClassControl, StepCost, useEstimate } from "./estimate";
import { conditionText, percent } from "./FlowDiagram";
import { HoldToDelete } from "./HoldToDelete";
import { stepIcon, stepSummary, TYPE_TONE, toolLabel, typeLabel } from "./meta";
import { SurfaceBody } from "./SurfaceEditor";

type Update = (next: WizardDefinition) => void;

/** The conversation, for what the step panel asks the assistant to build. */
const Assistant = createContext<StepAssistant | undefined>(undefined);

const fieldKindLabel = (kind: Field["kind"]) => t(`inspector.kind.${kind}`);

/** Kinds that show an icon beside their name in a field's header. */
const FIELD_KIND_ICON: Partial<Record<Field["kind"], typeof CalendarClock>> = {
  slot: CalendarClock,
};

/** A field that changes kind leaves behind what only the old kind understood. */
function withKind(field: Field, kind: Field["kind"]): Field {
  const upload = kind === "image" || kind === "file";
  return {
    ...field,
    kind,
    multiple: upload ? field.multiple : undefined,
    camera: kind === "file" ? field.camera : undefined,
    video: kind === "file" ? field.video : undefined,
    scan: kind === "text" ? field.scan : undefined,
  };
}

/** A wizard that is shown here and changed elsewhere: its settings are there to read. */
const ReadOnly = createContext(false);

/**
 * A group of controls. Where the wizard is read-only they show their values and take no change:
 * a disabled fieldset does that for every field, switch and button inside.
 */
function Fields({ className, children }: { className?: string; children: React.ReactNode }) {
  return useContext(ReadOnly) ? (
    <fieldset disabled className={cn("min-w-0", className)}>
      {children}
    </fieldset>
  ) : (
    <div className={className}>{children}</div>
  );
}

function Section({
  title,
  children,
  loose,
}: {
  title?: string;
  children: React.ReactNode;
  /** Its rows lock themselves, so what opens and closes them stays usable. */
  loose?: boolean;
}) {
  const group = "flex flex-col gap-4";
  return (
    <div className="border-border-soft border-t px-5 py-5 first:border-t-0">
      {title ? (
        <h4 className="mb-3 font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.07em]">
          {title}
        </h4>
      ) : null}
      {loose ? (
        <div className={group}>{children}</div>
      ) : (
        <Fields className={group}>{children}</Fields>
      )}
    </div>
  );
}

/** What a field's condition can read: the page's other fields and what is known before it. */
function conditionSources(def: WizardDefinition, page: PageStep, field: Field): string[] {
  const index = def.steps.indexOf(page);
  const out: string[] = [];
  for (const s of def.steps.slice(0, index)) {
    if (s.type === "page") {
      out.push(...s.fields.map((f) => f.id));
    } else if (s.type === "agent") {
      out.push(...outputKeys(s).map((k) => `steps.${s.id}.${k}`));
    }
  }
  out.push(...page.fields.filter((f) => f.id !== field.id).map((f) => f.id));
  out.push(...(def.lists ?? []).map((l) => `lists.${l.id}.count`));
  return out;
}

/** Where a choice field's options can come from: lists and table columns made before the page. */
function optionSources(def: WizardDefinition, page: PageStep): string[] {
  const index = def.steps.indexOf(page);
  const out: string[] = [];
  for (const s of def.steps.slice(0, index)) {
    if (s.type !== "agent") {
      continue;
    }
    for (const [key, f] of Object.entries(declaredShape(s)?.fields ?? {})) {
      if (f.kind === "list" && f.of.kind === "object") {
        // A list of entries: one of their keys that holds a word or a number.
        const flat = Object.entries(f.of.fields).filter(([, c]) => c.kind !== "list");
        out.push(...flat.map(([c]) => `steps.${s.id}.${key}.${c}`));
      } else if (f.kind === "list") {
        out.push(`steps.${s.id}.${key}`);
      } else if (f.kind === "table") {
        out.push(...(f.columns ?? []).map((c) => `steps.${s.id}.${key}.${c}`));
      }
    }
  }
  for (const l of def.lists ?? []) {
    if (!l.shared) {
      out.push(...l.columns.map((c) => `lists.${l.id}.${c.id}`));
    }
  }
  return out;
}

/** The label of a field id, or the reference itself. */
function sourceLabel(def: WizardDefinition, ref: string): string {
  const field = def.steps
    .flatMap((s) => (s.type === "page" ? s.fields : []))
    .find((f) => f.id === ref);
  return field ? field.label : ref;
}

/** One condition: what it reads, how it compares, against what. Further ones are kept as they are. */
function ConditionEditor({
  def,
  when,
  sources,
  onChange,
  label = t("editor.shownWhen"),
  noneLabel = t("editor.shownAlways"),
}: {
  def: WizardDefinition;
  when: Field["when"];
  sources: string[];
  onChange: (when: Field["when"]) => void;
  label?: string;
  noneLabel?: string;
}) {
  const [first, ...rest] = conditionsOf(when);
  const set = (c: Condition | null) =>
    onChange(c ? (rest.length ? [c, ...rest] : c) : rest.length ? rest : undefined);
  const needsValue = first && first.op !== "empty" && first.op !== "notEmpty";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.8125rem] text-ink-2">{label}</span>
      <Select
        value={first?.field ?? ""}
        placeholder={noneLabel}
        onChange={(v) =>
          set(v ? { field: v, op: first?.op ?? "equals", value: first?.value ?? "" } : null)
        }
        options={[
          { value: "", label: noneLabel },
          ...sources.map((ref) => ({ value: ref, label: sourceLabel(def, ref) })),
        ]}
      />
      {first ? (
        <div className="flex gap-1.5">
          <Select
            value={first.op}
            onChange={(v) => {
              const op = v as Condition["op"];
              const value =
                op === "empty" || op === "notEmpty"
                  ? undefined
                  : op === "in"
                    ? String(first.value ?? "")
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean)
                    : op === "gt" || op === "lt"
                      ? Number(first.value) || 0
                      : Array.isArray(first.value)
                        ? first.value.join(", ")
                        : (first.value ?? "");
              set({ field: first.field, op, ...(value === undefined ? {} : { value }) });
            }}
            options={CONDITION_OPS.map((op) => ({ value: op, label: t(`editor.op.${op}`) }))}
          />
          {needsValue ? (
            <Input
              aria-label={t("editor.conditionValue")}
              placeholder={t("editor.conditionValue")}
              value={
                Array.isArray(first.value) ? first.value.join(", ") : String(first.value ?? "")
              }
              onChange={(e) => {
                const raw = e.target.value;
                const value =
                  first.op === "in"
                    ? raw.split(",").map((x) => x.trim())
                    : first.op === "gt" || first.op === "lt"
                      ? (readNumber(raw) ?? 0)
                      : raw === "true" || raw === "false"
                        ? raw === "true"
                        : raw;
                set({ ...first, value });
              }}
            />
          ) : null}
        </div>
      ) : null}
      {rest.length ? (
        <span className="text-[0.75rem] text-ink-4">
          {t("editor.conditionsMore", { count: rest.length })}
        </span>
      ) : null}
    </div>
  );
}

function FieldEditor({
  def,
  page,
  field,
  onChange,
  onRemove,
  onMove,
}: {
  def: WizardDefinition;
  page: PageStep;
  field: Field;
  onChange: (f: Field) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const KindIcon = FIELD_KIND_ICON[field.kind];
  return (
    <div className="rounded-lg bg-paper ring-1 ring-border-soft">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-[0.875rem]">
          {field.label}
          {field.required ? <span className="ml-1 text-ember">*</span> : null}
        </span>
        <span className="inline-flex items-center gap-1 text-[0.75rem] text-ink-4">
          {KindIcon ? <KindIcon className="size-3.5" /> : null}
          {fieldKindLabel(field.kind)}
        </span>
        <ChevronDown className={cn("size-4 text-ink-4 transition", open && "rotate-180")} />
      </button>
      {open ? (
        <Fields className="flex flex-col gap-3 border-border-soft border-t px-3 py-3">
          <Input
            value={field.label}
            onChange={(e) => onChange({ ...field, label: e.target.value })}
          />
          <Select
            value={field.kind}
            onChange={(v) => onChange(withKind(field, v as Field["kind"]))}
            options={FIELD_KINDS.filter((k) => k !== "items" || field.kind === "items").map(
              (k) => ({ value: k, label: fieldKindLabel(k) }),
            )}
          />
          {(field.kind === "select" || field.kind === "multiselect" || field.kind === "slot") &&
          (field.optionsFrom || optionSources(def, page).length) ? (
            <Select
              value={field.optionsFrom ?? ""}
              onChange={(v) => onChange({ ...field, optionsFrom: v || undefined })}
              options={[
                { value: "", label: t("editor.optionsFixed") },
                ...optionSources(def, page).map((ref) => ({
                  value: ref,
                  label: `${t("editor.optionsFrom")}: ${ref}`,
                })),
              ]}
            />
          ) : null}
          {field.kind === "select" || field.kind === "multiselect" || field.kind === "slot" ? (
            <Input
              placeholder={
                field.kind === "slot"
                  ? "2026-10-12T09:00:00+02:00, 2026-10-12T09:30:00+02:00"
                  : "Option A, Option B, Option C"
              }
              value={(field.options ?? []).join(", ")}
              onChange={(e) =>
                onChange({
                  ...field,
                  options: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          ) : null}
          {field.kind === "connection" ? (
            <Select
              value={field.connection ?? ""}
              placeholder={t("inspector.whichAccount")}
              onChange={(v) => onChange({ ...field, connection: v })}
              options={(def.connections ?? []).map((c) => ({
                value: c.id,
                label: c.title ?? c.id,
              }))}
            />
          ) : null}
          {field.kind === "list" ? (
            <Select
              value={field.list ?? ""}
              placeholder={t("inspector.whichList")}
              onChange={(v) => onChange({ ...field, list: v })}
              options={(def.lists ?? []).map((l) => ({ value: l.id, label: l.title }))}
            />
          ) : null}
          {field.kind === "image" || field.kind === "file" ? (
            <div className="flex items-center justify-between">
              <span className="text-[0.8125rem] text-ink-2">{t("inspector.multipleFiles")}</span>
              <Switch
                checked={Boolean(field.multiple)}
                onChange={(v) =>
                  onChange({
                    ...field,
                    multiple: v || undefined,
                    ...(v ? {} : { min: undefined, max: undefined }),
                  })
                }
              />
            </div>
          ) : null}
          {(field.kind === "image" || field.kind === "file") && field.multiple ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.8125rem] text-ink-2">{t("inspector.howMany")}</span>
              <div className="flex items-center gap-1.5">
                {(["min", "max"] as const).map((key) => (
                  <Input
                    key={key}
                    type="number"
                    min={1}
                    max={30}
                    aria-label={t(key === "min" ? "inspector.atLeast" : "inspector.atMost")}
                    placeholder={key === "min" ? "min." : "max."}
                    value={field[key] ?? ""}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      onChange({
                        ...field,
                        [key]: e.target.value && n >= 1 ? Math.min(n, 30) : undefined,
                      });
                    }}
                    className="h-8 w-16 text-right"
                  />
                ))}
              </div>
            </div>
          ) : null}
          {field.kind === "file" ? (
            <div className="flex items-center justify-between">
              <span className="text-[0.8125rem] text-ink-2">{t("inspector.camera")}</span>
              <Switch
                checked={Boolean(field.camera)}
                onChange={(v) => onChange({ ...field, camera: v || undefined })}
              />
            </div>
          ) : null}
          {field.kind === "file" ? (
            <div className="flex items-center justify-between">
              <span className="text-[0.8125rem] text-ink-2">{t("inspector.cameraVideo")}</span>
              <Switch
                checked={Boolean(field.video)}
                onChange={(v) => onChange({ ...field, video: v || undefined })}
              />
            </div>
          ) : null}
          {field.kind === "text" ? (
            <div className="flex items-center justify-between">
              <span className="text-[0.8125rem] text-ink-2">{t("inspector.scan")}</span>
              <Switch
                checked={Boolean(field.scan)}
                onChange={(v) => onChange({ ...field, scan: v || undefined })}
              />
            </div>
          ) : null}
          {["text", "textarea", "number", "email", "url", "location"].includes(field.kind) ? (
            <Input
              placeholder={t("inspector.placeholder")}
              value={field.placeholder ?? ""}
              onChange={(e) => onChange({ ...field, placeholder: e.target.value || undefined })}
            />
          ) : null}
          <Input
            placeholder={t("inspector.help")}
            value={field.help ?? ""}
            onChange={(e) => onChange({ ...field, help: e.target.value || undefined })}
          />
          <ConditionEditor
            def={def}
            when={field.when}
            sources={conditionSources(def, page, field)}
            onChange={(when) => onChange({ ...field, when })}
          />
          {field.group ? null : (
            <Input
              aria-label={t("editor.fieldAsk")}
              placeholder={t("editor.fieldAsk")}
              value={field.ask ?? ""}
              onChange={(e) => onChange({ ...field, ask: e.target.value || undefined })}
            />
          )}
          <div className="flex items-center justify-between">
            <span className="text-[0.8125rem] text-ink-2">{t("run.required")}</span>
            <Switch
              checked={Boolean(field.required)}
              onChange={(v) => onChange({ ...field, required: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[0.6875rem] text-ink-4">{`{{${field.id}}}`}</span>
            <div className="flex">
              <IconButton label={t("editor.moveUp")} onClick={() => onMove(-1)} className="size-8">
                <ArrowUp className="size-3.5" />
              </IconButton>
              <IconButton label={t("editor.moveDown")} onClick={() => onMove(1)} className="size-8">
                <ArrowDown className="size-3.5" />
              </IconButton>
              <IconButton
                label={t("common.remove")}
                onClick={onRemove}
                className="size-8 hover:text-rose"
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          </div>
        </Fields>
      ) : null}
    </div>
  );
}

const WIDGET_SIZES = [
  { label: "16:9", width: 1280, height: 720 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "4:5", width: 1080, height: 1350 },
  { label: "9:16", width: 1080, height: 1920 },
];

/** Where a widget's data can come from: earlier fields and steps. */
function dataSources(def: WizardDefinition, index: number): string[] {
  const out: string[] = [];
  for (const s of def.steps.slice(0, index)) {
    if (s.type === "page") {
      out.push(...s.fields.map((f) => f.id));
    } else if (s.type === "agent") {
      out.push(`steps.${s.id}`, ...outputKeys(s).map((k) => `steps.${s.id}.${k}`));
    } else if (s.type === "generate" || s.type === "widget" || s.type === "surface") {
      out.push(`steps.${s.id}`);
    }
  }
  return [...out, "brand.name", "today"];
}

function WidgetBody({
  def,
  step,
  set,
  files,
  wizardId,
}: {
  def: WizardDefinition;
  step: Extract<Step, { type: "widget" }>;
  set: (s: Step) => void;
  files: WorkspaceFile[];
  wizardId: string;
}) {
  const html = files.filter((f) => f.mime === "text/html");
  const json = files.filter((f) => f.mime === "application/json");
  const size = step.size ?? WIDGET_SIZES[0];
  const sources = dataSources(def, def.steps.indexOf(step));
  const entries = Object.entries(step.data);
  const setData = (next: [string, string][]) => set({ ...step, data: Object.fromEntries(next) });
  // The preview reloads when the widget's files or its size change.
  const version = [
    files.find((f) => f.path === step.entry)?.hash.slice(0, 8),
    files.find((f) => f.path === step.sample)?.hash.slice(0, 8),
    size.width,
    size.height,
  ].join("-");
  const hasEntry = files.some((f) => f.path === step.entry);
  return (
    <>
      <Section title={t("inspector.widgetPreview")}>
        {hasEntry ? (
          <HtmlFrame
            src={withBase(
              `/api/studio/wizards/${wizardId}/widgets/${step.id}/preview?v=${version}`,
            )}
            page={size.width}
            height={size.height}
            fit
          />
        ) : (
          <WidgetMissing step={step} wizardId={wizardId} />
        )}
      </Section>
      <Section title={t("type.widget")}>
        <Label>{t("inspector.htmlFile")}</Label>
        <Select
          value={step.entry}
          onChange={(v) => set({ ...step, entry: v })}
          options={(html.some((f) => f.path === step.entry)
            ? html
            : [{ path: step.entry }, ...html]
          ).map((f) => ({ value: f.path, label: f.path }))}
        />
        <Label>{t("inspector.sample")}</Label>
        <Select
          value={step.sample ?? ""}
          onChange={(v) => set({ ...step, sample: v || undefined })}
          options={[
            { value: "", label: t("inspector.none") },
            ...json.map((f) => ({ value: f.path, label: f.path })),
          ]}
        />
        <Label>{t("inspector.size")}</Label>
        <Segmented
          value={
            WIDGET_SIZES.find((p) => p.width === size.width && p.height === size.height)?.label ??
            ""
          }
          options={WIDGET_SIZES.map((p) => p.label)}
          onChange={(v: string) => {
            const p = WIDGET_SIZES.find((x) => x.label === v);
            if (p) {
              set({ ...step, size: { width: p.width, height: p.height } });
            }
          }}
        />
      </Section>
      <Section title={t("inspector.widgetData")}>
        <datalist id={`sources-${step.id}`}>
          {sources.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {entries.map(([key, ref], i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={key}
              className="w-28 font-mono text-[0.75rem]"
              onChange={(e) =>
                setData(entries.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))
              }
            />
            <span className="text-ink-4">←</span>
            <Input
              value={ref}
              list={`sources-${step.id}`}
              className="flex-1 font-mono text-[0.75rem]"
              onChange={(e) =>
                setData(entries.map((x, j) => (j === i ? [x[0], e.target.value] : x)))
              }
            />
            <IconButton
              label={t("editor.deleteStep")}
              onClick={() => setData(entries.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            setData([...entries, [`value${entries.length + 1}`, sources[0] ?? "today"]])
          }
          className="inline-flex h-8 items-center gap-1 self-start rounded-full px-2.5 text-[0.75rem] text-ink-2 hover:bg-accent"
        >
          <Plus className="size-3.5" /> {t("inspector.value")}
        </button>
      </Section>
    </>
  );
}

/**
 * A widget step without its HTML: the assistant builds it from what the admin says it should
 * show, or the admin uploads an HTML file of their own as the step's entry.
 */
function WidgetMissing({
  step,
  wizardId,
}: {
  step: Extract<Step, { type: "widget" }>;
  wizardId: string;
}) {
  const assistant = useContext(Assistant);
  const readOnly = useContext(ReadOnly);
  const qc = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (readOnly) {
    return <p className="text-[0.8125rem] text-ink-3">{t("widget.missing")}</p>;
  }
  const build = () => {
    if (!assistant) {
      return;
    }
    const text = t("widget.buildMessage", { title: step.title, what: what.trim() }).trim();
    if (assistant.ask(text)) {
      setWhat("");
      setError(null);
    } else {
      setError(t("addStep.busy"));
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path = encodeURIComponent(step.entry).replace(/%2F/g, "/");
      const res = await fetch(withBase(`/api/studio/wizards/${wizardId}/files/${path}`), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "text/html", "accept-language": lang },
        body: file,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? res.statusText);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ["wizard", wizardId] });
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border-strong border-dashed p-4">
      <p className="text-[0.8125rem] text-ink-2">{t("widget.missing")}</p>
      {assistant ? (
        <Textarea
          minRows={2}
          aria-label={t("widget.what")}
          placeholder={t("widget.what")}
          value={what}
          onChange={(e) => setWhat(e.target.value)}
        />
      ) : null}
      {error ? <p className="text-[0.75rem] text-rose">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {assistant ? (
          <Button size="sm" onClick={build}>
            <Sparkles className="size-3.5" /> {t("widget.build")}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" busy={busy} onClick={() => picker.current?.click()}>
          <Upload className="size-3.5" /> {t("widget.upload")}
        </Button>
        <input
          ref={picker}
          type="file"
          accept="text/html,.html,.htm"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void upload(file);
          }}
        />
      </div>
    </div>
  );
}

function StepBody({
  def,
  step,
  set,
  mcpServers,
  files,
  wizardId,
}: {
  def: WizardDefinition;
  step: Step;
  set: (s: Step) => void;
  mcpServers: { id: string; name: string }[];
  files: WorkspaceFile[];
  wizardId: string;
}) {
  const index = def.steps.indexOf(step);
  const readOnly = useContext(ReadOnly);
  // Tools the runtime's plugins add, listed by their full id next to the built-in ones.
  const pluginTools = useStudioPlugins().plugins.flatMap((plugin) => plugin.tools);
  const earlierProducers = def.steps
    .slice(0, index)
    .filter(
      (s) =>
        s.type === "agent" || s.type === "generate" || s.type === "widget" || s.type === "surface",
    );
  switch (step.type) {
    case "widget":
      return <WidgetBody def={def} step={step} set={set} files={files} wizardId={wizardId} />;
    case "surface":
      return (
        <SurfaceBody
          def={def}
          step={step}
          set={set}
          section={(title, children) => <Section title={title}>{children}</Section>}
        />
      );
    case "page":
      return (
        <Section title={t("inspector.questions")} loose>
          <div className="flex flex-col gap-2">
            {step.fields.map((f, i) => (
              <FieldEditor
                key={f.id}
                def={def}
                page={step}
                field={f}
                onChange={(nf) =>
                  set({ ...step, fields: step.fields.map((x, j) => (j === i ? nf : x)) })
                }
                onRemove={() =>
                  step.fields.length > 1 &&
                  set({ ...step, fields: step.fields.filter((_, j) => j !== i) })
                }
                onMove={(dir) => {
                  const j = i + dir;
                  if (j < 0 || j >= step.fields.length) {
                    return;
                  }
                  const fields = [...step.fields];
                  [fields[i], fields[j]] = [fields[j], fields[i]];
                  set({ ...step, fields });
                }}
              />
            ))}
          </div>
          {readOnly ? null : (
            <button
              type="button"
              onClick={() =>
                set({
                  ...step,
                  fields: [
                    ...step.fields,
                    { id: uniqueId(def, "question"), label: t("step.new.question"), kind: "text" },
                  ],
                })
              }
              className="inline-flex h-9 items-center gap-1.5 self-start rounded-full px-3 text-[0.8125rem] text-ink-2 hover:bg-accent"
            >
              <Plus className="size-4" /> {t("inspector.addQuestion")}
            </button>
          )}
        </Section>
      );
    case "agent":
      return (
        <>
          <Section title={t("inspector.task")}>
            <Textarea
              value={step.instructions}
              minRows={6}
              maxRows={20}
              onChange={(e) => set({ ...step, instructions: e.target.value })}
              className="text-[0.875rem]"
            />
            <p className="text-[0.75rem] text-ink-4">
              {t("inspector.insertAnswers")}{" "}
              <code className="font-mono">{`{{${t("inspector.insertField")}}}`}</code>
              {t("inspector.insertResults")} <code className="font-mono">{"{{steps.id}}"}</code>.
            </p>
          </Section>
          <Section title={t("inspector.tools")}>
            <Segmented
              multi
              value={step.tools}
              // A tool the step lists stays to be seen, and taken out, where its plugin is gone.
              options={[
                ...new Set([...TOOL_IDS, ...pluginTools.map((tool) => tool.id), ...step.tools]),
              ]}
              onChange={(v: string[]) => set({ ...step, tools: v as typeof step.tools })}
            />
            <div className="-mt-2 flex flex-wrap gap-x-3 text-[0.75rem] text-ink-4">
              {TOOL_IDS.map((id) => (
                <span key={id}>
                  {id} = {toolLabel(id)}
                </span>
              ))}
              {pluginTools.map((tool) => (
                <span key={tool.id}>
                  {tool.id} = {tool.title}
                </span>
              ))}
            </div>
            {def.connections?.length ? (
              <>
                <Label hint={t("inspector.personAccountsHint")}>
                  {t("inspector.personAccounts")}
                </Label>
                <Segmented
                  multi
                  value={step.connections ?? []}
                  options={def.connections.map((c) => c.id)}
                  onChange={(v: string[]) =>
                    set({ ...step, connections: v.length ? v : undefined })
                  }
                />
              </>
            ) : null}
            {mcpServers.length ? (
              <>
                <Label hint={t("inspector.systemsHint")}>{t("inspector.systems")}</Label>
                <Segmented
                  multi
                  value={step.mcp ?? []}
                  options={mcpServers.map((m) => m.id)}
                  onChange={(v: string[]) => set({ ...step, mcp: v.length ? v : undefined })}
                />
              </>
            ) : null}
          </Section>
          <Section title={t("inspector.output")}>
            <Segmented
              value={step.output.format}
              options={["text", "markdown", "json"]}
              onChange={(v: "text" | "markdown" | "json") =>
                set({ ...step, output: { ...step.output, format: v } })
              }
            />
            <ModelClassControl
              model={step.model}
              effort={step.effort}
              onChange={(next) => set({ ...step, ...next })}
            />
            <Input
              placeholder={t("inspector.working")}
              value={step.working ?? ""}
              onChange={(e) => set({ ...step, working: e.target.value || undefined })}
            />
          </Section>
        </>
      );
    case "generate":
      return (
        <>
          <Section title={t("inspector.whatMade")}>
            <Segmented
              value={step.asset}
              options={["image", "video", "voice", "document", "dashboard"]}
              onChange={(v: typeof step.asset) => set({ ...step, asset: v })}
            />
            <Textarea
              value={step.prompt}
              minRows={5}
              maxRows={18}
              onChange={(e) => set({ ...step, prompt: e.target.value })}
              className="text-[0.875rem]"
            />
          </Section>
          <Section title={t("inspector.options")}>
            {step.asset === "document" || step.asset === "dashboard" ? (
              <ModelClassControl
                model={step.model}
                effort={step.effort}
                onChange={(next) => set({ ...step, ...next })}
              />
            ) : null}
            {step.asset === "image" || step.asset === "video" ? (
              <>
                <Label>{t("inspector.aspectRatio")}</Label>
                <Segmented
                  value={step.options?.aspectRatio ?? ""}
                  options={[...ASPECT_RATIOS]}
                  onChange={(v: (typeof ASPECT_RATIOS)[number]) =>
                    set({ ...step, options: { ...step.options, aspectRatio: v } })
                  }
                />
                <Input
                  placeholder={t("inspector.style")}
                  value={step.options?.style ?? ""}
                  onChange={(e) =>
                    set({
                      ...step,
                      options: { ...step.options, style: e.target.value || undefined },
                    })
                  }
                />
              </>
            ) : null}
            {step.asset === "video" ? (
              <>
                <Label>{t("inspector.duration")}</Label>
                <Segmented
                  value={String(step.options?.duration ?? 8)}
                  options={["4", "6", "8", "10"]}
                  onChange={(v: string) =>
                    set({ ...step, options: { ...step.options, duration: Number(v) } })
                  }
                />
                <Label>{t("inspector.resolution")}</Label>
                <Segmented
                  value={step.options?.resolution ?? "720p"}
                  options={[...VIDEO_RESOLUTIONS]}
                  onChange={(v: VideoResolution) =>
                    set({ ...step, options: { ...step.options, resolution: v } })
                  }
                />
              </>
            ) : null}
            {step.asset === "document" ? (
              <>
                <Label>{t("inspector.template")}</Label>
                <Select
                  value={step.options?.template ?? "free"}
                  onChange={(v) =>
                    set({ ...step, options: { ...step.options, template: v as "free" } })
                  }
                  options={["free", "invoice", "offer", "briefing", "letter", "report"].map(
                    (v) => ({ value: v, label: v }),
                  )}
                />
              </>
            ) : null}
          </Section>
        </>
      );
    case "review":
      return (
        <Section title={t("inspector.whatShown")}>
          <Segmented
            multi
            value={step.show}
            options={earlierProducers.map((s) => s.id)}
            onChange={(v: string[]) => v.length && set({ ...step, show: v })}
          />
          <div className="flex items-center justify-between">
            <span className="text-[0.8125rem] text-ink-2">{t("inspector.editable")}</span>
            <Switch checked={Boolean(step.edit)} onChange={(v) => set({ ...step, edit: v })} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[0.8125rem] text-ink-2">{t("inspector.redo")}</span>
            <Switch
              checked={Boolean(step.regenerate)}
              onChange={(v) => set({ ...step, regenerate: v })}
            />
          </div>
        </Section>
      );
    case "result":
      return (
        <>
          <Section title={t("inspector.ending")}>
            <Textarea
              minRows={2}
              placeholder={t("inspector.endMessage")}
              value={step.message ?? ""}
              onChange={(e) => set({ ...step, message: e.target.value || undefined })}
            />
          </Section>
          <Section title={t("inspector.downloads")}>
            {earlierProducers.map((s) => {
              const d = step.deliverables.find((x) => x.from === s.id);
              const possible = formatsFor(s);
              return (
                <div key={s.id} className="rounded-lg bg-paper p-3 ring-1 ring-border-soft">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="truncate text-[0.875rem]">{s.title}</span>
                    <Switch
                      checked={Boolean(d)}
                      onChange={(on) =>
                        set({
                          ...step,
                          deliverables: on
                            ? [
                                ...step.deliverables,
                                { from: s.id, label: s.title, formats: [possible[0]] },
                              ]
                            : step.deliverables.filter((x) => x.from !== s.id),
                        })
                      }
                    />
                  </div>
                  {d ? (
                    <Segmented
                      multi
                      value={d.formats}
                      options={possible}
                      onChange={(v: Format[]) =>
                        v.length &&
                        set({
                          ...step,
                          deliverables: step.deliverables.map((x) =>
                            x.from === s.id ? { ...x, formats: v } : x,
                          ),
                        })
                      }
                    />
                  ) : null}
                </div>
              );
            })}
          </Section>
        </>
      );
  }
}

export function WizardSettings({ def, update }: { def: WizardDefinition; update: Update }) {
  return (
    <div>
      <Section>
        <div>
          <Label>{t("inspector.title")}</Label>
          <Input value={def.title} onChange={(e) => update({ ...def, title: e.target.value })} />
        </div>
        <div>
          <Label>{t("inspector.description")}</Label>
          <Textarea
            minRows={2}
            value={def.description}
            onChange={(e) => update({ ...def, description: e.target.value })}
          />
        </div>
        <div>
          <Label hint={t("inspector.introHint")}>{t("inspector.intro")}</Label>
          <Textarea
            minRows={2}
            value={def.intro ?? ""}
            onChange={(e) => update({ ...def, intro: e.target.value || undefined })}
          />
        </div>
        <div>
          <Label hint={t("inspector.langHint")}>{t("inspector.lang")}</Label>
          <Select
            value={def.lang ?? ""}
            onChange={(v) => update({ ...def, lang: isRealLanguage(v) ? v : undefined })}
            options={[
              { value: "", label: t("inspector.langAuto") },
              ...[...new Set([...WIZARD_LANGS, ...(def.lang ? [def.lang] : [])])]
                .map((code) => ({ value: code, label: langName(code) }))
                .sort((a, b) => a.label.localeCompare(b.label)),
            ]}
          />
        </div>
      </Section>
      <Section title={t("inspector.avatar")}>
        <div className="grid grid-cols-5 gap-2">
          {ENGENTY_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => update({ ...def, avatar: k })}
              className={cn(
                "flex aspect-square items-center justify-center rounded-xl transition",
                def.avatar === k ? "bg-ember-tint ring-2 ring-ember" : "bg-paper hover:bg-paper-2",
              )}
              aria-label={k}
            >
              <Mascot kind={k} size={44} interactive={false} />
            </button>
          ))}
        </div>
      </Section>
      {def.lists?.length || def.connections?.length ? (
        <Section title={t("inspector.remembers")}>
          <p className="text-[0.8125rem] text-ink-3">{t("inspector.remembersHint")}</p>
          {(def.connections ?? []).map((c) => (
            <div key={c.id} className="rounded-lg bg-paper px-3 py-2.5 ring-1 ring-border-soft">
              <div className="text-[0.875rem]">{c.title ?? c.id}</div>
              <div className="text-[0.75rem] text-ink-4">
                {t("inspector.account")} · {c.kind}
              </div>
            </div>
          ))}
          {(def.lists ?? []).map((l) => (
            <div key={l.id} className="rounded-lg bg-paper px-3 py-2.5 ring-1 ring-border-soft">
              <div className="text-[0.875rem]">{l.title}</div>
              <div className="text-[0.75rem] text-ink-4">
                {t("inspector.list")} · {l.columns.map((c) => c.name).join(", ")}
              </div>
              <div className="mt-1 font-mono text-[0.6875rem] text-ink-4">{`{{lists.${l.id}}}`}</div>
            </div>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

interface InspectorProps {
  def: WizardDefinition;
  selected: string | null;
  update: Update;
  onSelect: (id: string | null) => void;
  issues: { stepId?: string; message: string }[];
  mcpServers: { id: string; name: string }[];
  files: WorkspaceFile[];
  wizardId: string;
  /** The wizard is shown here and changed elsewhere: every setting is there to read. */
  readOnly?: boolean;
  /** What the last test run's decided branches answered, by step. */
  decisions?: Record<string, BranchDecision>;
  /** Changes when a branch line in the diagram is clicked: the branches scroll into view. */
  branchFocus?: number;
  /** The conversation: steps are added through it. */
  assistant?: StepAssistant;
}

const WIZARD = "__wizard";

/**
 * The wizard's steps in a row, in run order, with the wizard's own settings first: one click or
 * the arrows (on screen or ← / → on the keyboard) move from step to step without going back to
 * the diagram.
 */
function StepNav({
  def,
  selected,
  onSelect,
  issues,
}: Pick<InspectorProps, "def" | "selected" | "onSelect" | "issues">) {
  const ids = [WIZARD, ...def.steps.map((s) => s.id)];
  const at = selected ? ids.indexOf(selected) : -1;
  const current = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected step is what moves into view
  useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selected]);
  const go = (dir: -1 | 1) => {
    // Nothing picked: forward starts at the first step, back at the last.
    const next = at === -1 ? (dir === 1 ? 1 : ids.length - 1) : at + dir;
    if (next >= 0 && next < ids.length) {
      onSelect(ids[next]);
    }
  };
  const goRef = useRef(go);
  goRef.current = go;
  // ← / → step through while this tab is open, unless the keys belong to a field or a control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
        return;
      }
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
        return;
      }
      const el = e.target as HTMLElement | null;
      if (
        el?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="separator"], [role="slider"], [role="dialog"], .react-flow',
        )
      ) {
        return;
      }
      e.preventDefault();
      goRef.current(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const dot = "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition";
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1 border-border-soft border-b bg-card/95 px-2 py-2 backdrop-blur">
      <IconButton
        label={t("editor.prevStep")}
        className="size-8 shrink-0"
        disabled={at === 0}
        onClick={() => go(-1)}
      >
        <ChevronLeft className="size-4" />
      </IconButton>
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto p-1 [scrollbar-width:none]">
        <button
          ref={selected === WIZARD ? current : undefined}
          type="button"
          title={def.title}
          aria-label={def.title}
          aria-current={selected === WIZARD ? "step" : undefined}
          onClick={() => onSelect(WIZARD)}
          className={cn(
            dot,
            "bg-paper-2 text-ink-2",
            selected === WIZARD ? "ring-2 ring-ember" : "hover:ring-2 hover:ring-border-soft",
          )}
        >
          <Wand2 className="size-4" />
        </button>
        {def.steps.map((step, i) => {
          const Icon = stepIcon(step);
          const active = step.id === selected;
          const broken = issues.some((issue) => issue.stepId === step.id);
          return (
            <div key={step.id} className="flex shrink-0 items-center">
              <span className="h-px w-3 bg-border-soft" />
              <button
                ref={active ? current : undefined}
                type="button"
                title={`${i + 1}. ${step.title}`}
                aria-label={`${i + 1}. ${step.title}`}
                aria-current={active ? "step" : undefined}
                onClick={() => onSelect(step.id)}
                className={cn(
                  dot,
                  "relative",
                  TYPE_TONE[step.type],
                  active ? "ring-2 ring-ember" : "opacity-70 hover:opacity-100",
                )}
              >
                <Icon className="size-4" />
                {broken ? (
                  <span className="-top-0.5 -right-0.5 absolute size-2.5 rounded-full bg-rose ring-2 ring-card" />
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
      <span className="shrink-0 px-1 text-[0.75rem] text-ink-4 tabular-nums">
        {at > 0 ? `${at} / ${def.steps.length}` : ""}
      </span>
      <IconButton
        label={t("editor.nextStep")}
        className="size-8 shrink-0"
        disabled={at === ids.length - 1}
        onClick={() => go(1)}
      >
        <ChevronRight className="size-4" />
      </IconButton>
    </div>
  );
}

/** Nothing picked yet: the steps as a list to pick from. */
function StepList({ def, onSelect, issues }: Pick<InspectorProps, "def" | "onSelect" | "issues">) {
  return (
    <div className="flex flex-col gap-1 p-3">
      {def.steps.map((step, i) => {
        const Icon = stepIcon(step);
        const broken = issues.some((issue) => issue.stepId === step.id);
        return (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelect(step.id)}
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-paper-2"
          >
            <span className="w-4 text-right text-[0.75rem] text-ink-4 tabular-nums">{i + 1}</span>
            <span
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
                TYPE_TONE[step.type],
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.875rem]">{step.title}</span>
              <span className="block text-[0.75rem] text-ink-4">{typeLabel(step)}</span>
            </span>
            {broken ? <span className="size-2 shrink-0 rounded-full bg-rose" /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const { def, selected, onSelect, issues, readOnly = false } = props;
  // A read-only wizard takes no change, whatever a control inside still sends.
  const update: Update = readOnly ? () => {} : props.update;
  const step = def.steps.find((s) => s.id === selected);
  return (
    <ReadOnly value={readOnly}>
      <Assistant.Provider value={props.assistant}>
        <div>
          <StepNav def={def} selected={selected} onSelect={onSelect} issues={issues} />
          {selected === WIZARD ? (
            <WizardSettings def={def} update={update} />
          ) : step ? (
            <StepInspector {...props} update={update} step={step} />
          ) : (
            <StepList def={def} onSelect={onSelect} issues={issues} />
          )}
        </div>
      </Assistant.Provider>
    </ReadOnly>
  );
}

function StepInspector({
  def,
  step,
  update,
  onSelect,
  issues,
  mcpServers,
  files,
  wizardId,
  decisions,
  branchFocus,
  assistant,
}: InspectorProps & { step: Step }) {
  const index = def.steps.indexOf(step);
  /** Where a step added here goes: after this one, or before the result. */
  const at = step.type === "result" ? index : index + 1;
  const [addOpen, setAddOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  // Another step, another place: the panel starts closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per step
  useEffect(() => setAddOpen(false), [step.id]);
  const Icon = stepIcon(step);
  const set = (next: Step) =>
    update({ ...def, steps: def.steps.map((s) => (s.id === step.id ? next : s)) });
  const move = (dir: -1 | 1) => {
    const j = index + dir;
    if (
      j < 0 ||
      j >= def.steps.length - (step.type === "result" ? 0 : 1) ||
      def.steps[j].type === "result"
    ) {
      return;
    }
    const steps = [...def.steps];
    [steps[index], steps[j]] = [steps[j], steps[index]];
    update({ ...def, steps });
  };
  const insertEmpty = (kind: EmptyKind) => {
    const added = withEmptyStep(def, at, kind);
    update(added.def);
    setAddOpen(false);
    onSelect(added.id);
  };
  const addWith = (kind: AddKind, prompt: string, when?: AddWhen) => {
    if (!assistant?.add({ at, kind, prompt, when })) {
      return false;
    }
    setAddOpen(false);
    return true;
  };
  const stepIssues = issues.filter((i) => i.stepId === step.id);
  const estimate = useEstimate(wizardId, def);
  const readOnly = useContext(ReadOnly);
  return (
    <div>
      <div className="flex items-center gap-2 px-5 py-4">
        <span
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-md",
            TYPE_TONE[step.type],
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.07em]">
          {typeLabel(step)}
        </span>
        <span className="ml-auto font-mono text-[0.6875rem] text-ink-4">{step.id}</span>
        {/* For developers: the JSON Schema of the step's data, to read, copy or download. */}
        {editableData(step) ? (
          <>
            <DataMenu
              items={[
                {
                  label: t("data.schema"),
                  icon: <Braces className="size-4 shrink-0" />,
                  onClick: () => setSchemaOpen(true),
                },
              ]}
            />
            <JsonSchemaDialog
              shape={stepShape(step)}
              title={step.title}
              open={schemaOpen}
              onClose={() => setSchemaOpen(false)}
            />
          </>
        ) : null}
      </div>
      {stepIssues.length ? (
        <div className="mx-5 mb-4 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose">
          {stepIssues.map((i, k) => (
            <div key={k}>{i.message}</div>
          ))}
        </div>
      ) : null}
      <Section>
        <Input
          value={step.title}
          onChange={(e) => set({ ...step, title: e.target.value })}
          className="font-display font-semibold text-[1rem]"
        />
        {step.type === "page" || step.type === "review" ? (
          <Textarea
            minRows={1}
            placeholder={t("inspector.stepDescription")}
            value={step.description ?? ""}
            onChange={(e) => set({ ...step, description: e.target.value || undefined })}
          />
        ) : null}
        <StepCost estimate={estimate.data} stepId={step.id} />
      </Section>
      <StepBody
        def={def}
        step={step}
        set={set}
        mcpServers={mcpServers}
        files={files}
        wizardId={wizardId}
      />
      {step.type !== "result" ? (
        <NextSection
          def={def}
          step={step}
          set={set}
          onSelect={onSelect}
          decision={decisions?.[step.id]}
          focus={branchFocus}
          estimate={estimate.data}
        />
      ) : null}
      {/* Moving, deleting and adding steps is building: not offered where nothing is changed. */}
      {readOnly ? null : (
        <Section>
          <div className="flex items-center gap-1">
            {step.type !== "result" ? (
              <>
                <IconButton label={t("editor.moveUp")} onClick={() => move(-1)}>
                  <ArrowUp className="size-4" />
                </IconButton>
                <IconButton label={t("editor.moveDown")} onClick={() => move(1)}>
                  <ArrowDown className="size-4" />
                </IconButton>
                <HoldToDelete
                  label={t("editor.deleteStep")}
                  onDelete={() => {
                    update({ ...def, steps: def.steps.filter((s) => s.id !== step.id) });
                    onSelect(null);
                  }}
                />
              </>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((o) => !o)}
            >
              <Plus className="size-3.5" /> {t("addStep.add")}
            </Button>
          </div>
          {assistant?.adding && assistant.adding.at === at ? (
            <AddingCard
              adding={assistant.adding}
              place={placeText(def, at)}
              working={assistant.working}
              onShowChat={assistant.showChat}
            />
          ) : addOpen ? (
            <AddStepPanel
              place={placeText(def, at)}
              branchable={at > 0}
              onAdd={addWith}
              onEmpty={insertEmpty}
              onCancel={() => setAddOpen(false)}
            />
          ) : null}
        </Section>
      )}
    </div>
  );
}

/** A statement as it is typed: an empty one is not a branch, the last one written stays. */
function AskInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Textarea
      minRows={1}
      aria-label={t("editor.branch.statement")}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value.trim()) {
          onChange(e.target.value);
        }
      }}
      onBlur={() => setDraft(value)}
    />
  );
}

/** What a branch after a step can read: answers and AI results up to it, how many rows a list has. */
function branchSources(def: WizardDefinition, step: Step): string[] {
  const index = def.steps.indexOf(step);
  const out: string[] = [];
  for (const s of def.steps.slice(0, index + 1)) {
    if (s.type === "page") {
      out.push(...s.fields.map((f) => f.id));
    } else if (s.type === "agent") {
      for (const key of outputKeys(s)) {
        out.push(`steps.${s.id}.${key}`);
        if (isDecisionStep(s)) {
          out.push(`steps.${s.id}.${key}.p`);
        }
      }
    }
  }
  out.push(...(def.lists ?? []).map((l) => `lists.${l.id}.count`));
  return out;
}

/** "3 / 6 · Seite": where a step is and what it is. */
function stepPlace(def: WizardDefinition, step: Step): string {
  return `${typeLabel(step)} · ${def.steps.indexOf(step) + 1} / ${def.steps.length}`;
}

/** A step in brief, folded to its title; unfolded: what it asks or makes, its cost, where it leads. */
function StepOverview({
  def,
  target,
  estimate,
  onSelect,
}: {
  def: WizardDefinition;
  target: Step;
  estimate?: RunEstimate;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = stepIcon(target);
  const cost = estimate?.available ? estimate.steps[target.id]?.credits : undefined;
  const at = def.steps.indexOf(target);
  const then = def.steps[at + 1];
  return (
    <div className="rounded-lg bg-paper-2">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
            TYPE_TONE[target.type],
          )}
        >
          <Icon className="size-4" />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => onSelect(target.id)}
          title={t("editor.next.open")}
        >
          <span className="block text-[0.6875rem] text-ink-4">{stepPlace(def, target)}</span>
          <span className="block truncate font-medium text-[0.875rem] text-ink hover:underline">
            {target.title}
          </span>
        </button>
        <IconButton
          label={open ? t("editor.next.fold") : t("editor.next.unfold")}
          className="size-8 shrink-0"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </IconButton>
      </div>
      {open ? (
        <div className="flex flex-col gap-1 border-border-soft border-t px-3 py-2.5 text-[0.75rem] text-ink-3">
          {stepSummary(target) ? <span className="text-ink-2">{stepSummary(target)}</span> : null}
          {cost === undefined ? null : (
            <span className="tabular-nums">
              ≈{" "}
              {t("nav.credits", {
                n:
                  cost < 10
                    ? cost.toLocaleString(lang, { maximumFractionDigits: 1 })
                    : Math.round(cost),
              })}
            </span>
          )}
          <span>
            {t("editor.next.then")} →{" "}
            {target.type === "result"
              ? t("editor.branch.end")
              : target.next?.length
                ? t("editor.next.ways", { count: target.next.length + 1 })
                : then
                  ? then.title
                  : t("editor.branch.end")}
          </span>
          <button
            type="button"
            className="mt-1 self-start font-medium text-ember hover:underline"
            onClick={() => onSelect(target.id)}
          >
            {t("editor.next.open")} →
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where the run goes after a step. Without branches: the step that follows, in brief. With them:
 * one row per way — the conditions in the order they are checked, the statements the AI decides
 * between in one call, and "otherwise" — each unfolding to edit it; after a test run each row
 * shows how probable the decision found it and the way it took is marked.
 */
function NextSection({
  def,
  step,
  set,
  onSelect,
  decision,
  focus,
  estimate,
}: {
  def: WizardDefinition;
  step: Step;
  set: (next: Step) => void;
  onSelect: (id: string | null) => void;
  decision?: BranchDecision;
  focus?: number;
  estimate?: RunEstimate;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) {
      box.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [focus]);
  const [open, setOpen] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another step folds every row
  useEffect(() => setOpen(null), [step.id]);
  const rules = step.next ?? [];
  const index = def.steps.indexOf(step);
  const after = def.steps[index + 1];
  const titleOf = (id: string) =>
    def.steps.find((x) => x.id === id)?.title ?? t("editor.branch.end");
  const targets = [
    ...def.steps
      .filter((s) => s.id !== step.id)
      .map((s) => ({ value: s.id, label: `${def.steps.indexOf(s) + 1}. ${s.title}` })),
    { value: "end", label: t("editor.branch.end") },
  ];
  const sources = branchSources(def, step);
  const setRule = (i: number, rule: NextRule | null) => {
    set({
      ...step,
      next: rule
        ? rules.map((r, k) => (k === i ? rule : r))
        : rules.length > 1
          ? rules.filter((_, k) => k !== i)
          : undefined,
    } as Step);
    if (!rule) {
      setOpen(null);
    }
  };
  const add = (rule: NextRule) => {
    // Conditions are checked before any statement: a new one goes after the last condition.
    const at = rule.ask ? rules.length : rules.filter((r) => r.when !== undefined).length;
    set({ ...step, next: [...rules.slice(0, at), rule, ...rules.slice(at)] } as Step);
    setOpen(at);
  };
  const loops = (goto: string) => {
    const to = def.steps.findIndex((s) => s.id === goto);
    return to >= 0 && to <= index;
  };
  const p = (key: string) => decision?.probabilities?.[key];
  const hasAsk = rules.some((r) => r.ask);
  const ways = [
    ...rules.map((rule, i) => ({ rule, i })).filter(({ rule }) => rule.when !== undefined),
    ...rules.map((rule, i) => ({ rule, i })).filter(({ rule }) => rule.ask),
  ];
  // Where every other run goes: the "otherwise" branch, else the next step in the list.
  const otherwiseAt = rules.findIndex(isOtherwise);
  const otherwiseGoto = otherwiseAt >= 0 ? rules[otherwiseAt].goto : (after?.id ?? "end");
  const otherwiseTarget = def.steps.find((s) => s.id === otherwiseGoto);
  const setOtherwise = (goto: string) => {
    const rest = rules.filter((r) => !isOtherwise(r));
    // The next step in the list needs no branch of its own.
    const next = goto === (after?.id ?? "end") ? rest : [...rest, { goto }];
    set({ ...step, next: next.length ? next : undefined } as Step);
  };
  const how = `${t("editor.branch.how")} ${
    decision
      ? t("editor.branch.lastRun", {
          source:
            decision.source === "systemone"
              ? t("editor.branch.bySystemOne")
              : t("editor.branch.byLlm"),
        })
      : t("editor.branch.notYet")
  }`;
  const chip = (ai: boolean) =>
    ai ? (
      <span
        className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full bg-paper-3 px-2 py-0.5 font-medium text-[0.6875rem] text-ink-2"
        title={how}
      >
        <Sparkles className="size-3 text-ember" /> {t("editor.branch.ai")}
        <Info className="size-3 text-ink-4" />
      </span>
    ) : null;
  const percentOf = (value: number | undefined, taken: boolean) =>
    value === undefined ? null : (
      <span
        className={cn(
          "shrink-0 text-[0.75rem] tabular-nums",
          taken ? "font-medium text-moss" : "text-ink-3",
        )}
      >
        {percent(value)}
      </span>
    );
  const row = (
    key: number | "otherwise",
    head: React.ReactNode,
    goto: string,
    taken: boolean,
    probability: number | undefined,
    body: React.ReactNode,
  ) => {
    const unfolded = open === key || (key === "otherwise" && open === -1);
    return (
      <div
        key={key}
        className={cn("rounded-lg bg-paper-2 ring-1", taken ? "ring-moss" : "ring-transparent")}
      >
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 pt-2.5 text-left"
          onClick={() => setOpen(unfolded ? null : key === "otherwise" ? -1 : key)}
        >
          {head}
          {percentOf(probability, taken)}
          {unfolded ? (
            <ChevronUp className="size-4 shrink-0 text-ink-4" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-ink-4" />
          )}
        </button>
        <div className="px-3 pt-1 pb-2.5 text-[0.75rem] text-ink-3">
          →{" "}
          {goto === "end" ? (
            t("editor.branch.end")
          ) : (
            <button
              type="button"
              className="text-ink-2 hover:text-ink hover:underline"
              onClick={() => onSelect(goto)}
            >
              {titleOf(goto)}
            </button>
          )}
          {taken ? <span className="ml-1.5 text-moss">✓</span> : null}
        </div>
        {unfolded ? (
          <div className="flex flex-col gap-2 border-border-soft border-t px-3 py-3">{body}</div>
        ) : null}
      </div>
    );
  };
  const edit = (rule: NextRule, i: number) => (
    <>
      {rule.ask ? (
        <AskInput value={rule.ask} onChange={(ask) => setRule(i, { ...rule, ask })} />
      ) : (
        <ConditionEditor
          def={def}
          when={rule.when}
          sources={sources}
          label={t("editor.branch.when")}
          noneLabel={t("editor.branch.pick")}
          onChange={(when) => {
            if (when) {
              setRule(i, { ...rule, when });
            }
          }}
        />
      )}
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[0.8125rem] text-ink-3">→</span>
        <div className="min-w-0 flex-1">
          <Select
            value={rule.goto}
            onChange={(v) => setRule(i, { ...rule, goto: v })}
            options={targets}
          />
        </div>
        {loops(rule.goto) ? (
          <Input
            type="number"
            min={1}
            max={50}
            className="w-20 shrink-0"
            aria-label={t("editor.branch.max")}
            title={t("editor.branch.max")}
            placeholder="10"
            value={rule.max ?? ""}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              setRule(i, { ...rule, max: n >= 1 ? Math.min(n, 50) : undefined });
            }}
          />
        ) : null}
        <IconButton
          label={t("editor.branch.remove")}
          className="shrink-0 hover:text-rose"
          onClick={() => setRule(i, null)}
        >
          <Trash2 className="size-4" />
        </IconButton>
      </div>
    </>
  );
  const adders = (
    <div className="flex flex-wrap gap-1">
      <button
        type="button"
        disabled={!sources.length}
        onClick={() =>
          add({
            when: { field: sources[0] ?? "", op: "notEmpty" },
            goto: after?.id ?? "end",
          })
        }
        className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[0.75rem] text-ink-2 hover:bg-accent disabled:opacity-50"
      >
        <Plus className="size-3.5" /> {t("editor.branch.addWhen")}
      </button>
      <button
        type="button"
        onClick={() => add({ ask: t("editor.branch.newAsk"), goto: after?.id ?? "end" })}
        className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[0.75rem] text-ink-2 hover:bg-accent"
      >
        <Sparkles className="size-3.5" /> {t("editor.branch.addAsk")}
      </button>
    </div>
  );
  return (
    <div ref={box} className="scroll-mt-14">
      <Section
        title={
          ways.length ? t("editor.next.ways", { count: ways.length + 1 }) : t("editor.next.title")
        }
        loose
      >
        {rules.length ? (
          <>
            {ways.map(({ rule, i }) =>
              row(
                i,
                <>
                  {chip(Boolean(rule.ask))}
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink">
                    {rule.ask ??
                      conditionsOf(rule.when)
                        .map(conditionText)
                        .join(` ${t("editor.branch.and")} `)}
                  </span>
                </>,
                rule.goto,
                decision?.rule === i,
                p(`r${i}`),
                edit(rule, i),
              ),
            )}
            {row(
              "otherwise",
              <span className="min-w-0 flex-1 text-[0.8125rem] text-ink-3">
                {hasAsk ? t("editor.branch.none") : t("editor.otherwise")}
              </span>,
              otherwiseGoto,
              decision?.rule === null,
              p("none"),
              <>
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 text-[0.8125rem] text-ink-3">→</span>
                  <div className="min-w-0 flex-1">
                    <Select value={otherwiseGoto} onChange={setOtherwise} options={targets} />
                  </div>
                </div>
                {otherwiseTarget ? (
                  <StepOverview
                    def={def}
                    target={otherwiseTarget}
                    estimate={estimate}
                    onSelect={onSelect}
                  />
                ) : null}
              </>,
            )}
          </>
        ) : after ? (
          <StepOverview def={def} target={after} estimate={estimate} onSelect={onSelect} />
        ) : (
          <span className="text-[0.8125rem] text-ink-3">{t("editor.branch.end")}</span>
        )}
        {adders}
      </Section>
    </div>
  );
}
