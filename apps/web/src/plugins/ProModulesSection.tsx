import { LOCALES } from "@engenty-wizards/shared/definition";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { openExternal } from "../studio/LocalRuntime";
import { Section } from "../studio/project/Section";
import { Button, Chip, Spinner } from "../ui";
import { useStudioPlugins } from "./host";

type HeldBack = "managed" | "not_installed" | "release" | "unconfirmed" | "plan";

interface ProModule {
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

interface ProState {
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

const HELD: Record<HeldBack, Key> = {
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
 * The closed modules the linked account's plan includes, for this install: installed from the
 * account, checked against engenty's signature, and on only while the plan has them.
 */
export function ProModulesSection() {
  const qc = useQueryClient();
  // Only where the runtime runs alone, for an admin: a runtime of many tenants has its own.
  const { canReload } = useStudioPlugins();
  const state = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ProState>(BASE),
    enabled: canReload,
  });
  const done = (next: ProState) => qc.setQueryData(KEY, next);
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
  const data = state.data;
  const busy = install.isPending || remove.isPending;
  const failure = (install.error ?? remove.error ?? refresh.error) as Error | null;
  if (!canReload) {
    return null;
  }

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
        <div className="flex flex-col gap-4">
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
          {data.modules.length ? (
            <ul className="divide-y divide-border-soft">
              {data.modules.map((m) => (
                <li key={m.id} className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-medium text-[0.9375rem]">{m.name}</span>
                      <span className="font-mono text-[0.75rem] text-ink-4">
                        {m.id} · {m.installed?.version ?? m.version}
                      </span>
                      {m.loaded ? <Chip tone="live">{t("pro.on")}</Chip> : null}
                      {!m.included ? <Chip>{t("pro.notInPlan")}</Chip> : null}
                      {m.installed && m.heldBack && m.included ? (
                        <Chip tone="warn">{t(HELD[m.heldBack])}</Chip>
                      ) : null}
                    </div>
                    {m.description ? (
                      <p className="mt-0.5 text-[0.875rem] text-ink-3">{m.description}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {m.included && (!m.installed || m.update) ? (
                      <Button
                        busy={install.isPending && install.variables === m.id}
                        disabled={busy}
                        onClick={() => install.mutate(m.id)}
                      >
                        {m.installed ? t("pro.update") : t("pro.install")}
                      </Button>
                    ) : null}
                    {m.installed ? (
                      <Button
                        variant="secondary"
                        busy={remove.isPending && remove.variables === m.id}
                        disabled={busy}
                        onClick={() => remove.mutate(m.id)}
                      >
                        {t("pro.remove")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.875rem] text-ink-3">{t("pro.none", { runtime: data.runtime })}</p>
          )}
          {failure ? <p className="text-[0.8125rem] text-rose">{failure.message}</p> : null}
        </div>
      )}
    </Section>
  );
}
