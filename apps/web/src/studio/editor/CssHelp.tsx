import { t } from "../../lib/i18n";
import { Dialog } from "../../ui";

/**
 * The names a wizard's own CSS can rely on. They stay as they are when the run page changes;
 * whatever else a page carries may not.
 */
const HOOKS = [
  [".wizard-page", "inspector.cssHelp.page"],
  [".wizard-title", "inspector.cssHelp.pageTitle"],
  [".wizard-heading", "inspector.cssHelp.headings"],
  [".wizard-button", "inspector.cssHelp.button"],
  [".wizard-field", "inspector.cssHelp.fields"],
  ["var(--wizard-accent)", "inspector.cssHelp.accent"],
  ["var(--wizard-background)", "inspector.cssHelp.background"],
  ["var(--wizard-text)", "inspector.cssHelp.text"],
  ["var(--wizard-font-heading)", "inspector.cssHelp.displayFont"],
  ["var(--wizard-font-text)", "inspector.cssHelp.bodyFont"],
] as const;

// The variables are read, not set: the look's fields decide them.
const EXAMPLE = `.wizard-title { letter-spacing: 0.04em; }
.wizard-button {
  border-radius: 0.5rem;
  outline: 2px solid var(--wizard-accent);
}`;

/** What a wizard's own CSS can style, kept to the names that stay stable. */
export function CssHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={t("inspector.cssHelp.heading")}>
      <p className="text-[0.875rem] text-ink-3">{t("inspector.cssHelp.intro")}</p>
      <table className="mt-4 w-full text-[0.8125rem]">
        <tbody>
          {HOOKS.map(([name, what]) => (
            <tr key={name} className="border-border-soft border-t first:border-t-0">
              <td className="whitespace-nowrap py-1.5 pr-4 align-top font-mono text-ink">{name}</td>
              <td className="py-1.5 text-ink-3">{t(what)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-paper-2 p-3 font-mono text-[0.75rem] text-ink-2">
        {EXAMPLE}
      </pre>
    </Dialog>
  );
}
