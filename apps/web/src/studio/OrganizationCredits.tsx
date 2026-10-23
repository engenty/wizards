import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { CreditCard, FileText, Plus } from "lucide-react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import type { Me } from "../lib/session";
import { Button, Chip, IconButton, Spinner } from "../ui";
import { openExternal } from "./LocalRuntime";
import { Section } from "./project/Section";

/** The Manage-App's billing view, as the studio reads it through its runtime. */
interface Billing {
  balanceCredits: number;
  expiring: { kind: "start" | "monthly" | "gift"; credits: number; expiresAt: string }[];
  topUp: boolean;
  canBuy: boolean;
  plan: {
    id: string;
    name: string;
    price: { amount: number; currency: string };
    monthlyCredits: number;
    renewsAt: string | null;
    cancels: boolean;
    seats: { limit: number | null; taken: number };
  } | null;
  canChangePlan: boolean;
  usage: {
    daily: { day: string; credits: number }[];
    last30Credits: number;
    runs: number;
    byClass: { label: string; credits: number; calls: number }[];
  };
  invoices: {
    id: string;
    number: string | null;
    status: string;
    currency: string;
    totalCents: number;
    credits: number | null;
    issuedAt: string;
  }[];
}

interface Entry {
  id: number;
  at: string;
  kind: string;
  runId: string | null;
  calls: number;
  credits: number;
  classes: string[];
}

function useBilling(me: Me) {
  return useQuery({
    queryKey: ["organization-billing", me.tenant.id],
    queryFn: () => api.get<Billing>("/api/studio/organization/billing"),
  });
}

const number = (n: number) => new Intl.NumberFormat(lang).format(Math.round(n));
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat(lang, { style: "currency", currency: currency.toUpperCase() }).format(
    cents / 100,
  );
const day = (iso: string) =>
  new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(iso));

/** Buying still happens on the account pages, with their consent: the person goes there, in this tab. */
const buyAt = (me: Me) => () => window.location.assign(`${me.manageUrl}/billing`);

const KINDS: Record<string, Key> = {
  run: "credits.kind.run",
  model: "credits.kind.model",
  image: "credits.kind.image",
  video: "credits.kind.video",
  search: "credits.kind.search",
  usage: "credits.kind.usage",
  topup: "credits.kind.topup",
  start: "credits.kind.start",
  grant: "credits.kind.grant",
  expire: "credits.kind.expire",
  fee: "credits.kind.fee",
  adjust: "credits.kind.adjust",
  sms: "credits.kind.sms",
  call: "credits.kind.call",
};
/** Model classes keep their English names; other bookings say what they were. */
const labelOf = (label: string) =>
  KINDS[label] ? t(KINDS[label]) : label.charAt(0).toUpperCase() + label.slice(1);

