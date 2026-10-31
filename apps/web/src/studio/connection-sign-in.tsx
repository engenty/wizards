import type { ConnectorKeyField } from "@engenty/wizards-shared/connectors";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { Button, Chip, cn, Input, Label } from "../ui";

/*
 * Signing in to a connection of a space: with the keys a person types, or on the provider's own
 * page in a window of its own. One flow for the person's menu › Verbindungen (`my-sign-in`) and
 * for Fähigkeiten › Connectors, where admins sign in as the space (`sign-in`).
 */

/** The provider's sign-in window tells the studio when it is done (`/api/connect/callback`). */
export function useConnectedMessage(heard: () => void) {
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      if (e.data?.type === "wizards:connected") {
        heard();
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [heard]);
}

export type SignIn = ReturnType<typeof useSignIn>;

/**
 * The state of one sign-in: `path` is the connection's `…/sign-in` or `…/my-sign-in`; `reload`
 * runs once keys were taken or the sign-in was removed.
 */
export function useSignIn(path: string, reload: () => unknown) {
  const [keys, setKeys] = useState<Record<string, string> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const signIn = useMutation({
    mutationFn: async (credentials?: Record<string, string>) => {
      if (credentials) {
        return api.post(path, { credentials });
      }
      // The window opens now, while the click still counts, and goes to the provider after.
      const popup = window.open("", "_blank", "popup,width=520,height=700");
      try {
        const { url } = await api.post<{ url: string }>(path, { oauth: true });
        if (popup) {
          popup.location.href = url;
        } else {
          window.location.href = url;
        }
      } catch (err) {
        popup?.close();
        throw err;
      }
    },
    onSuccess: async (_, credentials) => {
      if (credentials) {
        setKeys(null);
        await reload();
      }
    },
  });
  const signOut = useMutation({
    mutationFn: () => api.del(path),
    onSuccess: async () => {
      setConfirm(false);
      await reload();
    },
  });
  return { keys, setKeys, confirm, setConfirm, signIn, signOut };
}

/** The buttons: „Anmelden“ while signed out; signed in, a chip and „Abmelden“. */
export function SignInButtons({
  s,
  auth,
  signedIn,
}: {
  s: SignIn;
  auth: "oauth2" | "api_key" | "browser" | undefined;
  signedIn: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {signedIn ? (
        <>
          <span className="max-sm:hidden">
            <Chip tone="live">{t("konto.signedIn")}</Chip>
          </span>
          <Button variant="ghost" size="sm" onClick={() => s.setConfirm(true)}>
            {t("konto.signOut")}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          busy={s.signIn.isPending && !s.keys}
          onClick={() =>
            auth === "api_key" ? s.setKeys(s.keys ? null : {}) : s.signIn.mutate(undefined)
          }
        >
          {t("konto.connectionSignIn")}
        </Button>
      )}
    </div>
  );
}

/** Below the buttons: the keys to type, what went wrong, and the question before signing out. */
export function SignInPanel({
  s,
  fields,
  signedIn,
  confirmText,
  className,
}: {
  s: SignIn;
  fields: ConnectorKeyField[];
  signedIn: boolean;
  confirmText: string;
  className?: string;
}) {
  const { keys } = s;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    s.signIn.mutate(keys ?? {});
  };
  return (
    <>
      {keys && !signedIn ? (
        <form onSubmit={submit} className={cn("mt-3 flex flex-col gap-3", className)}>
          {fields.map((f) => (
            <div key={f.key}>
              <Label>{f.label}</Label>
              <Input
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={f.placeholder}
                required={f.required !== false}
                maxLength={500}
                value={keys[f.key] ?? ""}
                onChange={(e) => s.setKeys({ ...keys, [f.key]: e.target.value })}
              />
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="submit" size="sm" busy={s.signIn.isPending}>
              {t("konto.connectionSignIn")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => s.setKeys(null)}>
              {t("orgSettings.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
      {s.signIn.isError ? (
        <p className={cn("mt-2 text-[0.8125rem] text-rose", className)}>
          {(s.signIn.error as Error).message}
        </p>
      ) : null}
      {s.signOut.isError ? (
        <p className={cn("mt-2 text-[0.8125rem] text-rose", className)}>
          {(s.signOut.error as Error).message}
        </p>
      ) : null}
      {s.confirm ? (
        <div
          className={cn(
            "mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-paper p-3 text-[0.875rem] ring-1 ring-border-soft",
            className,
          )}
        >
          <p className="min-w-48 flex-1">{confirmText}</p>
          <Button variant="ghost" onClick={() => s.setConfirm(false)}>
            {t("orgSettings.cancel")}
          </Button>
          <Button busy={s.signOut.isPending} onClick={() => s.signOut.mutate()}>
            {t("konto.signOut")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
