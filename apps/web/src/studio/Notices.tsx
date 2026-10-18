import { describeStart, type WizardStart } from "@engenty/wizards-shared/starts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, CircleAlert, PauseCircle, UserRound } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { cn } from "../ui";
import { useDismiss } from "./AppFrame";

/**
 * The bell in the top bar: a word to the owner about runs nobody watches — a start's run waits
 * for them, is done, failed, or its start was paused. Read in place; "Open" goes to the wizard.
 */

interface Notice {
  id: string;
  kind: "needs_you" | "done" | "failed" | "paused";
  wizard: { id: string; title: string };
  runId: string | null;
  start: WizardStart | null;
  detail: string | null;
  read: boolean;
  at: string;
}

const ICONS = {
  needs_you: { Icon: UserRound, tone: "bg-amber-tint text-amber" },
  done: { Icon: Check, tone: "bg-moss-tint text-moss" },
  failed: { Icon: CircleAlert, tone: "bg-rose-tint text-rose" },
  paused: { Icon: PauseCircle, tone: "bg-rose-tint text-rose" },
} as const;

export function NoticesBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const notices = useQuery({
    queryKey: ["notices"],
    queryFn: () => api.get<Notice[]>("/api/studio/notices"),
    refetchInterval: 30_000,
  });
  const read = useMutation({
    mutationFn: (ids: string[] | "all") => api.post("/api/studio/notices/read", { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notices"] }),
  });
  const rows = notices.data ?? [];
  const unread = rows.filter((n) => !n.read).length;
  if (!rows.length) {
    return null;
  }
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" });
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={t("notices.title")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex size-8 items-center justify-center rounded-full text-ink-2 transition hover:bg-accent hover:text-ink",
          open && "bg-accent text-ink",
        )}
      >
        <Bell className="size-[1.125rem]" />
        {unread ? (
          <span className="absolute top-1 right-1 size-2 rounded-full bg-ember ring-2 ring-paper" />
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("notices.title")}
          className="absolute top-full right-0 z-20 mt-1.5 flex w-[min(24rem,calc(100vw-1.5rem))] origin-top-right animate-unfold flex-col overflow-hidden rounded-xl bg-card shadow-overlay ring-1 ring-border"
        >
          <div className="flex items-center justify-between px-3.5 pt-3 pb-2">
            <span className="font-medium text-[0.875rem]">{t("notices.title")}</span>
            {unread ? (
              <button
                type="button"
                onClick={() => read.mutate("all")}
                className="text-[0.8125rem] text-ink-3 hover:text-ink"
              >
                {t("notices.allRead")}
              </button>
            ) : null}
          </div>
          <ul className="flex max-h-[60vh] flex-col divide-y divide-border-soft overflow-y-auto">
            {rows.map((n) => {
              const { Icon, tone } = ICONS[n.kind];
              const line =
                n.kind === "paused"
                  ? t("notices.pausedHint")
                  : [n.start ? describeStart(n.start, lang) : null, n.detail]
                      .filter(Boolean)
                      .join(" · ");
              return (
                <li
                  key={n.id}
                  className={cn("flex items-start gap-3 px-3.5 py-3", !n.read && "bg-paper-2/60")}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
                      tone,
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[0.875rem]">
                      {t(`notices.${n.kind}`, { wizard: n.wizard.title })}
                    </div>
                    {line ? (
                      <div className="mt-0.5 text-[0.8125rem] text-ink-3 leading-snug">{line}</div>
                    ) : null}
                    <div className="mt-1.5 flex items-center gap-3 text-[0.8125rem]">
                      <Link
                        to={`/edit/${n.wizard.id}${n.runId ? `?run=${n.runId}` : ""}`}
                        onClick={() => {
                          setOpen(false);
                          if (!n.read) {
                            read.mutate([n.id]);
                          }
                        }}
                        className="font-medium text-cobalt hover:underline"
                      >
                        {t("notices.open")}
                      </Link>
                      <span className="text-ink-4">{fmt.format(new Date(n.at))}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
