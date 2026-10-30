/**
 * Settings › Models › Overview: what the studio and the wizards run with, which model does which
 * job, and the accesses there are. The parts take what to show; Models.tsx decides it from the
 * models endpoint, the person and the organization's tier.
 */
import { ChevronRight, Cloud, Info, Laptop, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../lib/i18n";
import { Button, Card, cn, Switch } from "../ui";

/** Where a job or an access runs: on this computer, or in the cloud. */
export type Where = "pc" | "cloud" | null;

function WhereIcon({ where, className }: { where: Where; className?: string }) {
  if (!where) {
    return null;
  }
  const Icon = where === "pc" ? Laptop : Cloud;
  return (
    <Icon
      role="img"
      aria-label={t(where === "pc" ? "overview.onComputer" : "overview.inCloud")}
      className={cn("size-4 shrink-0 text-ink-3", className)}
    />
  );
}

export interface Helper {
  name: string;
  /** The jobs it does: "Entscheidungen, Wissen". */
  jobs: string;
  where: Where;
}

export interface Hero {
  name: string;
  sub: string;
  where: Where;
  missing: number;
  helpers: Helper[];
}

/** "Läuft mit …": the source most of the work runs on, how it stands, and who helps it. */
export function HeroCard({ hero }: { hero: Hero }) {
  const Icon = hero.where === "pc" ? Laptop : Cloud;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-paper-2 text-ink">
          <Icon className="size-6" />
        </span>
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
          <span className="font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.12em]">
            {t("overview.runsWith")}
          </span>
          <b className="font-display font-semibold text-[1.25rem] leading-tight">{hero.name}</b>
          <span className="text-[0.8125rem] text-ink-2">{hero.sub}</span>
        </div>
        <span
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-2 rounded-full px-3 font-medium text-[0.8125rem]",
            hero.missing ? "bg-amber-tint text-ink-2" : "bg-moss-tint text-moss",
          )}
        >
          <i
            className={cn("size-2 rounded-full", hero.missing ? "bg-amber" : "bg-moss")}
            aria-hidden
          />
          {hero.missing
            ? t(hero.missing === 1 ? "overview.missingOne" : "overview.missing", {
                n: hero.missing,
              })
            : t("overview.allReady")}
        </span>
      </div>
      {hero.helpers.length ? (
        <div className="flex flex-wrap items-center gap-2 border-border-soft border-t bg-paper-2/50 px-4 py-3 sm:px-5">
          <span className="mr-1 font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.12em]">
            {t("overview.helpedBy")}
          </span>
          {hero.helpers.map((h) => (
            <span
              key={h.name}
              className="inline-flex items-center gap-1.5 rounded-full bg-paper-2 px-2.5 py-1 text-[0.8125rem] text-ink-3"
            >
              <WhereIcon where={h.where} className="size-3.5" />
              <b className="font-medium text-ink">{h.name}</b>
              {h.jobs}
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export interface ScopeOption {
  id: string;
  name: string;
  desc: string;
  /** "Empfohlen", "ab Team". */
  tag: string | null;
  on: boolean;
  disabled: boolean;
}

/** "Welche Modelle": the tiers as three cards, for the organization's admins. */
export function ScopeCards({
  options,
  locked,
  disabled,
  onPick,
}: {
  options: ScopeOption[];
  locked: boolean;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((o) => {
          const off = o.disabled || ((locked || disabled) && !o.on);
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={o.on}
              disabled={off || disabled}
              onClick={() => onPick(o.id)}
              className={cn(
                "flex flex-col gap-2 rounded-xl border p-4 text-left transition",
                o.on
                  ? "border-ember bg-card ring-1 ring-ember"
                  : "border-border-soft bg-card hover:border-ink-4",
                off && "cursor-default bg-paper-2/60 hover:border-border-soft",
              )}
            >
              <span className="flex items-center gap-2.5">
                <span
                  className={cn(
                    "size-4 shrink-0 rounded-full border",
                    o.on ? "border-[5px] border-ember" : "border-ink-4",
                  )}
                />
                <b className={cn("font-medium text-[0.9375rem]", off && "text-ink-3")}>{o.name}</b>
                {o.tag ? (
                  <span className="ml-auto rounded-full bg-paper-2 px-2 py-0.5 font-medium text-[0.6875rem] text-ink-2">
                    {o.tag}
                  </span>
                ) : null}
              </span>
              <span className={cn("text-[0.8125rem]", off ? "text-ink-4" : "text-ink-2")}>
                {o.desc}
              </span>
            </button>
          );
        })}
      </div>
      {locked ? (
        <p className="flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
          <Lock className="size-3.5" />
          {t("overview.scopeLocked")}
        </p>
      ) : null}
    </div>
  );
}

export interface Job {
  id: string;
  name: string;
  purpose: string;
  state: "ok" | "miss" | "na";
  where: Where;
  access: string;
  model: string;
  /** Why it isn't offered: "nicht in EU-Datenschutz". */
  naText?: string;
  onOpen: () => void;
}

function JobRow({ job }: { job: Job }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row holds a button of its own (Einrichten)
    <div
      role="button"
      tabIndex={0}
      onClick={job.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          job.onOpen();
        }
      }}
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_1rem] items-center gap-x-3.5 gap-y-1.5 border-border-soft border-t px-4 py-3.5 transition first:border-t-0 hover:bg-accent/60 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_1rem] sm:px-5"
    >
      <div className="min-w-0">
        <b className="block font-medium text-[0.875rem]">{job.name}</b>
        <span className="block text-[0.75rem] text-ink-3">{job.purpose}</span>
      </div>
      <ChevronRight className="col-start-2 row-start-1 size-4 text-ink-4 sm:col-start-4" />
      {job.state === "ok" ? (
        <>
          <span className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-ink-2 sm:col-start-2 sm:row-start-1">
            <WhereIcon where={job.where} />
            <span className="truncate">{job.access}</span>
          </span>
          <span className="truncate text-[0.875rem] sm:col-start-3 sm:row-start-1">
            {job.model}
          </span>
        </>
      ) : job.state === "miss" ? (
        <>
          <span className="sm:col-start-2 sm:row-start-1">
            <span className="rounded-full bg-amber-tint px-2.5 py-0.5 font-medium text-[0.75rem] text-amber">
              {t("overview.missingWord")}
            </span>
          </span>
          <span className="sm:col-start-3 sm:row-start-1">
            <Button
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                job.onOpen();
              }}
            >
              {t("overview.setUp")}
            </Button>
          </span>
        </>
      ) : (
        <span className="text-[0.8125rem] text-ink-3 sm:col-span-2 sm:col-start-2 sm:row-start-1">
          {job.naText}
        </span>
      )}
    </div>
  );
}

