import type { KernelRow, KernelRows, KernelScore } from "@engenty/wizards-shared/run";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { type Key, lang, t } from "../../lib/i18n";
import { Button, Chip, cn, Textarea } from "../../ui";
import { askConfirm } from "../../ui/confirm";

const KINDS = ["form", "agent", "tool", "code", "generate", "review", "wait"];
const CODE =
  "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-paper px-3 py-2 font-mono text-[0.6875rem] text-ink-2 ring-1 ring-border-soft";

const shown = (value: unknown) =>
  value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** An eval's own name: without the step, or `end`, it judges. */
const nameOf = (score: KernelScore) => score.eval.slice(score.eval.indexOf("/") + 1);

const number = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });

function ScoreChip({ score }: { score: KernelScore }) {
  return (
    <Chip tone={score.error ? "ember" : "neutral"} title={score.why ?? score.error}>
      {nameOf(score)}{" "}
      <span className="tabular-nums">
        {score.score == null ? t("rows.notScored") : number.format(score.score)}
      </span>
    </Chip>
  );
}

/** What each score says of the row, where it says something. */
function Whys({ scores }: { scores: KernelScore[] }) {
  const said = scores.filter((score) => score.why || score.error);
  return said.length ? (
    <ul className="flex flex-col gap-1 text-[0.75rem] text-ink-2">
      {said.map((score) => (
        <li key={score.eval} className={cn(score.error && "text-rose")}>
          <span className="font-medium">{nameOf(score)}:</span> {score.why ?? score.error}
        </li>
      ))}
    </ul>
  ) : null;
}

/**
 * The rows of a run of a wizard in version 0.3.0 (docs/plans/kernel.md): each ask with its answer,
 * each step that returned with the way it went, and the scores beside the step they judged. A row
 * can be asked again, and one a person answered can be answered differently: the run goes back to
 * it and on from there, and the later rows are dropped.
 */
