import type { Field } from "@engenty/wizards-shared/definition";
import {
  describeStart,
  nextRunAt,
  type Schedule,
  START_KINDS,
  type StartKind,
  type WizardStart,
} from "@engenty/wizards-shared/starts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Link2, Play, Plus, Table2, Wand2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { api } from "../../lib/api";
import { type Key, lang, t } from "../../lib/i18n";
import type { WizardDetail } from "../../lib/session";
import { Button, cn, Input, Switch, TimePicker } from "../../ui";

/**
 * "Startet von selbst": what begins a run of this wizard without a person – a clock today, an
 * address, a row and another wizard later. A row per start in the share dialog; one sheet adds
 * or changes one. Plan: docs/plans/starts.md.
 */

const heading = "text-[0.8125rem] font-medium text-ink-3";

const ICONS: Record<StartKind, typeof Clock> = {
  schedule: Clock,
  webhook: Link2,
  record: Table2,
  wizard: Wand2,
};

const KIND_TITLE: Record<StartKind, Key> = {
  schedule: "starts.kind.schedule",
  webhook: "starts.kind.webhook",
  record: "starts.kind.record",
  wizard: "starts.kind.wizard",
};

const KIND_HINT: Record<StartKind, Key> = {
  schedule: "starts.kind.scheduleHint",
  webhook: "starts.kind.webhookHint",
  record: "starts.kind.recordHint",
  wizard: "starts.kind.wizardHint",
};

/** The kinds this studio can set up today; the others are shown, not offered. */
const OFFERED: StartKind[] = ["schedule"];

function useSaveStarts(wizard: WizardDetail) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (starts: WizardStart[]) =>
      api.put<WizardStart[]>(`/api/studio/wizards/${wizard.id}/starts`, starts),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["wizard", wizard.id] }),
        qc.invalidateQueries({ queryKey: ["wizards"] }),
      ]),
  });
}

const timeFmt = () => new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });

