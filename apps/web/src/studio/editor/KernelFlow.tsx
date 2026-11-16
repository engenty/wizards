import type { KernelFile } from "@engenty/wizards-shared/definition";
import {
  isOutlineCode,
  isOutlineText,
  type KernelOutline,
  type OutlineEdit,
  type OutlineValue,
  type OutlineWay,
  type StepOutline,
} from "@engenty/wizards-shared/kernel-file";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Braces,
  Check,
  ChevronRight,
  Eye,
  FileCode2,
  FileText,
  Flag,
  Hourglass,
  Image,
  ListChecks,
  type LucideIcon,
  Plug,
  Sparkles,
  X,
} from "lucide-react";
import { lazy, Suspense, useContext, useMemo } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { cn } from "../../ui";
import {
  BlockTools,
  CODE,
  KernelEditContext,
  type KernelEditing,
  useEditable,
  Words,
} from "./KernelEdit";
import { kernelFlow } from "./kernel-flow";

const FlowPreview = lazy(() => import("../FlowPreview"));

/** The kinds of ask the studio has a name, an icon and colours for. */
const KINDS: Record<string, { icon: LucideIcon; tone: string }> = {
  form: { icon: ListChecks, tone: "bg-cobalt-tint text-cobalt" },
  agent: { icon: Bot, tone: "bg-ember-tint text-ember-strong" },
  tool: { icon: Plug, tone: "bg-ember-tint text-ember-strong" },
  code: { icon: Braces, tone: "bg-ember-tint text-ember-strong" },
  generate: { icon: Image, tone: "bg-amber-tint text-ink-2" },
  review: { icon: Eye, tone: "bg-moss-tint text-moss" },
  wait: { icon: Hourglass, tone: "bg-cobalt-tint text-cobalt" },
  result: { icon: Flag, tone: "bg-paper-2 text-ink-2" },
};
const IN_CODE = { icon: FileCode2, tone: "bg-paper-2 text-ink-2" };

type Spec = Record<string, OutlineValue>;