export function RunRows({
  runId,
  wizardId,
  roles,
  canAct,
  onChanged,
}: {
  runId: string;
  wizardId: string;
  /** Whose answers come from a person. */
  roles: string[];
  canAct: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["run-rows", runId],
    queryFn: () => api.get<KernelRows>(`/api/runs/${runId}/rows`),
    refetchInterval: 5000,
  });
  const back = useMutation({
    mutationFn: ({ n, value }: { n: number; value?: unknown }) =>
      api.post(`/api/runs/${runId}/rows/${n}`, { back: true, value }),
    onSuccess: () => {
      setDraft(null);
      setOpen(null);
    },
    onSettled: () => {
      void query.refetch();
      void queryClient.invalidateQueries({ queryKey: ["runs", wizardId] });
      onChanged();
    },
  });
  const view = query.data;
  if (!view) {
    return null;
  }
  const { rows, scores, titles = {} } = view;
  const titleOf = (step: string) =>
    step === "input"
      ? t("kernel.input")
      : step === "end"
        ? t("type.result")
        : (titles[step]?.title ?? step);
  const kindOf = (row: KernelRow) =>
    row.approves != null
      ? t("rows.leave", { n: row.approves })
      : row.type && KINDS.includes(row.type)
        ? t(`type.${row.type}` as "type.form")
        : (row.type ?? "");
  const toggle = (n: number) => {
    setOpen(open === n ? null : n);
    setDraft(null);
    setWrong(false);
    back.reset();
  };
  const again = async (row: KernelRow) => {
    const yes = await askConfirm(t("rows.againAsk", { n: row.n }), {
      detail: t("rows.backDetail"),
      action: t("rows.again"),
    });
    if (yes) {
      back.mutate({ n: row.n });
    }
  };
  const send = (row: KernelRow) => {
    try {
      back.mutate({ n: row.n, value: JSON.parse(draft ?? "") });
    } catch {
      setWrong(true);
    }
  };
  const atEnd = scores.filter((score) => score.eval.startsWith("end/"));
  return (
    <div className="mt-1">
      <div className="flex h-10 items-center gap-2 pr-1.5 pl-3">
        <span className="font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.07em]">
          {t("rows.title")}
        </span>
        <span className="text-[0.75rem] text-ink-4 tabular-nums">{rows.length}</span>
      </div>
      {rows.length ? null : (
        <p className="px-3 pb-2 text-[0.8125rem] text-ink-3">{t("rows.empty")}</p>
      )}
      <ol className="px-3 text-[0.75rem]">
        {rows.map((row) => {
          const judged = scores.filter(
            (score) => score.row === row.n && !score.eval.startsWith("end/"),
          );
          const own = row.left ? judged : [];
          const isOpen = open === row.n;
          const Caret = isOpen ? ChevronDown : ChevronRight;
          const state: Key | null =
            row.state === "waiting"
              ? "runs.status.waiting_input"
              : row.state === "failed"
                ? "runs.status.failed"
                : null;
          // What an agent did in its turn belongs to the ask above it and goes back with that one.
          const turns = !row.left && row.parent == null && row.state !== "waiting";
          const differently =
            turns && (row.type === "wait" || (row.role != null && roles.includes(row.role)));
          return (
            <li key={row.n} className="border-border-soft/60 border-t">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggle(row.n)}
                className={cn(
                  "grid w-full grid-cols-[1.75rem_1rem_minmax(0,1fr)] items-start gap-x-2 py-1.5 text-left hover:bg-accent",
                  row.parent != null && "pl-4",
                )}
              >
                <span className="text-ink-4 tabular-nums leading-5">{row.n}</span>
                <Caret className="mt-1 size-3.5 text-ink-4" />
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 leading-5">
                  <span className="font-medium text-ink">{titleOf(row.step)}</span>
                  {row.left ? (
                    <span className="inline-flex items-center gap-1 text-ink-2">
                      <ArrowRight className="size-3.5 text-ink-4" aria-label={t("rows.left")} />
                      {titleOf(row.to ?? "end")}
                    </span>
                  ) : (
                    <span className="text-ink-2">
                      {[kindOf(row), row.role, row.by ? t("rows.by", { name: row.by }) : ""]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                  {state ? (
                    <Chip tone={row.state === "failed" ? "ember" : "neutral"}>{t(state)}</Chip>
                  ) : null}
                  {own.map((score) => (
                    <ScoreChip key={score.eval} score={score} />
                  ))}
                </span>
              </button>
              {isOpen ? (
                <div className="flex flex-col gap-2 pb-3 pl-[3.75rem]">
                  {row.error ? <p className="text-rose">{row.error}</p> : null}
                  {shown(row.left ? row.value : row.answer) ? (
                    <pre className={CODE}>{shown(row.left ? row.value : row.answer)}</pre>
                  ) : null}
                  <Whys scores={own} />
                  {canAct && turns ? (
                    draft == null ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={back.isPending}
                          onClick={() => void again(row)}
                        >
                          {t("rows.again")}
                        </Button>
                        {differently ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={back.isPending}
                            onClick={() => setDraft(JSON.stringify(row.answer ?? {}, null, 2))}
                          >
                            {t("rows.differently")}
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <p className="text-ink-3">{t("rows.differentlyHint")}</p>
                        <Textarea
                          className="font-mono text-[0.75rem]"
                          aria-label={t("rows.differently")}
                          value={draft}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            setWrong(false);
                          }}
                        />
                        {wrong ? <p className="text-rose">{t("rows.notJson")}</p> : null}
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" disabled={back.isPending} onClick={() => send(row)}>
                            {t("rows.send")}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                            {t("confirm.cancel")}
                          </Button>
                        </div>
                      </div>
                    )
                  ) : null}
                  {back.error ? <p className="text-rose">{back.error.message}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
        {atEnd.length ? (
          <li className="border-border-soft/60 border-t py-1.5 pl-[3.75rem]">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 leading-5">
              <span className="font-medium text-ink">{t("rows.end")}</span>
              {atEnd.map((score) => (
                <ScoreChip key={score.eval} score={score} />
              ))}
            </div>
            <div className="pt-1">
              <Whys scores={atEnd} />
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}
