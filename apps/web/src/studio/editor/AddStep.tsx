import type { Step, WizardDefinition } from "@engenty-wizards/shared/definition";
import {
  AppWindow,
  Bot,
  ChevronDown,
  Image,
  LayoutTemplate,
  ListChecks,
  MessageCircle,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Key, t } from "../../lib/i18n";
import { Button, cn, Input, Textarea } from "../../ui";

/** What a new step is to be: the assistant picks with "auto". */
export const ADD_KINDS = ["auto", "page", "agent", "generate", "surface", "widget"] as const;
export type AddKind = (typeof ADD_KINDS)[number];

/** The kinds an empty step can be inserted as, without the assistant. */
export const EMPTY_KINDS = ["page", "agent", "generate", "widget"] as const;
export type EmptyKind = (typeof EMPTY_KINDS)[number];

const KIND_ICON: Record<AddKind, typeof Bot> = {
  auto: Sparkles,
  page: ListChecks,
  agent: Bot,
  generate: Image,
  surface: LayoutTemplate,
  widget: AppWindow,
};

const kindLabel = (k: AddKind) => (k === "auto" ? t("addStep.auto") : t(`type.${k}` as Key));

/**
 * When the new step comes: on every run, or only on a branch from the step before it – under a
 * condition the admin writes in their own words, or when the AI finds a statement true.
 */
export type AddWhen = { mode: "if" | "ask"; text: string };

/** A step being added through the conversation: where, as what, and what was asked. */
export interface Adding {
  /** The new step goes before the step at this index. */
  at: number;
  kind: AddKind;
  prompt: string;
  /** Absent: every run goes through the new step. */
  when?: AddWhen;
}

/** Where a new step goes, in words: "after „Suche“, before „Ergebnis“". */
export function placeText(def: WizardDefinition, at: number): string {
  const before = def.steps[at - 1];
  const after = def.steps[at];
  if (before && after) {
    return t("addStep.between", { before: before.title, after: after.title });
  }
  return before
    ? t("addStep.after", { title: before.title })
    : t("addStep.first", { title: after?.title ?? "" });
}

/**
 * What the conversation shows and the assistant reads for a step asked for in the step panel or
 * the diagram: where it goes, what it is to be, and the admin's own words.
 */
export function addStepMessage(def: WizardDefinition, { at, kind, prompt, when }: Adding): string {
  const place = placeText(def, at);
  const head =
    kind === "auto"
      ? t("addStep.message", { place })
      : t("addStep.messageAs", { place, kind: kindLabel(kind) });
  const branch = when
    ? `\n${t(when.mode === "if" ? "addStep.messageIf" : "addStep.messageAsk", {
        text: when.text.trim(),
        from: def.steps[at - 1]?.title ?? "",
      })}`
    : "";
  return `${head}${branch}\n${prompt.trim()}`;
}

/**
 * Adding a step: the admin says what should happen there, the assistant builds it in the
 * conversation. A kind can be chosen or left to the assistant; an empty step stays at hand.
 */
