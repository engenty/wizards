import { Button, Dialog } from "@engenty/wizards-runner/ui";
import { useSyncExternalStore } from "react";
import { t } from "../lib/i18n";

/**
 * Asking before something can't be undone: one dialog for the whole studio, in place of the
 * browser's `confirm`, which an embedded browser may answer with no without asking. The action
 * is red; Escape, the backdrop and „Abbrechen“ say no.
 */
interface Ask {
  question: string;
  detail?: string;
  action: string;
  danger: boolean;
  answer: (ok: boolean) => void;
}

let current: Ask | null = null;
const listeners = new Set<() => void>();

function set(next: Ask | null) {
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Asks the question; true once the person pressed the action. */
export function askConfirm(
  question: string,
  opts: { detail?: string; action?: string; danger?: boolean } = {},
): Promise<boolean> {
  current?.answer(false);
  return new Promise((resolve) => {
    set({
      question,
      detail: opts.detail,
      action: opts.action ?? t("confirm.delete"),
      danger: opts.danger ?? true,
      answer: (ok) => {
        set(null);
        resolve(ok);
      },
    });
  });
}

/** Where the question shows: once, in the studio's frame. */
export function ConfirmHost() {
  const ask = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  return (
    <Dialog open={ask !== null} onClose={() => ask?.answer(false)} title={ask?.question}>
      {ask ? (
        <div className="flex flex-col gap-5">
          {ask.detail ? (
            <p className="text-[0.875rem] text-ink-2 leading-relaxed">{ask.detail}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => ask.answer(false)}>
              {t("confirm.cancel")}
            </Button>
            <Button
              autoFocus
              variant={ask.danger ? "secondary" : "primary"}
              className={
                ask.danger
                  ? "border-transparent bg-rose text-white hover:bg-rose hover:brightness-95"
                  : undefined
              }
              onClick={() => ask.answer(true)}
            >
              {ask.action}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