/** The rows in the share dialog's main view. */
export function StartsSection({
  wizard,
  onAdd,
  onEdit,
}: {
  wizard: WizardDetail;
  onAdd: () => void;
  onEdit: (start: WizardStart) => void;
}) {
  const id = useId();
  const save = useSaveStarts(wizard);
  const starts = save.variables ?? wizard.starts;
  const locked = wizard.readOnly;
  const toggle = (start: WizardStart, on: boolean) =>
    save.mutate(starts.map((s) => (s.id === start.id ? { ...s, on } : s)));
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id={id} className={heading}>
            {t("starts.title")}
          </h3>
          <p className="text-[0.8125rem] text-ink-3">{t("starts.hint")}</p>
        </div>
        {locked ? null : (
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <Plus className="size-4" /> {t("starts.add")}
          </Button>
        )}
      </div>
      {starts.length ? (
        <ul className="flex flex-col divide-y divide-border-soft">
          {starts.map((start) => {
            const Icon = ICONS[start.kind];
            const paused = Boolean(start.pausedReason) && !start.on;
            const next = start.on && start.schedule ? nextRunAt(start.schedule, new Date()) : null;
            return (
              <li key={start.id} className="flex items-center gap-3 py-2.5">
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    paused ? "bg-amber-tint text-amber" : "bg-paper-2 text-ink-2",
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => onEdit(start)}
                  className="min-w-0 flex-1 rounded-md text-left hover:bg-accent disabled:hover:bg-transparent"
                >
                  <div className={cn("text-[0.9375rem]", !start.on && "text-ink-2")}>
                    {describeStart(start, lang)}
                  </div>
                  <div className={cn("text-[0.8125rem]", paused ? "text-amber" : "text-ink-3")}>
                    {paused
                      ? t("starts.paused", { why: start.pausedReason ?? "" })
                      : next
                        ? t("starts.next", { when: timeFmt().format(next) })
                        : start.lastRunAt
                          ? t("starts.last", { when: timeFmt().format(new Date(start.lastRunAt)) })
                          : t("starts.off")}
                  </div>
                </button>
                <Switch
                  checked={start.on}
                  disabled={locked}
                  label={describeStart(start, lang)}
                  onChange={(on) => toggle(start, on)}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
      {save.error ? (
        <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </section>
  );
}

// --- the sheet -----------------------------------------------------------------------------

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

function weekdayName(day: number) {
  // Any week: the 4th of January 2026 was a Sunday.
  return new Intl.DateTimeFormat(lang, { weekday: "long" }).format(new Date(2026, 0, 4 + day));
}

const select =
  "h-9 rounded-lg border border-input bg-card px-2.5 text-[0.9375rem] text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** The fields of the first page a start can answer by typing a value once. */
const TYPED: Field["kind"][] = [
  "text",
  "textarea",
  "number",
  "date",
  "email",
  "url",
  "select",
  "toggle",
  "color",
];

function firstPageFields(wizard: WizardDetail): Field[] {
  const first = wizard.draft.steps[0];
  return first?.type === "page" ? first.fields : [];
}

function defaultSchedule(): Schedule {
  return {
    every: "week",
    weekday: 1,
    time: "08:00",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function newStart(): WizardStart {
  return {
    // A fresh id the server replaces with its own: the schema wants one.
    id: `new-${Math.random().toString(36).slice(2, 10)}`,
    kind: "schedule",
    on: true,
    schedule: defaultSchedule(),
    answers: {},
    allowChanges: false,
    passReviews: true,
    failures: 0,
  };
}

/** Adds a start, or changes one: the kind, the sentence, what it fills in, the switches. */
export function StartsView({
  wizard,
  editing,
  onDone,
  Body,
  Footer,
}: {
  wizard: WizardDetail;
  editing: WizardStart | null;
  onDone: () => void;
  Body: (p: { children: ReactNode; className?: string }) => ReactNode;
  Footer: (p: { children: ReactNode }) => ReactNode;
}) {
  const [kind, setKind] = useState<StartKind | null>(editing?.kind ?? null);
  const [start, setStart] = useState<WizardStart>(editing ?? newStart());
  const save = useSaveStarts(wizard);
  const [tried, setTried] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (startId: string) =>
      api.post<{ runId: string }>(`/api/studio/wizards/${wizard.id}/starts/${startId}/run`),
    onSuccess: () => setTried(t("starts.triedNote")),
  });
  const fields = firstPageFields(wizard);
  const writes = (wizard.draft.connections?.length ?? 0) > 0 || wizard.mcpServers.length > 0;
  const reviews = wizard.draft.steps.some((s) => s.type === "review");
  const schedule = start.schedule ?? defaultSchedule();
  const setSchedule = (patch: Partial<Schedule>) =>
    setStart({ ...start, schedule: { ...schedule, ...patch } });
  const setAnswer = (field: Field, value: unknown) => {
    const answers = { ...start.answers };
    if (value === "" || value === undefined) {
      delete answers[field.id];
    } else {
      answers[field.id] = value;
    }
    setStart({ ...start, answers });
  };
  const others = wizard.starts.filter((s) => s.id !== start.id);
  const commit = async () => {
    const saved = await save.mutateAsync([...others, start]);
    return saved.find((s) => !others.some((o) => o.id === s.id)) ?? saved[saved.length - 1];
  };
  const next = nextRunAt(schedule, new Date());

  if (!kind) {
    return (
      <>
        <Body className="flex flex-col gap-4">
          <p className="text-[0.9375rem]">
            {t("starts.whenQuestion", { title: wizard.draft.title })}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {START_KINDS.map((k) => {
              const Icon = ICONS[k];
              const offered = OFFERED.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  disabled={!offered}
                  onClick={() => {
                    setKind(k);
                    setStart({ ...start, kind: k });
                  }}
                  className={cn(
                    "flex min-h-32 flex-col gap-2 rounded-xl border border-border p-4 text-left transition",
                    offered ? "hover:border-cobalt hover:bg-cobalt-tint/40" : "opacity-60",
                  )}
                >
                  <span className="flex size-9 items-center justify-center rounded-lg bg-paper-2 text-ink">
                    <Icon className="size-[1.125rem]" />
                  </span>
                  <span className="font-medium text-[0.9375rem]">{t(KIND_TITLE[k])}</span>
                  <span className="text-[0.8125rem] text-ink-3 leading-snug">
                    {t(KIND_HINT[k])}
                    {offered ? "" : ` ${t("starts.soon")}`}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[0.8125rem] text-ink-3">{t("starts.orAssistant")}</p>
        </Body>
        <Footer>
          <span className="flex-1 max-sm:hidden" />
          <Button variant="ghost" onClick={onDone}>
            {t("share.back")}
          </Button>
        </Footer>
      </>
    );
  }

  return (
    <>
      <Body className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[0.9375rem]">
            <span>{t("starts.every")}</span>
            <select
              aria-label={t("starts.rhythm")}
              className={select}
              value={schedule.every}
              onChange={(e) => setSchedule({ every: e.target.value as Schedule["every"] })}
            >
              <option value="hour">{t("starts.every.hour")}</option>
              <option value="day">{t("starts.every.day")}</option>
              <option value="week">{t("starts.every.week")}</option>
              <option value="month">{t("starts.every.month")}</option>
            </select>
            {schedule.every === "week" ? (
              <>
                <span>{t("starts.on")}</span>
                <select
                  aria-label={t("starts.weekday")}
                  className={select}
                  value={schedule.weekday ?? 1}
                  onChange={(e) => setSchedule({ weekday: Number(e.target.value) })}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d} value={d}>
                      {weekdayName(d)}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            {schedule.every === "month" ? (
              <>
                <span>{t("starts.onThe")}</span>
                <select
                  aria-label={t("starts.dayOfMonth")}
                  className={select}
                  value={schedule.day ?? 1}
                  onChange={(e) => setSchedule({ day: Number(e.target.value) })}
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}.
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            {schedule.every === "hour" ? null : (
              <>
                <span>{t("starts.at")}</span>
                <TimePicker
                  value={schedule.time}
                  onChange={(time) => setSchedule({ time })}
                  step={15}
                  compact
                  label={t("starts.time")}
                />
              </>
            )}
          </div>
          <p className="text-[0.8125rem] text-ink-3">
            {t("starts.zone", { tz: schedule.tz })}
            {next ? ` · ${t("starts.next", { when: timeFmt().format(next) })}` : ""}
          </p>
        </div>

        {fields.length ? (
          <section className="flex flex-col gap-1">
            <h3 className={heading}>{t("starts.fills")}</h3>
            <p className="mb-1 text-[0.8125rem] text-ink-3">{t("starts.fillsHint")}</p>
            <ul className="divide-y divide-border-soft">
              {fields.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2">
                  <label htmlFor={`start-${f.id}`} className="min-w-0 flex-1 text-[0.9375rem]">
                    {f.label}
                    {f.required || /optional/i.test(f.label) ? null : (
                      <span className="text-ink-4"> · {t("starts.optional")}</span>
                    )}
                  </label>
                  {TYPED.includes(f.kind) ? (
                    <AnswerInput
                      id={`start-${f.id}`}
                      field={f}
                      value={start.answers[f.id]}
                      onChange={(v) => setAnswer(f, v)}
                    />
                  ) : (
                    <span className="rounded-full bg-paper-2 px-2.5 py-1 text-[0.8125rem] text-ink-3">
                      {t("starts.asked")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[0.8125rem] text-ink-3">{t("starts.missingHint")}</p>
          </section>
        ) : null}

        {writes || reviews ? (
          <section className="flex flex-col gap-4 rounded-xl bg-paper-2 px-4 py-3.5">
            {writes ? (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[0.9375rem]">{t("starts.allowChanges")}</div>
                  <div className="text-[0.8125rem] text-ink-3">{t("starts.allowChangesHint")}</div>
                </div>
                <Switch
                  checked={start.allowChanges}
                  label={t("starts.allowChanges")}
                  onChange={(allowChanges) => setStart({ ...start, allowChanges })}
                />
              </div>
            ) : null}
            {reviews ? (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[0.9375rem]">{t("starts.passReviews")}</div>
                  <div className="text-[0.8125rem] text-ink-3">{t("starts.passReviewsHint")}</div>
                </div>
                <Switch
                  checked={start.passReviews}
                  label={t("starts.passReviews")}
                  onChange={(passReviews) => setStart({ ...start, passReviews })}
                />
              </div>
            ) : null}
          </section>
        ) : null}

        {save.error || run.error ? (
          <p className="text-[0.8125rem] text-rose">
            {((save.error ?? run.error) as Error).message}
          </p>
        ) : null}
        {tried ? <p className="text-[0.8125rem] text-moss">{tried}</p> : null}
      </Body>
      <Footer>
        {editing ? (
          <Button
            variant="danger"
            busy={save.isPending}
            onClick={() => save.mutateAsync(others).then(onDone)}
          >
            {t("starts.remove")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          busy={run.isPending}
          disabled={!wizard.published}
          onClick={() => commit().then((saved) => run.mutate(saved.id))}
        >
          <Play className="size-4" /> {t("starts.tryNow")}
        </Button>
        <span className="flex-1 max-sm:hidden" />
        <Button
          className="max-sm:w-full"
          busy={save.isPending}
          onClick={() => commit().then(onDone)}
        >
          {t(editing ? "share.done" : "starts.addIt")}
        </Button>
      </Footer>
    </>
  );
}

function AnswerInput({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (field.kind === "select") {
    return (
      <select
        id={id}
        className={cn(select, "max-w-[12rem]")}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t("starts.leaveEmpty")}</option>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === "toggle") {
    return <Switch checked={value === true} label={field.label} onChange={(v) => onChange(v)} />;
  }
  return (
    <Input
      id={id}
      type={
        field.kind === "number"
          ? "number"
          : field.kind === "date"
            ? "date"
            : field.kind === "email"
              ? "email"
              : field.kind === "color"
                ? "color"
                : "text"
      }
      className="h-9 max-w-[12rem]"
      placeholder={t("starts.leaveEmpty")}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) =>
        onChange(
          field.kind === "number" && e.target.value !== ""
            ? Number(e.target.value)
            : e.target.value,
        )
      }
    />
  );
}
