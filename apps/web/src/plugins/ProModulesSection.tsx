import { LOCALES } from "@engenty/wizards-shared/definition";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { openExternal } from "../studio/LocalRuntime";
import { Section } from "../studio/project/Section";
import { Button, Spinner } from "../ui";

export type HeldBack = "managed" | "not_installed" | "release" | "unconfirmed" | "plan";

/** A Pro plugin of the linked account's plan, as `/-/pro` says it (runtime plugins/pro.ts). */
export interface ProModule {
  id: string;
  name: string;
  version: string;
  description: string;
  size: number | null;
  included: boolean;
  installed: { version: string; runtime: string } | null;
  loaded: boolean;
  heldBack: HeldBack | null;
  update: boolean;
}

export interface ProState {
  linked: boolean;
  accountUrl: string;
  runtime: string;
  plan: { id: string; name: string } | null;
  expiresAt: string | null;
  checkedAt: string | null;
  error: string | null;
  modules: ProModule[];
}

const KEY = ["pro-modules"];
const BASE = "/api/studio/plugins/-/pro";

export const HELD: Record<HeldBack, Key> = {
  managed: "pro.held.plan",
  not_installed: "pro.held.release",
  release: "pro.held.release",
  unconfirmed: "pro.held.unconfirmed",
  plan: "pro.held.plan",
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(LOCALES[lang], {
    day: "numeric",
    month: "long",
  });

/**
 * The Pro plugins the linked account's plan includes, for this install: installed from the
 * account, checked against engenty's signature, and on only while the plan has them.
 */
export function usePro(enabled: boolean) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ProState>(BASE),
    enabled,
  });
  const done = (next: ProState) => {
    qc.setQueryData(KEY, next);
    return qc.invalidateQueries({ queryKey: ["plugins-all"] });
  };
  const refresh = useMutation({
    mutationFn: () => api.post<ProState>(`${BASE}/refresh`),
    onSuccess: done,
  });
  const install = useMutation({
    mutationFn: (id: string) => api.post<ProState>(`${BASE}/${id}`),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del<ProState>(`${BASE}/${id}`),
    onSuccess: done,
  });
  return { state, refresh, install, remove };
}

/** The plan behind the Pro plugins: which it is, until when it is confirmed, checking it again. */
export function ProPlanSection({ pro }: { pro: ReturnType<typeof usePro> }) {
  const { state, refresh } = pro;
  const data = state.data;
  return (
    <Section
      title={t("pro.title")}
      hint={t("pro.hint")}
      action={
        data?.linked ? (
          <Button variant="secondary" busy={refresh.isPending} onClick={() => refresh.mutate()}>
            {t("pro.check")}
          </Button>
        ) : null
      }
    >
      {state.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[0.8125rem] text-rose">
            {t("pro.failed", { error: (state.error as Error).message })}
          </p>
          <Button variant="secondary" onClick={() => void state.refetch()}>
            {t("pro.retry")}
          </Button>
        </div>
      ) : !data ? (
        <Spinner />
      ) : !data.linked ? (
        <p className="text-[0.875rem] text-ink-3">{t("pro.notLinked")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 text-[0.8125rem] text-ink-3">
            <span>
              {data.plan ? t("pro.plan", { plan: data.plan.name }) : null}
              {data.plan && data.expiresAt ? " · " : null}
              {data.expiresAt ? t("pro.confirmedUntil", { date: day(data.expiresAt) }) : null}
            </span>
            <Button variant="ghost" onClick={() => openExternal(`${data.accountUrl}/billing`)}>
              {t("pro.plans")} <ExternalLink className="size-4" />
            </Button>
          </div>
          {data.error ? <p className="text-[0.8125rem] text-rose">{data.error}</p> : null}
          {data.modules.length ? null : (
            <p className="text-[0.875rem] text-ink-3">{t("pro.none", { runtime: data.runtime })}</p>
          )}
          {refresh.error ? (
            <p className="text-[0.8125rem] text-rose">{(refresh.error as Error).message}</p>
          ) : null}
        </div>
      )}
    </Section>
  );
}
