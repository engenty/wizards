import type { KernelFile } from "@engenty/wizards-shared/definition";
import {
  isOutlineCode,
  isOutlineText,
  type KernelOutline,
  type OutlineValue,
  type OutlineWay,
  type StepOutline,
} from "@engenty/wizards-shared/kernel-file";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Braces,
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
} from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { cn } from "../../ui";
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
  onBack,
}: {
  wizard: KernelWizard;
  id: string;
  onBack?: () => void;
}) {
  const { file } = wizard;
  const { read } = useKernelCards(wizard);
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
        title={(id) => titleOf(id, read?.[id])}
        onBack={onBack}
      />
    );
  }
  return (
    <StepPanel
      id={id}
      step={read?.[id]}
      ways={file.edges[id] ?? []}
      title={(to) => (to === "end" ? t("editor.branch.end") : titleOf(to, read?.[to]))}
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
const CODE = "rounded bg-paper-2 px-1 font-mono text-[0.75rem] text-ink-2";

/** A value as the panel shows it: words as words, lists as chips, code as code. */
function Value({ value }: { value: OutlineValue }) {
  if (typeof value === "string") {
    return <span className="whitespace-pre-wrap">{value}</span>;
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
      <span className="whitespace-pre-wrap leading-relaxed">
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
          <span key={String(one)} className="rounded-full px-2.5 py-0.5 ring-1 ring-border-soft">
            {String(one)}
          </span>
        ))}
      </span>
    );
  }
  return (
    <pre className="overflow-x-auto rounded-lg bg-paper-2 p-2.5 font-mono text-[0.75rem] text-ink-2">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** The questions of a page, or the fields an answer has: label, kind, and whether it is required. */
function Fields({ fields }: { fields: OutlineValue[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {fields.map((field, i) => {
        const f = field as Spec;
        const options = Array.isArray(f?.options) ? f.options.map(String).join(", ") : "";
        return (
          <li
            key={i}
            className="flex items-baseline justify-between gap-3 rounded-lg bg-paper-2 px-3 py-2"
          >
            {isOutlineCode(field) ? (
              <code className={CODE}>{field.$code}</code>
            ) : (
              <>
                <span className="min-w-0 text-ink">
                  {str(f?.label) ?? str(f?.id)}
                  {f?.required === true ? <span className="text-ember"> *</span> : null}
                  {str(f?.description) ? (
                    <span className="block text-[0.75rem] text-ink-3">{str(f.description)}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-right text-[0.75rem] text-ink-3">
                  {[str(f?.kind), options].filter(Boolean).join(" · ")}
                </span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What an ask passes, in the order a person reads it; `type` and `title` are the panel's head. */
const FIRST = [
  "description",
  "fields",
  "instructions",
  "prompt",
  "show",
  "model",
  "format",
  "asset",
];

function Ask({ spec }: { spec: Spec }) {
  const keys = [
    ...FIRST.filter((key) => key in spec),
    ...Object.keys(spec).filter((key) => !FIRST.includes(key) && key !== "type" && key !== "title"),
  ];
  const label = (key: string) =>
    key === "fields"
      ? kindOf(spec) === "form"
        ? t("inspector.questions")
        : key
      : key === "instructions" || key === "prompt"
        ? t("inspector.task")
        : key;
  return (
    <div className="flex flex-col gap-4">
      {keys.map((key) => (
        <div key={key} className="flex flex-col gap-1.5 text-[0.875rem] text-ink">
          <span className={LABEL}>{label(key)}</span>
          {key === "fields" && Array.isArray(spec.fields) ? (
            <Fields fields={spec.fields} />
          ) : (
            <Value value={spec[key]} />
          )}
        </div>
      ))}
    </div>
  );
}

function StepPanel({
  id,
  path,
  step,
  ways,
  title,
  onBack,
}: {
  id: string;
  /** The file the step is read from, where that is not `steps/<id>.ts`. */
  path?: string;
  step: StepOutline | undefined;
  /** The step's ways in the file. The first is taken where the step names none. */
  ways: string[];
  title: (id: string) => string;
  /** Leads back to the map, where the panel stands in its place. */
  onBack?: () => void;
}) {
  // Each way of the file with the condition the code has for it; the code's own where it names one.
  const named = (step?.ways ?? []).map((way) => ({ ...way, to: way.to ?? ways[0] }));
  const shown: OutlineWay[] = named.length ? named : ways.map((to) => ({ to }));
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex items-center gap-2 border-border-soft border-b px-4 py-3">
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
      <div className="flex flex-col gap-6 px-5 py-5">
        {step?.error ? <p className="text-[0.875rem] text-rose">{step.error}</p> : null}
        {(step?.asks ?? []).map((ask, i) => {
          const Icon = iconOf(ask.spec);
          return (
            <section key={i} className="flex flex-col gap-4">
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
              <h3 className="font-display font-semibold text-[1.0625rem] text-ink">
                {str(ask.spec?.title) ?? (i === 0 ? (step?.title ?? id) : "")}
              </h3>
              {ask.spec ? <Ask spec={ask.spec} /> : <code className={CODE}>{ask.code}</code>}
            </section>
          );
        })}
        <section className="flex flex-col gap-2 border-border-soft border-t pt-5">
          <span className={LABEL}>{t("kernel.ways")}</span>
          {shown.map((way, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-[0.875rem] text-ink">
              {way.ask ? (
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="size-3.5 text-ember" />
                  {way.ask}
                </span>
              ) : way.why || redoes(step?.asks[0]?.spec, way.to) ? (
                <span>{way.why ?? t("kernel.redo")}</span>
              ) : way.when ? (
                <code className={CODE}>{way.when}</code>
              ) : shown.length > 1 ? (
                <span className="text-ink-3">{t("editor.otherwise")}</span>
              ) : null}
              <span>
                → {way.code ? <code className={CODE}>{way.code}</code> : title(way.to ?? "end")}
              </span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
