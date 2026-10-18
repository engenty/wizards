import { ConnectionField, FORMAT_LABEL } from "@engenty-wizards/runner";
import type { Format } from "@engenty-wizards/shared/definition";
import type { RunView } from "@engenty-wizards/shared/run";
import type {
  ShareChoice,
  ShareField,
  ShareItem,
  ShareJobView,
  ShareTargetView,
} from "@engenty-wizards/shared/sharing";
import { ArrowRight, Bot, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { Button, cn, Input, Label, Select, Textarea } from "../ui";

/** The steps a target takes, as the person sees them: reached, now, ahead. */
export function Steps({ steps, now }: { steps: string[]; now: number }) {
  return (
    <ol className="mb-6 flex gap-2">
      {steps.map((label, i) => (
        <li key={label} className="min-w-0 flex-1" aria-current={i === now ? "step" : undefined}>
          <div
            className={cn(
              "h-1 rounded-full",
              i < now ? "bg-moss" : i === now ? "bg-ember" : "bg-paper-3",
            )}
          />
          <div
            className={cn(
              "mt-1.5 truncate font-medium text-[0.75rem]",
              i < now ? "text-moss" : i === now ? "text-ember-strong" : "text-ink-4",
            )}
          >
            {i + 1} · {label}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface Deliverable {
  from: string;
  label: string;
  formats: Format[];
}

/** What the result offers as files: its deliverables, each in its formats. */
function deliverablesOf(view: RunView): Deliverable[] {
  return [
    ...view.shown
      .filter((x) => x.output && x.formats.length)
      .map((x) => ({ from: x.step.id, label: x.label ?? x.step.title, formats: x.formats })),
    ...view.lists
      .filter((l) => l.formats.length)
      .map((l) => ({
        from: `lists.${l.def.id}`,
        label: l.label ?? l.def.title,
        formats: l.formats,
      })),
  ];
}

/** The picked format per deliverable; null = not sent. */
export type Picked = Record<string, Format | null>;

/** What the person filled in for one target: kept while the sheet is open, so a second try starts from it. */
export interface ShareDraft {
  values: Record<string, string>;
  picked: Picked;
}

export function FilePicker({
  deliverables,
  picked,
  onPick,
  error,
}: {
  deliverables: Deliverable[];
  picked: Picked;
  onPick: (from: string, format: Format | null) => void;
  error?: string;
}) {
  return (
    <div>
      <Label>{t("shareRun.files")}</Label>
      <ul className="overflow-hidden rounded-lg ring-1 ring-input">
        {deliverables.map((d) => {
          const on = Boolean(picked[d.from]);
          return (
            <li
              key={d.from}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-border-soft border-b bg-card px-3 py-2.5 last:border-0"
            >
              <label className="flex min-w-0 flex-1 basis-40 cursor-pointer items-center gap-2.5 text-[0.875rem] coarse:min-h-11">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => onPick(d.from, e.target.checked ? d.formats[0] : null)}
                  className="size-4 shrink-0 accent-[var(--ember)] coarse:size-5"
                />
                <span className={cn("truncate", !on && "text-ink-3")}>{d.label}</span>
              </label>
              {on ? (
                <div className="flex flex-wrap gap-1.5">
                  {d.formats.map((f) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={picked[d.from] === f}
                      onClick={() => onPick(d.from, f)}
                      className={cn(
                        "h-7 rounded-full px-2.5 font-medium text-[0.75rem] ring-1 transition coarse:h-9 coarse:px-3",
                        picked[d.from] === f
                          ? "bg-ember-tint text-ink ring-ember"
                          : "bg-card text-ink-3 ring-input hover:text-ink",
                      )}
                    >
                      {FORMAT_LABEL[f]}
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p className="mt-1.5 text-[0.8125rem] text-rose">{error}</p> : null}
    </div>
  );
}

export function FieldInput({
  field,
  value,
  choices,
  error,
  onChange,
}: {
  field: ShareField;
  value: string;
  /** For a field whose choices come from the account: loaded, failed (null), or not yet there. */
  choices: ShareChoice[] | null | undefined;
  error?: string;
  onChange: (value: string) => void;
}) {
  const options = field.fromAccount ? choices : field.options;
  return (
    <div>
      <Label required={field.required} hint={field.help}>
        {field.label}
      </Label>
      {field.kind === "textarea" ? (
        <Textarea
          minRows={3}
          maxRows={12}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.kind === "select" && options?.length ? (
        <Select value={value} onChange={onChange} options={options} placeholder="" />
      ) : (
        <Input
          type={field.kind === "url" ? "url" : "text"}
          inputMode={field.kind === "emails" ? "email" : undefined}
          autoCapitalize={field.kind === "text" ? undefined : "off"}
          autoComplete="off"
          spellCheck={field.kind === "text"}
          value={value}
          disabled={field.fromAccount && choices === undefined}
          placeholder={
            field.fromAccount && choices === undefined ? t("common.loading") : field.placeholder
          }
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.fromAccount && choices === null ? (
        <p className="mt-1.5 text-[0.8125rem] text-ink-3">{t("shareRun.choicesFailed")}</p>
      ) : null}
      {error ? <p className="mt-1.5 text-[0.8125rem] text-rose">{error}</p> : null}
    </div>
  );
}

/**
 * One target, step by step: connect the account it sends with (where it needs one), say what
 * goes and where, send. The third step is the job itself, shown by the sheet.
 */
export function ShareTargetFlow({
  view,
  target,
  draft,
  onStarted,
}: {
  view: RunView;
  target: ShareTargetView;
  draft?: ShareDraft;
  onStarted: (job: ShareJobView, draft: ShareDraft) => void;
}) {
  const runId = view.id;
  const needsAccount = Boolean(target.connection);
  const connected = !target.connection || Boolean(target.connection.account);
  // The form opens once the account is there; the person can go back to change the account.
  const [atAccount, setAtAccount] = useState(!connected);
  useEffect(() => {
    if (!connected) {
      setAtAccount(true);
    }
  }, [connected]);

  const deliverables = useMemo(() => deliverablesOf(view), [view]);
  const [picked, setPicked] = useState<Picked>(
    () => draft?.picked ?? Object.fromEntries(deliverables.map((d) => [d.from, d.formats[0]])),
  );
  const [values, setValues] = useState<Record<string, string>>(
    () => draft?.values ?? Object.fromEntries(target.fields.map((f) => [f.id, f.value ?? ""])),
  );
  const [choices, setChoices] = useState<Record<string, ShareChoice[] | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Channels, folders: what the connected account offers, read once it is connected.
  const fromAccount = target.fields.filter((f) => f.fromAccount).map((f) => f.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the field ids of one target never change
  useEffect(() => {
    if (!connected) {
      return;
    }
    let alive = true;
    for (const id of fromAccount) {
      api
        .get<{ choices: ShareChoice[] }>(
          `/api/runs/${runId}/share/targets/${encodeURIComponent(target.key)}/choices/${id}?lang=${lang}`,
        )
        .then(
          (res) =>
            alive && setChoices((c) => ({ ...c, [id]: res.choices.length ? res.choices : null })),
          () => alive && setChoices((c) => ({ ...c, [id]: null })),
        );
    }
    return () => {
      alive = false;
    };
  }, [connected, runId, target.key]);

  const steps = [
    ...(needsAccount ? [t("shareRun.stepAccount")] : []),
    t("shareRun.stepForm"),
    t("shareRun.stepSend"),
  ];

  const send = async () => {
    setBusy(true);
    setErrors({});
    setFailure(null);
    const items: ShareItem[] =
      target.takes === "files"
        ? deliverables.flatMap((d) =>
            picked[d.from] ? [{ from: d.from, format: picked[d.from] as Format }] : [],
          )
        : [];
    try {
      onStarted(
        await api.post<ShareJobView>(`/api/runs/${runId}/share/jobs`, {
          target: target.key,
          items,
          values,
          lang,
        }),
        { values, picked },
      );
    } catch (err) {
      const fields = err instanceof ApiError && err.status === 422 ? err.body?.fields : null;
      if (fields) {
        setErrors(fields);
        if (fields._account) {
          setAtAccount(true);
        }
      } else {
        setFailure((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (needsAccount && atAccount) {
    return (
      <div className="animate-rise">
        <Steps steps={steps} now={0} />
        <p className="mb-4 text-[0.875rem] text-ink-2 leading-relaxed">
          {t("shareRun.accountHint")}
        </p>
        <ConnectionField runId={runId} connection={target.connection ?? undefined} />
        {errors._account ? (
          <p className="mt-2 text-[0.8125rem] text-rose">{errors._account}</p>
        ) : null}
        <div className="mt-6 flex justify-end">
          <Button disabled={!connected} onClick={() => setAtAccount(false)}>
            {t("run.next")} <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="animate-rise"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Steps steps={steps} now={needsAccount ? 1 : 0} />
      <div className="flex flex-col gap-5">
        {needsAccount && target.connection?.account ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-paper-2 px-3 py-2 text-[0.8125rem]">
            <span className="min-w-0 truncate text-ink-2">
              {t("shareRun.as", { account: target.connection.account.label })}
            </span>
            <button
              type="button"
              onClick={() => setAtAccount(true)}
              className="shrink-0 text-ink-3 hover:text-ink coarse:min-h-11"
            >
              {t("shareRun.changeAccount")}
            </button>
          </div>
        ) : null}
        {target.agent ? (
          <p className="flex items-start gap-2.5 rounded-lg bg-ember-tint px-3 py-2.5 text-[0.8125rem] text-ink-2 leading-relaxed">
            <Bot className="mt-0.5 size-4 shrink-0 text-ember-strong" /> {t("shareRun.agentHint")}
          </p>
        ) : null}
        {target.presets.length ? (
          <div className="flex flex-wrap gap-2">
            {target.presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setValues((v) => ({ ...v, ...preset.values }))}
                className="h-9 rounded-full bg-card px-3.5 font-medium text-[0.8125rem] text-ink-2 ring-1 ring-input transition hover:text-ink hover:ring-ember coarse:h-11"
              >
                {preset.label}
              </button>
            ))}
          </div>
        ) : null}
        {target.fields.map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            value={values[field.id] ?? ""}
            choices={choices[field.id]}
            error={errors[field.id]}
            onChange={(value) => setValues((v) => ({ ...v, [field.id]: value }))}
          />
        ))}
        {target.takes === "files" && deliverables.length ? (
          <FilePicker
            deliverables={deliverables}
            picked={picked}
            error={errors._files}
            onPick={(from, format) => setPicked((p) => ({ ...p, [from]: format }))}
          />
        ) : null}
        {failure ? (
          <p className="rounded-lg bg-rose-tint px-3 py-2 text-[0.875rem] text-rose">{failure}</p>
        ) : null}
      </div>
      <div className="action-bar mt-6 flex justify-end">
        <Button type="submit" busy={busy}>
          <Send className="size-4" /> {t(target.agent ? "shareRun.start" : "shareRun.send")}
        </Button>
      </div>
    </form>
  );
}