const str = (value: OutlineValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A text as one line: its words, with "…" where code fills something in. */
function plain(value: OutlineValue | undefined): string {
  if (typeof value === "string") return value;
  if (isOutlineText(value))
    return value.$text.map((part) => (typeof part === "string" ? part : "…")).join("");
  return "";
}

const kindOf = (spec: Spec | undefined) => str(spec?.type) ?? "";

function kindLabel(type: string): string {
  return type in KINDS ? t(`type.${type}` as "type.form") : type || t("kernel.inCode");
}

/** An ask of a step by its title, else by its kind: what the preview lists to choose from. */
export const askName = (spec: Spec | undefined): string =>
  plain(spec?.title) || kindLabel(kindOf(spec));

/** A document, where a generate ask makes one: the icon the editor's diagram has for it. */
function iconOf(spec: Spec | undefined): LucideIcon {
  const kind = KINDS[kindOf(spec)];
  if (!kind) return IN_CODE.icon;
  return kindOf(spec) === "generate" && spec?.asset !== "image" ? FileText : kind.icon;
}

/** One line under a card's title: what the step asks or does. */
function summaryOf(spec: Spec | undefined, description: string | undefined): string {
  if (!spec) return description ?? "";
  const list = (value: OutlineValue | undefined) => (Array.isArray(value) ? value : []);
  switch (kindOf(spec)) {
    case "form":
      return list(spec.fields)
        .map((f) => str((f as Spec)?.label) ?? str((f as Spec)?.id) ?? "")
        .filter(Boolean)
        .join(" · ");
    case "agent":
      return plain(spec.instructions).replace(/\s+/g, " ").slice(0, 90);
    case "generate":
      return [str(spec.asset), ...Object.values((spec.options as Spec) ?? {}).map(str)]
        .filter(Boolean)
        .join(" · ");
    case "review":
      return [
        spec.edit === true ? t("editor.reviewEditable") : null,
        spec.regenerate === true ? t("editor.reviewRedo") : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "wait":
      return [str(spec.signal), str(spec.timeout)].filter(Boolean).join(" · ");
  }
  return str(spec.description) ?? description ?? "";
}

/** Whether a way sends a step a review shows back to be made again. */
const redoes = (spec: Spec | undefined, to: string | undefined) =>
  kindOf(spec) === "review" &&
  spec?.regenerate === true &&
  Array.isArray(spec.show) &&
  spec.show.includes(to ?? "");

/**
 * A way's words on its arrow: what a model decides, the words the step gives it, what a review's
 * way back does, or the condition as the code has it.
 */
function wayWords(way: OutlineWay | undefined, spec: Spec | undefined): string {
  if (way?.ask) return `${t("editor.branch.addAsk")}: ${way.ask}`;
  if (way?.why) return way.why;
  if (redoes(spec, way?.to)) return t("kernel.redo");
  return way?.when ?? "";
}

const titleOf = (id: string, step: StepOutline | undefined) =>
  str(step?.asks[0]?.spec?.title) ?? step?.title ?? id;

/** A wizard of version 0.3.0 as the studio reads it: its id, its file and its workspace. */
export interface KernelWizard {
  wizardId: string;
  file: KernelFile;
  files: WorkspaceFile[];
}

/**
 * The steps of a wizard in version 0.3.0 as cards, in the order the map draws them: the page a run
 * starts with, each step with what its code asks, read from `steps/<id>.ts` without running it,
 * and the result (`end`). Empty without a wizard.
 */
export function useKernelCards(wizard: KernelWizard | undefined) {
  const { wizardId, file, files = [] } = wizard ?? {};
  const code = files
    .filter((f) => f.path.startsWith("steps/"))
    .map((f) => f.hash)
    .join(",");
  const outline = useQuery({
    queryKey: ["wizard-outline", wizardId, code],
    queryFn: () => api.get<{ steps: KernelOutline }>(`/api/studio/wizards/${wizardId}/outline`),
    enabled: Boolean(wizard),
  });
  const read = outline.data?.steps;
  const flow = useMemo(() => (file ? kernelFlow(file) : []), [file]);
  const steps = useMemo(() => {
    if (!file) return [];
    // What the file itself holds: the page a run starts with, and what it ends with.
    const input = file.input?.fields.length
      ? [
          {
            id: INPUT,
            title: t("kernel.input"),
            kind: kindLabel("form"),
            summary: summaryOf({ type: "form", fields: file.input.fields as OutlineValue[] }, ""),
            icon: KINDS.form.icon,
            tone: KINDS.form.tone,
            optional: false,
          },
        ]
      : [];
    const end = {
      id: "end",
      title: t("type.result"),
      kind: kindLabel("result"),
      summary: Object.keys(file.output ?? {}).join(" · "),
      icon: KINDS.result.icon,
      tone: KINDS.result.tone,
      optional: false,
    };
    return [
      ...input,
      ...flow.map((step, at) => {
        // The last step goes on to the end where that is one of its ways.
        const ends = at === flow.length - 1 && step.branches.some((b) => b.to === "end");
        // A way back says how often it may be taken; the step it leads to then need not.
        const back = (to: string) => {
          const target = flow.findIndex((other) => other.id === to);
          return target >= 0 && target <= at ? flow[target].limit : undefined;
        };
        const reached = flow.some(
          (other, from) => from >= at && other.branches.some((b) => b.to === step.id),
        );
        const one = read?.[step.id];
        const spec = one?.asks[0]?.spec;
        const more = (one?.asks.length ?? 0) - 1;
        return {
          id: step.id,
          title: titleOf(step.id, one),
          kind: kindLabel(kindOf(spec)) + (more > 0 ? ` +${more}` : ""),
          summary: summaryOf(spec, one?.description),
          note:
            step.limit && !reached && !step.branches.some((b) => back(b.to))
              ? t("kernel.limit", { n: step.limit })
              : undefined,
          icon: iconOf(spec),
          tone: (KINDS[kindOf(spec)] ?? IN_CODE).tone,
          optional: false,
          flowsOn: step.flowsOn || ends,
          branches: step.branches
            .filter((b) => !(ends && b.to === "end"))
            .map((b) => ({
              to: b.to,
              when: [
                wayWords(
                  one?.ways.find((way) => way.to === b.to),
                  spec,
                ),
                back(b.to) ? t("kernel.limit", { n: (back(b.to) as number) - 1 }) : "",
              ]
                .filter(Boolean)
                .join("\n"),
            })),
        };
      }),
      end,
    ];
  }, [flow, read, file]);
  return { steps, read };
}

/** One step of a wizard in version 0.3.0, or the page its runs start with: all of it, to read. */
export function KernelStep({
  wizard,
  id,
  readOnly,
  onSelect,
  onNote,
  onBack,
}: {
  wizard: KernelWizard;
  id: string;
  /** Nothing of the step is changed here. */
  readOnly?: boolean;
  /** Sends a note about one element of the step to the assistant. */
  onNote?: (text: string) => void;
  /** Chooses the step a way leads to. */
  onSelect?: (id: string) => void;
  onBack?: () => void;
}) {
  const { file } = wizard;
  const { read, steps } = useKernelCards(wizard);
  const target = (to: string) => steps.find((step) => step.id === to);
  const qc = useQueryClient();
  const hash = wizard.files.find((f) => f.path === `steps/${id}.ts`)?.hash;
  // A text typed over goes into the step's file; the wizard, read again, has the file's new hash,
  // and with it the panel reads the step anew.
  const write = useMutation({
    mutationFn: (body: { at: [number, number]; value: OutlineEdit }) =>
      api.post(`/api/studio/wizards/${wizard.wizardId}/outline`, { step: id, hash, ...body }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.wizard(wizard.wizardId) }),
  });
  const editing = {
    save: (at: [number, number], value: OutlineEdit) => write.mutate({ at, value }),
    note: onNote
      ? (about: string, text: string) => onNote(`steps/${id}.ts · „${about}“: ${text}`)
      : undefined,
  };
  if (id === INPUT && file.input) {
    return (
      <StepPanel
        id={INPUT}
        path="wizard.json"
        step={{
          asks: [
            {
              spec: {
                type: "form",
                title: t("kernel.input"),
                fields: file.input.fields as OutlineValue[],
              },
            },
          ],
          ways: [{ to: file.start }],
        }}
        ways={[file.start]}
        target={target}
        onSelect={onSelect}
        onBack={onBack}
      />
    );
  }
  return (
    <StepPanel
      id={id}
      step={read?.[id]}
      ways={file.edges[id] ?? []}
      // A change that was not written leaves the panel: it shows the file again.
      key={`${id}:${write.failureCount}`}
      target={target}
      editing={readOnly ? undefined : editing}
      failed={write.error ? (write.error as Error).message : undefined}
      onSelect={onSelect}
      onBack={onBack}
    />
  );
}

/** The first of a wizard's steps: the page its runs start with, or the step the file starts at. */
export const firstKernelStep = (file: KernelFile) =>
  file.input?.fields.length ? INPUT : file.start;

/**
 * The map of a wizard in version 0.3.0: its ways from the file, and on each step what its code
 * asks. A click on a step chooses it.
 */
export function KernelFlow({
  wizard,
  selected,
  onSelect,
}: {
  wizard: KernelWizard;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { steps } = useKernelCards(wizard);
  return (
    <div className="flex h-full flex-col items-center gap-4 overflow-auto px-6 py-8">
      <Suspense fallback={null}>
        <FlowPreview
          steps={steps}
          cards
          selected={selected ?? undefined}
          onSelect={(id) => {
            if (id !== "end") onSelect(id);
          }}
        />
      </Suspense>
    </div>
  );
}

/** The card of the file's `input`: no step has this id, a step's is a file's name. */
const INPUT = "/input";

const LABEL = "font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.07em]";
/** A value in its place, the way a form shows one: on a ground of its own, under its label. */
const BOX = "rounded-md bg-paper-2 px-4 py-3 text-[0.9375rem] text-ink";

const short = (value: OutlineValue) =>
  typeof value === "number" ||
  typeof value === "boolean" ||
  (typeof value === "string" && value.length <= 40 && !value.includes("\n")) ||
  (isOutlineCode(value) && value.$code.length <= 40) ||
  (Array.isArray(value) &&
    value.every((one) => typeof one !== "object" || one === null) &&
    value.join("").length <= 60);

/** A value as the panel shows it: words as words, lists as chips, code as code. */
function Value({
  value,
  path,
  lines,
}: {
  value: OutlineValue;
  /** Where the value stands in its ask: a text there is typed over in place. */
  path?: string;
  lines?: boolean;
}) {
  if (path && (typeof value === "string" || isOutlineText(value))) {
    return (
      <Words path={path} value={value} lines={lines} bare={lines} className="leading-relaxed" />
    );
  }
  if (typeof value === "string") {
    return <span className="whitespace-pre-wrap leading-relaxed">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return (
      <span>{value === true ? t("kernel.yes") : value === false ? t("kernel.no") : value}</span>
    );
  }
  if (isOutlineCode(value)) {
    return <code className={CODE}>{value.$code}</code>;
  }
  if (isOutlineText(value)) {
    return (
      <span className="whitespace-pre-wrap leading-[1.9]">
        {value.$text.map((part, i) =>
          typeof part === "string" ? (
            <span key={i}>{part}</span>
          ) : (
            <code key={i} className={CODE}>
              {part.$code}
            </code>
          ),
        )}
      </span>
    );
  }
  if (Array.isArray(value) && value.every((one) => typeof one !== "object" || one === null)) {
    return (
      <span className="flex flex-wrap gap-1.5">
        {value.map((one) => (
          <span
            key={String(one)}
            className="rounded-full bg-card px-2.5 py-0.5 text-[0.8125rem] text-ink-2"
          >
            {String(one)}
          </span>
        ))}
      </span>
    );
  }
  return (
    <pre className="overflow-x-auto font-mono text-[0.75rem] text-ink-2">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const SHOWN = ["id", "label", "kind", "required", "description", "options", "columns"];

/** A value's entries, an object inside it by its path: `vat.field`. */
function entries(spec: Spec, skip: string[] = []): [string, OutlineValue][] {
  return Object.entries(spec ?? {})
    .filter(([key]) => !skip.includes(key))
    .flatMap(([key, value]): [string, OutlineValue][] =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !isOutlineCode(value) &&
      !isOutlineText(value)
        ? entries(value as Spec).map(([name, one]) => [`${key}.${name}`, one])
        : [[key, value]],
    );
}

/** The questions of a page, or the fields an answer has: label, kind, and whether it is required. */
function Fields({ fields }: { fields: OutlineValue[] }) {
  const tools = Boolean(useContext(KernelEditContext)?.note);
  return (
    <ul className="flex flex-col gap-1.5">
      {fields.map((field, i) => {
        const f = field as Spec;
        const options = Array.isArray(f?.options) ? f.options.map(String) : [];
        const columns = Array.isArray(f?.columns) ? f.columns : [];
        // Whatever else the question sets: its default, its currency, the field its tax comes from.
        const more = isOutlineCode(field) ? [] : entries(f, SHOWN);
        return (
          <li key={i} className={cn(BOX, "group/block relative flex flex-col gap-2")}>
            <BlockTools about={str(f?.label) ?? str(f?.id) ?? String(i + 1)} />
            {isOutlineCode(field) ? (
              <code className={cn(CODE, "self-start")}>{field.$code}</code>
            ) : (
              <>
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 font-medium text-ink">
                    {str(f?.label) ? (
                      <Words path={`fields.${i}.label`} value={str(f.label) as string} />
                    ) : (
                      str(f?.id)
                    )}
                    {f?.required === true ? <span className="text-ember"> *</span> : null}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[0.75rem] text-ink-3",
                      // The block's tools take this corner while the pointer is on it.
                      tools &&
                        "transition-opacity group-focus-within/block:opacity-0 group-hover/block:opacity-0",
                    )}
                  >
                    {str(f?.kind)}
                  </span>
                </span>
                {str(f?.description) ? (
                  <Words
                    path={`fields.${i}.description`}
                    value={str(f.description) as string}
                    className="text-[0.8125rem] text-ink-2"
                  />
                ) : null}
                {options.length ? (
                  <span className="flex flex-wrap gap-1.5 text-[0.8125rem] text-ink-2">
                    {options.map((one, at) => (
                      <span key={at} className="rounded-full bg-card px-2.5 py-0.5">
                        <Words path={`fields.${i}.options.${at}`} value={one} />
                      </span>
                    ))}
                  </span>
                ) : null}
                {columns.length ? (
                  <span className="flex flex-col gap-1">
                    {columns.map((column, at) => {
                      const c = column as Spec;
                      return (
                        <span
                          key={at}
                          className="flex items-baseline justify-between gap-3 rounded bg-card px-3 py-1.5 text-[0.875rem]"
                        >
                          {isOutlineCode(column) ? (
                            <code className={CODE}>{column.$code}</code>
                          ) : (
                            <>
                              {str(c?.label) ? (
                                <Words
                                  path={`fields.${i}.columns.${at}.label`}
                                  value={str(c.label) as string}
                                />
                              ) : (
                                <span>{str(c?.id)}</span>
                              )}
                              <span className="font-mono text-[0.75rem] text-ink-3">
                                {str(c?.kind)}
                              </span>
                            </>
                          )}
                        </span>
                      );
                    })}
                  </span>
                ) : null}
                {more.length ? (
                  <span className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem]">
                    {more.map(([name, one]) => (
                      <span key={name} className="inline-flex items-baseline gap-1.5">
                        <span className="text-ink-3">{name}</span>
                        <Value value={one} />
                      </span>
                    ))}
                  </span>
                ) : null}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What a review's switches allow the person, in the editor's words. */
const ALLOWS: Record<string, "editor.reviewEditable" | "editor.reviewRedo"> = {
  edit: "editor.reviewEditable",
  regenerate: "editor.reviewRedo",
};

/** What an ask passes, in the order a person reads it; `type` and `title` are the panel's head. */
const FIRST = ["description", "fields", "instructions", "prompt"];

/** A long value on a ground of its own; a text among them turns to an input when clicked into. */
function Long({ path, about, value }: { path: string; about: string; value: OutlineValue }) {
  const pen = useEditable(path);
  return (
    <div
      className={cn(
        BOX,
        "group/block relative",
        pen && "transition-colors focus-within:bg-card focus-within:shadow-[0_0_0_2px_var(--ring)]",
      )}
    >
      <BlockTools about={about} pen={pen} />
      <Value value={value} path={path} lines />
    </div>
  );
}

function Ask({ spec: given }: { spec: Spec }) {
  let spec = given;
  // An object of short values is read as its entries: `options.template`, not a block of JSON.
  const flat: Spec = {};
  for (const [key, value] of Object.entries(spec)) {
    const inner =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !isOutlineCode(value) &&
      !isOutlineText(value)
        ? Object.entries(value as Spec)
        : [];
    if (inner.length && inner.every(([, one]) => short(one))) {
      for (const [name, one] of inner) flat[`${key}.${name}`] = one;
    } else flat[key] = value;
  }
  spec = flat;
  const rest = Object.keys(spec).filter(
    (key) => !FIRST.includes(key) && key !== "type" && key !== "title",
  );
  // Long values get a field of their own; the short ones stand together, name left and value right.
  const long = [...FIRST.filter((key) => key in spec), ...rest.filter((key) => !short(spec[key]))];
  const small = rest.filter((key) => short(spec[key]));
  const label = (key: string) =>
    key === "fields" && kindOf(spec) === "form"
      ? t("inspector.questions")
      : key === "instructions" || key === "prompt"
        ? t("inspector.task")
        : key;
  return (
    <div className="flex flex-col gap-4">
      {long.map((key) => (
        <div key={key} className="flex flex-col gap-1.5">
          <span className={LABEL}>{label(key)}</span>
          {key === "fields" && Array.isArray(spec.fields) ? (
            <Fields fields={spec.fields} />
          ) : (
            <Long path={key} about={label(key)} value={spec[key]} />
          )}
        </div>
      ))}
      {small.length ? (
        // The settings as notes under the fields: on the panel's own ground, a name and its value
        // on each line.
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1 px-1 text-[0.8125rem]">
          {small.map((key) => {
            const value = spec[key];
            const words = kindOf(spec) === "review" ? ALLOWS[key] : undefined;
            const Mark = value === true ? Check : X;
            return (
              <div key={key} className="contents">
                <dt className="text-ink-3">{label(key)}</dt>
                <dd className="min-w-0 text-ink">
                  {typeof value === "boolean" ? (
                    <span
                      className={cn("inline-flex items-center gap-1.5", !value && "text-ink-3")}
                    >
                      <Mark className={cn("size-3.5 shrink-0", value && "text-moss")} />
                      {words ? t(words) : t(value ? "kernel.yes" : "kernel.no")}
                    </span>
                  ) : (
                    <Value value={value} path={key} />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </div>
  );
}

function StepPanel({
  id,
  path,
  step,
  ways,
  target,
  editing,
  failed,
  onSelect,
  onBack,
}: {
  id: string;
  /** The file the step is read from, where that is not `steps/<id>.ts`. */
  path?: string;
  step: StepOutline | undefined;
  /** The step's ways in the file. The first is taken where the step names none. */
  ways: string[];
  /** The step a way leads to, as its card. */
  target: (id: string) => { title: string; icon: LucideIcon; tone: string } | undefined;
  /** What changes the step: a text typed over, a note to the assistant. Left out, it is read only. */
  editing?: Pick<KernelEditing, "save" | "note">;
  /** Why the last change was not written. */
  failed?: string;
  /** Chooses the step a way leads to. */
  onSelect?: (id: string) => void;
  /** Leads back to the map, where the panel stands in its place. */
  onBack?: () => void;
}) {
  // Each way of the file with the condition the code has for it; the code's own where it names one.
  const named = (step?.ways ?? []).map((way) => ({ ...way, to: way.to ?? ways[0] }));
  const shown: OutlineWay[] = named.length ? named : ways.map((to) => ({ to }));
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex items-center gap-2 px-5 pt-4">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.8125rem] text-ink-2 hover:bg-paper-2"
          >
            <ArrowLeft className="size-3.5" />
            {t("editor.flow")}
          </button>
        ) : null}
        <code className="ml-auto font-mono text-[0.75rem] text-ink-3">
          {path ?? `steps/${id}.ts`}
        </code>
      </div>
      <div className="flex flex-col gap-8 px-5 pt-2 pb-8">
        {step?.error ? <p className="text-[0.875rem] text-rose">{step.error}</p> : null}
        {failed ? <p className="text-[0.875rem] text-rose">{failed}</p> : null}
        {(step?.asks ?? []).map((ask, i) => {
          const Icon = iconOf(ask.spec);
          return (
            <KernelEditContext.Provider
              key={i}
              value={
                editing ? { path: path ?? `steps/${id}.ts`, at: ask.at ?? {}, ...editing } : null
              }
            >
              <section className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex size-6 items-center justify-center rounded-md",
                      (KINDS[kindOf(ask.spec)] ?? IN_CODE).tone,
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span className={LABEL}>{kindLabel(kindOf(ask.spec))}</span>
                </div>
                <h3 className="-mt-1 font-display font-semibold text-[1.5rem] text-ink leading-tight">
                  {str(ask.spec?.title) ? (
                    <Words path="title" value={str(ask.spec?.title) as string} />
                  ) : i === 0 ? (
                    (step?.title ?? id)
                  ) : (
                    ""
                  )}
                </h3>
                {ask.spec ? <Ask spec={ask.spec} /> : <code className={CODE}>{ask.code}</code>}
              </section>
            </KernelEditContext.Provider>
          );
        })}
        <section className="flex flex-col gap-1.5">
          <span className={cn(LABEL, "mb-1")}>{t("kernel.ways")}</span>
          {shown.map((way, i) => {
            const to = way.to ?? "end";
            const card = way.code ? undefined : target(to);
            const open = card && to !== "end" && onSelect ? () => onSelect(to) : undefined;
            const Icon = card?.icon;
            return (
              <button
                key={i}
                type="button"
                disabled={!open}
                onClick={open}
                className={cn(
                  BOX,
                  "group flex items-center gap-3 text-left",
                  open && "cursor-pointer hover:bg-paper-3",
                )}
              >
                {Icon ? (
                  <span
                    className={cn(
                      "inline-flex size-8 shrink-0 items-center justify-center rounded",
                      card.tone,
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                ) : null}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[0.8125rem] text-ink-2">
                    {way.ask ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Sparkles className="size-3.5 text-ember" />
                        {way.ask}
                      </span>
                    ) : way.why || redoes(step?.asks[0]?.spec, way.to) ? (
                      (way.why ?? t("kernel.redo"))
                    ) : way.when ? (
                      <code className={CODE}>{way.when}</code>
                    ) : shown.length > 1 ? (
                      t("editor.otherwise")
                    ) : null}
                  </span>
                  <span className="font-medium">
                    {way.code ? <code className={CODE}>{way.code}</code> : card?.title}
                  </span>
                </span>
                {open ? (
                  <ChevronRight className="size-4 shrink-0 text-ink-3 group-hover:text-ink" />
                ) : null}
              </button>
            );
          })}
        </section>
      </div>
    </div>
  );
}
