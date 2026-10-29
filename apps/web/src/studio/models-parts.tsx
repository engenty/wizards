/** The parts the panels of Settings › Models are made of. */
import { Check, CircleAlert, Coins, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../ui";

/** A part of the panel's card: a small heading, then its content. */
export function Part({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-border-soft border-t pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium text-[0.875rem]">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[0.8125rem] text-ink-3">{children}</p>;
}

/** The status of a panel, beside its name. */
export function Status({ text, tone }: { text: string; tone: "done" | "ok" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 font-medium text-[0.75rem]",
        tone === "done" && "bg-moss-tint text-moss",
        tone === "ok" && "bg-amber-tint text-ink-2",
        tone === "warn" && "bg-paper-2 text-ink-3",
      )}
    >
      {tone === "done" ? <Check className="size-3.5" strokeWidth={3} /> : null}
      {tone === "ok" ? <Coins className="size-3.5" /> : null}
      {tone === "warn" ? <CircleAlert className="size-3.5" /> : null}
      {text}
    </span>
  );
}

/** The panel's head: its name, one line on what it is for, and how it stands. */
export function PanelHead({
  icon: Icon,
  title,
  lead,
  status,
}: {
  icon: LucideIcon;
  title: string;
  lead: string;
  status?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 sm:gap-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ember-tint text-ember-strong">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-display font-semibold text-[1.375rem] leading-tight tracking-tight">
            {title}
          </h2>
          {status}
        </div>
        <p className="mt-0.5 text-[0.875rem] text-ink-3">{lead}</p>
      </div>
    </div>
  );
}
