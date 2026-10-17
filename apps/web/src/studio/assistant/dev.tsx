import type { AssistantPrompt, AssistantStep } from "@engenty-wizards/shared/assistant";
import { Check, Copy, Download } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { cn, Dialog, IconButton, Tabs } from "../../ui";
import { useDismiss } from "../AppFrame";
import type { ChatMessage, ChatToolCall } from "../editor/ChatPanel";
import type { DevTurn } from "./chat";

/**
 * Goose's developer mode: each answer's steps (model, tokens, time, cost), the tools' arguments and
 * results, the context window in the head, and the turns of the chat – timeline, prompt, events –
 * to look at, copy and download. The events are recorded in the browser while it is on.
 */

const short = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const money = (usd: number) => (usd ? `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}` : "$0");
/** About a token per four characters. */
const estimate = (chars: number) => Math.round(chars / 4);

const tokensLine = (input: number, output: number) =>
  t("assistant.tokens", {
    input: short(input),
    output: short(output),
    total: short(input + output),
  });

/** One line per step under an answer; opened, the tools it called. */
export function StepLines({ steps }: { steps?: AssistantStep[] }) {
  if (!steps?.length) {
    return null;
  }
  return (
    <div className="mt-1.5 flex flex-col gap-0.5">
      {steps.map((s) => (
        <details key={s.step} className="group text-[0.75rem] text-ink-4">
          <summary className="cursor-pointer list-none truncate hover:text-ink-3">
            {[
              t("assistant.step", { n: s.step }),
              s.model,
              tokensLine(s.inputTokens, s.outputTokens),
              seconds(s.ms),
              s.costUsd ? money(s.costUsd) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </summary>
          <div className="mt-1 rounded-lg bg-paper-2 px-3 py-2 font-mono text-[0.6875rem] text-ink-3">
            {t("assistant.stepTools")}: {s.tools.length ? s.tools.join(", ") : "–"}
            {s.cachedInputTokens ? ` · cache ${short(s.cachedInputTokens)}` : ""}
          </div>
        </details>
      ))}
    </div>
  );
}

function pretty(text: unknown): string {
  if (typeof text !== "string") {
    return JSON.stringify(text, null, 2) ?? "";
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The tools an answer called, each opened to its arguments and its result. */
export function ToolDetails({ calls }: { calls?: ChatToolCall[] }) {
  if (!calls?.length) {
    return null;
  }
  return (
    <div className="mb-1.5 flex flex-col gap-1">
      {calls.map((c) => (
        <details key={c.toolCallId} className="rounded-lg bg-paper-2 text-[0.75rem]">
          <summary className="cursor-pointer px-2.5 py-1 font-mono text-ink-3 hover:text-ink">
            {c.toolCallName}
            {c.result === undefined ? " …" : ""}
          </summary>
          <div className="flex flex-col gap-1 px-2.5 pb-2">
            <span className="text-ink-4">{t("assistant.args")}</span>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[0.6875rem] text-ink-2">
              {pretty(c.args)}
            </pre>
            {c.result === undefined ? null : (
              <>
                <span className="text-ink-4">{t("assistant.result")}</span>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[0.6875rem] text-ink-2">
                  {pretty(c.result)}
                </pre>
              </>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

/** The thread's steps as turns: a turn starts with a question that is not written in between. */
function usage(messages: ChatMessage[]) {
  const turns: AssistantStep[][] = [];
  for (const m of messages) {
    if (m.role === "user" && !m.signal) {
      turns.push([]);
    } else if (m.steps?.length) {
      if (!turns.length) {
        turns.push([]);
      }
      turns[turns.length - 1].push(...m.steps);
    }
  }
  const sum = (steps: AssistantStep[]) => ({
    input: steps.reduce((n, s) => n + s.inputTokens, 0),
    output: steps.reduce((n, s) => n + s.outputTokens, 0),
    ms: steps.reduce((n, s) => n + s.ms, 0),
    cost: steps.reduce((n, s) => n + s.costUsd, 0),
    steps: steps.length,
  });
  const all = turns.flat();
  const lastStep = all.at(-1);
  const last = [...turns].reverse().find((steps) => steps.length) ?? [];
  return {
    last: sum(last),
    thread: sum(all),
    lastStep,
    /** What the last step sent: how full the context window is. */
    context: lastStep?.inputTokens ?? 0,
    window: lastStep?.window ?? null,
  };
}

function Ring({ ratio }: { ratio: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 18 18" className="size-[18px] -rotate-90" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-paper-3" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeDasharray={`${Math.min(1, ratio) * c} ${c}`}
        strokeLinecap="round"
        className={ratio > 0.8 ? "stroke-rose" : "stroke-ember"}
      />
    </svg>
  );
}

/**
 * In the head: the last question's tokens and the chat's – `narrow`, only the ring; opened, the
 * context window and sums.
 */
export function UsageMeter({ messages, narrow }: { messages: ChatMessage[]; narrow?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const u = usage(messages);
  if (!u.lastStep) {
    return null;
  }
  const ratio = u.window ? u.context / u.window : 0;
  const row = (label: string, value: string) => (
    <div className="flex justify-between gap-4">
      <span className="text-ink-3">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        title={t("assistant.usage")}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-1.5 rounded-lg px-1.5 font-mono text-[0.75rem] text-ink-3 tabular-nums transition hover:bg-accent hover:text-ink"
      >
        {narrow ? null : (
          <span className="whitespace-nowrap max-sm:hidden">
            {short(u.last.input + u.last.output)} / {short(u.thread.input + u.thread.output)}
          </span>
        )}
        <Ring ratio={ratio} />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("assistant.window")}
          className="absolute top-9 right-0 z-50 flex w-72 animate-rise flex-col gap-1.5 rounded-xl bg-card p-3 text-[0.8125rem] shadow-overlay ring-1 ring-border-soft"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{t("assistant.window")}</span>
            <span className="font-mono text-[0.75rem] text-ink-3">
              {short(u.context)} /{" "}
              {u.window ? `${short(u.window)} (${Math.round(ratio * 100)}%)` : "?"}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-paper-2">
            <span
              className={cn("block h-full rounded-full", ratio > 0.8 ? "bg-rose" : "bg-ember")}
              style={{ width: `${Math.min(100, ratio * 100)}%` }}
            />
          </div>
          <span className="truncate text-[0.75rem] text-ink-4">{u.lastStep.model}</span>
          <span className="mt-1 font-medium text-[0.75rem] text-ink-3">
            {t("assistant.lastTurn")}
          </span>
          {row(t("assistant.promptTokens"), short(u.last.input))}
          {row(t("assistant.answerTokens"), short(u.last.output))}
          {row(t("assistant.duration"), seconds(u.last.ms))}
          {row(t("assistant.cost"), money(u.last.cost))}
          <span className="mt-1 font-medium text-[0.75rem] text-ink-3">
            {t("assistant.wholeChat")}
          </span>
          {row(t("assistant.promptTokens"), short(u.thread.input))}
          {row(t("assistant.answerTokens"), short(u.thread.output))}
          {row(t("assistant.steps"), String(u.thread.steps))}
          {row(t("assistant.cost"), money(u.thread.cost))}
        </div>
      ) : null}
    </div>
  );
}

/** The thread with the recorded turns, as JSON. */
export function threadJson(messages: ChatMessage[], turns: DevTurn[]): string {
  return JSON.stringify(
    {
      messages: messages.map(({ previews: _, ...m }) => m),
      turns,
    },
    null,
    2,
  );
}

export function CopyThread({ messages, turns }: { messages: ChatMessage[]; turns: DevTurn[] }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      label={copied ? t("assistant.copied") : t("assistant.copyThread")}
      onClick={() =>
        void navigator.clipboard.writeText(threadJson(messages, turns)).then(() => setCopied(true))
      }
      className="size-8"
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </IconButton>
  );
}

/** The prompt of a turn taken apart: instruction, the turn's own message, the chat, the tools. */
function PromptParts({ prompt }: { prompt: AssistantPrompt }) {
  const history = prompt.history.reduce((n, m) => n + m.chars, 0);
  const tools = prompt.tools.reduce((n, x) => n + x.chars, 0);
  const parts = [
    { label: t("assistant.system"), chars: prompt.system.length },
    { label: t("assistant.context"), chars: prompt.context.length },
    { label: t("assistant.history", { n: prompt.history.length }), chars: history },
    { label: t("assistant.tools", { n: prompt.tools.length }), chars: tools },
  ];
  const total = parts.reduce((n, p) => n + p.chars, 0) || 1;
  const block = (title: string, body: ReactNode) => (
    <details className="rounded-lg bg-paper-2">
      <summary className="cursor-pointer px-3 py-2 font-medium text-[0.8125rem]">{title}</summary>
      <div className="px-3 pb-3">{body}</div>
    </details>
  );
  return (
    <div className="flex flex-col gap-3 text-[0.8125rem]">
      <div className="flex justify-between text-ink-3">
        <span className="font-mono">{prompt.model}</span>
        <span>{t("assistant.estimate", { tokens: short(estimate(total)) })}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-paper-2">
        {parts.map((p, i) => (
          <span
            key={p.label}
            title={p.label}
            className={["bg-ember", "bg-ink-3", "bg-ember-strong", "bg-ink-4"][i]}
            style={{ width: `${(p.chars / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1">
        {parts.map((p) => (
          <li key={p.label} className="flex justify-between gap-4">
            <span>{p.label}</span>
            <span className="font-mono text-ink-3 tabular-nums">
              {short(estimate(p.chars))} · {Math.round((p.chars / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
      {block(
        t("assistant.system"),
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[0.6875rem] text-ink-2">
          {prompt.system}
        </pre>,
      )}
      {block(
        t("assistant.context"),
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[0.6875rem] text-ink-2">
          {prompt.context}
        </pre>,
      )}
      {block(
        t("assistant.tools", { n: prompt.tools.length }),
        <ul className="flex flex-col gap-0.5 font-mono text-[0.6875rem]">
          {prompt.tools.map((x) => (
            <li key={x.name} className="flex justify-between gap-4">
              <span>{x.name}</span>
              <span className="text-ink-3">{short(estimate(x.chars))}</span>
            </li>
          ))}
        </ul>,
      )}
    </div>
  );
}

/** When each step and tool of a turn ran, against the turn's length. */
function Timeline({ turn }: { turn: DevTurn }) {
  const end = turn.endedAt ?? turn.events.at(-1)?.at ?? turn.startedAt;
  const span = Math.max(1, end - turn.startedAt);
  const rows: { label: string; from: number; to: number; kind: "step" | "tool" }[] = [];
  const opened = new Map<string, { name: string; at: number }>();
  for (const e of turn.events) {
    const data = e.data as Record<string, any>;
    if (e.event === "tool_call") {
      opened.set(data.toolCallId, { name: data.toolCallName, at: e.at });
    } else if (e.event === "tool_result" && opened.has(data.toolCallId)) {
      const call = opened.get(data.toolCallId) as { name: string; at: number };
      rows.push({ label: call.name, from: call.at, to: e.at, kind: "tool" });
    } else if (e.event === "step") {
      rows.push({
        label: `${t("assistant.step", { n: data.step })} · ${tokensLine(data.inputTokens, data.outputTokens)}`,
        from: e.at - data.ms,
        to: e.at,
        kind: "step",
      });
    }
  }
  rows.sort((a, b) => a.from - b.from);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between gap-3 text-[0.8125rem]">
        <span className="min-w-0 truncate font-medium">{turn.message}</span>
        <span className="shrink-0 text-ink-3 tabular-nums">{seconds(span)}</span>
      </div>
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`} className="flex items-center gap-2 text-[0.75rem]">
          <span className="w-40 shrink-0 truncate font-mono text-ink-3">{r.label}</span>
          <span className="relative h-3 flex-1 rounded bg-paper-2">
            <span
              className={cn(
                "absolute inset-y-0 rounded",
                r.kind === "step" ? "bg-ember" : "bg-ink-4",
              )}
              style={{
                left: `${(Math.max(0, r.from - turn.startedAt) / span) * 100}%`,
                width: `${Math.max(1, ((r.to - r.from) / span) * 100)}%`,
              }}
            />
          </span>
          <span className="w-14 shrink-0 text-right text-ink-4 tabular-nums">
            {seconds(r.to - r.from)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The chat's turns as the developer mode recorded them. */
export function TurnsDialog({
  open,
  onClose,
  turns,
  messages,
}: {
  open: boolean;
  onClose: () => void;
  turns: DevTurn[];
  messages: ChatMessage[];
}) {
  const [tab, setTab] = useState<"timeline" | "prompt" | "events">("timeline");
  const last = turns.at(-1);
  const download = () => {
    const lines = turns.flatMap((turn) =>
      turn.events.map((e) => JSON.stringify({ turn: turn.id, ...e })),
    );
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `goose-${new Date().toISOString().slice(0, 19)}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <Dialog open={open} onClose={onClose} title={t("assistant.turns")} wide height="tall">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { id: "timeline", label: t("assistant.turnsTimeline") },
              { id: "prompt", label: t("assistant.turnsPrompt") },
              { id: "events", label: t("assistant.turnsEvents") },
            ]}
          />
          <div className="flex items-center gap-1">
            <CopyThread messages={messages} turns={turns} />
            <IconButton
              label={t("assistant.download")}
              onClick={download}
              disabled={!turns.length}
              className="size-8"
            >
              <Download className="size-4" />
            </IconButton>
          </div>
        </div>
        {!turns.length ? (
          <p className="text-[0.875rem] text-ink-3">{t("assistant.noTurns")}</p>
        ) : tab === "timeline" ? (
          <div className="flex flex-col gap-5">
            {turns.map((turn) => (
              <Timeline key={turn.id} turn={turn} />
            ))}
          </div>
        ) : tab === "prompt" ? (
          last?.prompt ? (
            <PromptParts prompt={last.prompt} />
          ) : (
            <p className="text-[0.875rem] text-ink-3">{t("assistant.noTurns")}</p>
          )
        ) : (
          <div className="flex flex-col gap-1 font-mono text-[0.6875rem]">
            {turns.flatMap((turn) =>
              turn.events.map((e, i) => (
                <details key={`${turn.id}-${i}`} className="rounded bg-paper-2">
                  <summary className="cursor-pointer px-2 py-1 text-ink-3">
                    <span className="tabular-nums">+{seconds(e.at - turn.startedAt)}</span>{" "}
                    <span className="text-ink">{e.event}</span>
                  </summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-2 pb-2 text-ink-2">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                </details>
              )),
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
