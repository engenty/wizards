import type { ReactNode } from "react";
import { EngentyLogoMark } from "../engenty/logo";
import { LangSwitch } from "./LangSwitch";
import { ThemeSwitch } from "./ThemeSwitch";

/**
 * The top of the pages before the studio (the sign-in door, the start page for guests): the
 * wordmark on the left, the theme and the language on the right, and what a page adds there.
 */
export function DoorBar({ end, className }: { end?: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${className ?? ""}`}>
      <span className="inline-flex items-center gap-2.5">
        <EngentyLogoMark size={28} />
        <span
          className={`font-display font-semibold text-[1.0625rem] tracking-tight ${end ? "max-sm:sr-only" : ""}`}
        >
          engenty
          <span className="mr-[0.09em] ml-[0.06em] text-ember-strong">.</span>
          <span className="font-normal text-ink-2">wizards</span>
        </span>
      </span>
      <span className="flex items-center gap-2">
        {/* On a phone with a button of the page's own there is room for the mark and the language only. */}
        <span className={end ? "flex max-sm:hidden" : "flex"}>
          <ThemeSwitch tone="surface" />
        </span>
        <LangSwitch tone="surface" />
        {end}
      </span>
    </div>
  );
}
