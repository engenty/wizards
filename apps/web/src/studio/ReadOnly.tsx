import { Laptop } from "lucide-react";
import { t } from "../lib/i18n";
import type { Project } from "../lib/session";

/**
 * Why a project is shown here and not changed: a local install sent it and changes it, or
 * nothing is built on this server at all.
 */
export function projectReadOnlyText(project: Pick<Project, "origin">): string {
  return t(project.origin === "local" ? "readonly.project" : "readonly.server");
}

/** The note, in amber so it is not missed, that stands where something would be edited: why not, and where it is done. */
export function ReadOnlyNote({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-amber-tint px-4 py-3 font-medium text-[0.875rem] text-ink leading-relaxed">
      <Laptop className="mt-0.5 size-4 shrink-0 text-amber" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}