export function AddStepPanel({
  place,
  branchable,
  onAdd,
  onEmpty,
  onCancel,
}: {
  /** Where the step goes, in words. */
  place: string;
  /** A step comes before it: the new step can be a branch from there. */
  branchable: boolean;
  /** False when the conversation took nothing: it is still busy with an earlier turn. */
  onAdd: (kind: AddKind, prompt: string, when?: AddWhen) => boolean;
  onEmpty?: (kind: EmptyKind) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<AddKind>("auto");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [whenMode, setWhenMode] = useState<"always" | AddWhen["mode"]>("always");
  const [whenText, setWhenText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  const submit = () => {
    if (!prompt.trim()) {
      setError(t("addStep.empty"));
      return;
    }
    if (whenMode !== "always" && !whenText.trim()) {
      setError(t("addStep.whenEmpty"));
      return;
    }
    const when = whenMode === "always" ? undefined : { mode: whenMode, text: whenText };
    if (!onAdd(kind, prompt, when)) {
      setError(t("addStep.busy"));
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border">
      <div>
        <p className="font-medium text-[0.875rem]">{t("addStep.title")}</p>
        <p className="text-[0.75rem] text-ink-3">{place}</p>
      </div>
      <Textarea
        ref={area}
        minRows={3}
        maxRows={10}
        aria-label={t("addStep.title")}
        placeholder={t("addStep.placeholder")}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
      />
      {error ? <p className="-mt-1.5 text-[0.75rem] text-rose">{error}</p> : null}
      <fieldset className="flex flex-wrap gap-1.5" aria-label={t("addStep.kind")}>
        {ADD_KINDS.map((k) => {
          const Icon = KIND_ICON[k];
          return (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[0.75rem] ring-1 transition",
                kind === k
                  ? "bg-ember-tint text-ember-strong ring-ember/40"
                  : "text-ink-2 ring-border hover:bg-accent",
              )}
            >
              <Icon className="size-3.5" /> {kindLabel(k)}
            </button>
          );
        })}
      </fieldset>
      {branchable ? (
        <div className="flex flex-col gap-2">
          <fieldset className="flex flex-wrap items-center gap-1.5" aria-label={t("addStep.when")}>
            <span className="mr-1 text-[0.75rem] text-ink-3">{t("addStep.when")}</span>
            {(["always", "if", "ask"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={whenMode === m}
                onClick={() => {
                  setWhenMode(m);
                  setError(null);
                }}
                className={cn(
                  "inline-flex h-7 items-center whitespace-nowrap rounded-full px-3 text-[0.75rem] ring-1 transition",
                  whenMode === m
                    ? "bg-ember-tint text-ember-strong ring-ember/40"
                    : "text-ink-2 ring-border hover:bg-accent",
                )}
              >
                {t(
                  m === "always"
                    ? "addStep.always"
                    : m === "if"
                      ? "addStep.onlyIf"
                      : "addStep.aiDecides",
                )}
              </button>
            ))}
          </fieldset>
          {whenMode === "always" ? null : (
            <Input
              aria-label={t(whenMode === "if" ? "addStep.onlyIf" : "addStep.aiDecides")}
              placeholder={t(
                whenMode === "if" ? "addStep.ifPlaceholder" : "addStep.askPlaceholder",
              )}
              value={whenText}
              onChange={(e) => {
                setWhenText(e.target.value);
                setError(null);
              }}
            />
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {onEmpty ? (
          <div className="relative">
            <button
              type="button"
              aria-expanded={emptyOpen}
              onClick={() => setEmptyOpen((o) => !o)}
              className="inline-flex h-8 items-center gap-1 rounded-full px-2 text-[0.75rem] text-ink-3 hover:bg-accent hover:text-ink"
            >
              {t("addStep.emptyStep")} <ChevronDown className="size-3.5" />
            </button>
            {emptyOpen ? (
              <div className="absolute bottom-full left-0 z-20 mb-1 flex min-w-40 flex-col rounded-xl bg-card p-1 shadow-elevated ring-1 ring-border">
                {EMPTY_KINDS.map((k) => {
                  const Icon = KIND_ICON[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => onEmpty(k)}
                      className="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-[0.8125rem] text-ink-2 hover:bg-accent"
                    >
                      <Icon className="size-3.5" /> {kindLabel(k)}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("addStep.cancel")}
          </Button>
          <Button size="sm" onClick={submit}>
            <Sparkles className="size-3.5" /> {t("addStep.create")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A step the assistant is building: where it goes, what was asked, and how far it is. */
export function AddingCard({
  adding,
  place,
  working,
  onShowChat,
}: {
  adding: Adding;
  place: string;
  working: ReactNode;
  onShowChat?: () => void;
}) {
  const Icon = KIND_ICON[adding.kind];
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border-strong border-dashed bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center rounded-md bg-paper-2 text-ink-3">
          <Icon className="size-3.5" />
        </span>
        <span className="font-medium text-[0.8125rem]">{t("addStep.building")}</span>
      </div>
      <p className="text-[0.75rem] text-ink-3">{place}</p>
      {adding.when ? (
        <p className="text-[0.75rem] text-ember-strong">
          {t(adding.when.mode === "if" ? "addStep.onlyIf" : "addStep.aiDecides")} {adding.when.text}
        </p>
      ) : null}
      <p className="line-clamp-3 whitespace-pre-wrap text-[0.8125rem] text-ink-2">
        {adding.prompt}
      </p>
      <div className="text-[0.75rem] text-ink-3">{working}</div>
      {onShowChat ? (
        <button
          type="button"
          onClick={onShowChat}
          className="inline-flex h-8 items-center gap-1.5 self-start rounded-full px-2.5 text-[0.75rem] text-ink-2 hover:bg-accent"
        >
          <MessageCircle className="size-3.5" /> {t("addStep.showChat")}
        </button>
      ) : null}
    </div>
  );
}

/** What the step panel can ask of the conversation; absent where nothing is built. */
export interface StepAssistant {
  /** The step being added, while the assistant builds it. */
  adding: Adding | null;
  /** False when the conversation took nothing: it is still busy with an earlier turn. */
  add: (adding: Adding) => boolean;
  /** Sends a request to the conversation as the admin's own message. */
  ask: (text: string) => boolean;
  /** What the running turn does, for how long. */
  working: ReactNode;
  showChat: () => void;
}

/** An id no step or field of the wizard has yet: `base`, else `base2`, `base3` … */
export function uniqueId(def: WizardDefinition, base: string): string {
  const taken = new Set([
    ...def.steps.map((s) => s.id),
    ...def.steps.flatMap((s) => (s.type === "page" ? s.fields.map((f) => f.id) : [])),
  ]);
  let i = 1;
  let id = base;
  while (taken.has(id)) {
    i += 1;
    id = `${base}${i}`;
  }
  return id;
}

const NEW_STEP: Record<EmptyKind, (id: string) => Step> = {
  page: (id) => ({
    id,
    type: "page",
    title: t("step.new.page"),
    fields: [{ id: `${id}Text`, label: t("step.new.question"), kind: "text" }],
  }),
  agent: (id) => ({
    id,
    type: "agent",
    title: t("step.new.agent"),
    instructions: t("step.new.agentTask"),
    tools: [],
    output: { format: "markdown" },
  }),
  generate: (id) => ({
    id,
    type: "generate",
    title: t("step.new.image"),
    asset: "image",
    prompt: t("step.new.imagePrompt"),
  }),
  widget: (id) => ({
    id,
    type: "widget",
    title: "Widget",
    entry: `${id}/index.html`,
    data: {},
    sample: `${id}/sample.json`,
  }),
};

/** The wizard with an empty step of `kind` before the step at `at`, and the new step's id. */
export function withEmptyStep(
  def: WizardDefinition,
  at: number,
  kind: EmptyKind,
): { def: WizardDefinition; id: string } {
  const id = uniqueId(
    def,
    kind === "page" ? "page" : kind === "agent" ? "ai" : kind === "widget" ? "widget" : "generate",
  );
  const steps = [...def.steps];
  steps.splice(at, 0, NEW_STEP[kind](id));
  return { def: { ...def, steps }, id };
}