/** A box of "Welches Modell wofür": its heading, one line on it, a row per job. */
export function JobsBox({ title, desc, jobs }: { title: string; desc: string; jobs: Job[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-border-soft border-b bg-paper-2/50 px-4 pt-3 pb-2 sm:px-5">
        <b className="block font-semibold text-[0.75rem] text-ink-2 uppercase tracking-[0.08em]">
          {title}
        </b>
        <span className="block text-[0.8125rem] text-ink-3">{desc}</span>
      </div>
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} />
      ))}
    </Card>
  );
}

export type AccessRow =
  | { kind: "label"; label: string }
  | {
      kind: "row";
      id: string;
      name: string;
      desc: string;
      /** Where the data goes while this is on. */
      note?: string | null;
      status?: string | null;
      muted?: boolean;
      value?: string | null;
      button?: { label: string; primary?: boolean; onClick: () => void } | null;
      toggle?: { on: boolean; disabled?: boolean; onChange: (on: boolean) => void } | null;
      onOpen?: () => void;
    };

/** "Zugänge" as one list: credits, what is on this computer, keys, and what admins allow. */
export function AccessList({ rows }: { rows: AccessRow[] }) {
  return (
    <Card className="overflow-hidden p-0">
      {rows.map((row) =>
        row.kind === "label" ? (
          <div
            key={`label-${row.label}`}
            className="border-border-soft border-t px-4 pt-3.5 pb-0.5 font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.12em] first:border-t-0 sm:px-5"
          >
            {row.label}
          </div>
        ) : (
          <div
            key={row.id}
            className="flex items-center gap-3.5 border-border-soft border-t px-4 py-3.5 first:border-t-0 sm:px-5"
          >
            <div className="min-w-0 flex-1">
              {row.onOpen ? (
                <button
                  type="button"
                  onClick={row.onOpen}
                  className="block text-left font-medium text-[0.875rem] hover:text-ember-strong"
                >
                  {row.name}
                </button>
              ) : (
                <b className="block font-medium text-[0.875rem]">{row.name}</b>
              )}
              <span className="block text-[0.8125rem] text-ink-3">{row.desc}</span>
              {row.note ? (
                <span className="mt-1.5 flex items-start gap-1.5 text-[0.75rem] text-ink-2">
                  <Info className="mt-px size-3.5 shrink-0 text-ink-3" />
                  {row.note}
                </span>
              ) : null}
            </div>
            {row.status ? (
              <span
                className={cn(
                  "shrink-0 text-right text-[0.8125rem]",
                  row.muted ? "text-ink-3" : "text-ink-2",
                )}
              >
                {row.status}
              </span>
            ) : null}
            {row.value ? (
              <span className="shrink-0 rounded-full bg-paper-2 px-2.5 py-1 font-medium text-[0.8125rem]">
                {row.value}
              </span>
            ) : null}
            {row.button ? (
              <Button
                size="sm"
                variant={row.button.primary ? "primary" : "quiet"}
                onClick={row.button.onClick}
              >
                {row.button.label}
              </Button>
            ) : null}
            {row.toggle ? (
              <Switch
                checked={row.toggle.on}
                disabled={row.toggle.disabled}
                onChange={row.toggle.onChange}
                label={row.name}
              />
            ) : null}
          </div>
        ),
      )}
    </Card>
  );
}

/** A section of the overview: its heading, a line under it, and what it holds. */
export function OverviewSection({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-semibold text-[1rem]">{title}</h2>
        {lead ? <p className="mt-0.5 text-[0.8125rem] text-ink-3">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}