function Bars({ daily, tall }: { daily: Billing["usage"]["daily"]; tall?: boolean }) {
  const max = Math.max(1, ...daily.map((d) => d.credits));
  return (
    <div>
      <div className={tall ? "flex h-20 items-end gap-[3px]" : "flex h-14 items-end gap-[3px]"}>
        {daily.map((d) => (
          <span
            key={d.day}
            title={t("credits.dayLine", { day: day(d.day), n: number(d.credits) })}
            className="flex-1 rounded-t-[2px] bg-accent"
            style={{ height: `${Math.max(3, (d.credits / max) * 100)}%` }}
          />
        ))}
      </div>
      {tall && daily.length ? (
        <div className="mt-1.5 flex justify-between text-[0.75rem] text-ink-4">
          <span>{day(daily[0].day)}</span>
          <span>{day(daily[daily.length - 1].day)}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Settings › Guthaben: the organization's balance and what of it ends on a date, the plan, and
 * the last 30 days. Topping up and changing the plan open the account pages, where buying is.
 */
export function OrganizationCredits({ me }: { me: Me }) {
  const billing = useBilling(me);
  const b = billing.data;
  if (!b) {
    return billing.isError ? (
      <p className="text-[0.875rem] text-rose">{t("credits.failed")}</p>
    ) : (
      <Spinner />
    );
  }
  const monthly = b.expiring.find((e) => e.kind === "monthly");
  const daysLeft =
    b.usage.last30Credits > 0 ? Math.floor(b.balanceCredits / (b.usage.last30Credits / 30)) : null;
  return (
    <div className="flex flex-col gap-9">
      <Section title={t("credits.title")} hint={t("credits.hint", { name: me.tenant.name ?? "" })}>
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-display font-semibold text-[2rem] tabular-nums leading-none">
              {number(b.balanceCredits)}
            </div>
            <div className="mt-2 text-[0.875rem] text-ink-3">
              {monthly
                ? t("credits.balanceMonthly", {
                    n: number(monthly.credits),
                    date: day(monthly.expiresAt),
                  })
                : t("credits.balance")}
            </div>
          </div>
          {b.canBuy && b.topUp ? (
            <Button onClick={buyAt(me)}>
              <Plus className="size-4" /> {t("credits.topUp")}
            </Button>
          ) : null}
        </div>
        {daysLeft !== null ? (
          <p className="mt-4 text-[0.8125rem] text-ink-3">
            {daysLeft > 60 ? t("credits.lastsLong") : t("credits.lasts", { n: daysLeft })}
          </p>
        ) : null}
        {!b.canBuy ? (
          <p className="mt-4 text-[0.8125rem] text-ink-3">{t("credits.onlyAdmins")}</p>
        ) : null}
      </Section>
      {b.plan ? (
        <Section title={t("credits.plan")}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-ink-2">
              <CreditCard className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-display font-semibold text-[1rem]">{b.plan.name}</span>
                {b.plan.cancels ? <Chip tone="warn">{t("credits.planEnds")}</Chip> : null}
              </div>
              <div className="text-[0.8125rem] text-ink-3">
                {[
                  b.plan.price.amount
                    ? t("credits.planPrice", {
                        price: money(b.plan.price.amount, b.plan.price.currency),
                      })
                    : t("credits.planFree"),
                  b.plan.monthlyCredits
                    ? t("credits.planMonthly", { n: number(b.plan.monthlyCredits) })
                    : null,
                  b.plan.seats.limit === null
                    ? t("credits.planSeatsUnlimited")
                    : t("credits.planSeats", { n: b.plan.seats.limit }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            {b.canChangePlan ? (
              <Button variant="secondary" onClick={buyAt(me)}>
                {t("credits.planChange")}
              </Button>
            ) : null}
          </div>
        </Section>
      ) : null}
      <Section title={t("credits.last30")}>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="font-medium text-[0.9375rem]">
            {t("credits.used", { n: number(b.usage.last30Credits) })}
          </span>
          <Link
            to="/settings/usage"
            className="text-[0.8125rem] text-ink-3 transition hover:text-ink"
          >
            {t("credits.seeUsage")} ›
          </Link>
        </div>
        <Bars daily={b.usage.daily} />
      </Section>
    </div>
  );
}

/** Settings › Verbrauch: 30 days, what the credits went to, and every booking. */
export function OrganizationUsage({ me }: { me: Me }) {
  const billing = useBilling(me);
  const entries = useInfiniteQuery({
    queryKey: ["organization-billing-activity", me.tenant.id],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get<{ entries: Entry[] }>(
        `/api/studio/organization/billing/activity?limit=20${pageParam ? `&before=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last) =>
      last.entries.length === 20 ? last.entries[last.entries.length - 1].id : undefined,
  });
  const b = billing.data;
  if (!b) {
    return billing.isError ? (
      <p className="text-[0.875rem] text-rose">{t("credits.failed")}</p>
    ) : (
      <Spinner />
    );
  }
  const total = b.usage.byClass.reduce((sum, r) => sum + r.credits, 0) || 1;
  const rows = entries.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <div className="flex flex-col gap-9">
      <Section
        title={t("credits.usage")}
        hint={t("credits.usageHint", { name: me.tenant.name ?? "" })}
      >
        <div className="mb-3 font-display font-semibold text-[1.5rem] tabular-nums">
          {t("credits.used", { n: number(b.usage.last30Credits) })}
        </div>
        <Bars daily={b.usage.daily} tall />
      </Section>
      <Section title={t("credits.whatFor")}>
        {b.usage.byClass.length ? (
          <div className="flex flex-col gap-2.5">
            {b.usage.byClass.map((r) => (
              <div
                key={r.label}
                className="grid grid-cols-[8rem_1fr_4.5rem] items-center gap-3 text-[0.875rem]"
              >
                <span className="truncate">{labelOf(r.label)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-paper-2">
                  <span
                    className="block h-full rounded-full bg-ember"
                    style={{ width: `${(r.credits / total) * 100}%` }}
                  />
                </span>
                <span className="text-right text-ink-2 tabular-nums">{number(r.credits)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[0.875rem] text-ink-3">{t("credits.nothingUsed")}</p>
        )}
      </Section>
      <Section title={t("credits.entries")}>
        {rows.length ? (
          <div className="flex flex-col divide-y divide-border-soft">
            {rows.map((e) => (
              <div key={e.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.9375rem]">
                    {e.kind === "run" ? t("credits.kind.run") : labelOf(e.kind)}
                    {e.kind === "run" && e.classes.length ? (
                      <span className="text-ink-4"> · {e.classes.map(labelOf).join(", ")}</span>
                    ) : null}
                  </div>
                  <div className="text-[0.8125rem] text-ink-3">
                    {new Intl.DateTimeFormat(lang, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(e.at))}
                  </div>
                </div>
                <span
                  className={e.credits > 0 ? "text-moss tabular-nums" : "text-ink-2 tabular-nums"}
                >
                  {e.credits > 0 ? "+" : "−"}
                  {number(Math.abs(e.credits))}
                </span>
              </div>
            ))}
          </div>
        ) : entries.isPending ? (
          <Spinner />
        ) : (
          <p className="text-[0.875rem] text-ink-3">{t("credits.noEntries")}</p>
        )}
        {entries.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            busy={entries.isFetchingNextPage}
            onClick={() => void entries.fetchNextPage()}
          >
            {t("credits.more")}
          </Button>
        ) : null}
      </Section>
    </div>
  );
}

/** Settings › Rechnungen: one row per payment, its PDF at Stripe (owners and admins). */
export function OrganizationInvoices({ me }: { me: Me }) {
  const billing = useBilling(me);
  const b = billing.data;
  if (!b) {
    return billing.isError ? (
      <p className="text-[0.875rem] text-rose">{t("credits.failed")}</p>
    ) : (
      <Spinner />
    );
  }
  return (
    <div className="flex flex-col gap-9">
      <Section title={t("credits.invoices")} hint={t("credits.invoicesHint")}>
        {!b.canBuy ? (
          <p className="text-[0.875rem] text-ink-3">{t("credits.invoicesOnlyAdmins")}</p>
        ) : b.invoices.length ? (
          <div className="flex flex-col divide-y divide-border-soft">
            {b.invoices.map((i) => (
              <div key={i.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="w-24 shrink-0 text-[0.875rem] text-ink-2 tabular-nums">
                  {day(i.issuedAt)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.9375rem]">
                    {i.credits
                      ? t("credits.invoiceCredits", { n: number(i.credits) })
                      : t("credits.invoicePlan")}
                  </div>
                  <div className="truncate font-mono text-[0.75rem] text-ink-3">
                    {i.number ?? i.id}
                  </div>
                </div>
                <Chip tone={i.status === "paid" ? "live" : "warn"}>
                  {i.status === "paid" ? t("credits.paid") : t("credits.open")}
                </Chip>
                <span className="w-20 shrink-0 text-right text-[0.875rem] tabular-nums">
                  {money(i.totalCents, i.currency)}
                </span>
                <IconButton
                  label={t("credits.pdf")}
                  onClick={() =>
                    openExternal(
                      `/api/studio/organization/invoices/${encodeURIComponent(i.id)}/pdf`,
                    )
                  }
                >
                  <FileText className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[0.875rem] text-ink-3">{t("credits.noInvoices")}</p>
        )}
      </Section>
    </div>
  );
}
