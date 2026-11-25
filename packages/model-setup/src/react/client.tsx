import { Button, cn } from "@engenty/chatviews/react/ui";
import { Check, RefreshCw } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CLIENT_IDS, type ClientId } from "../catalog.js";
import type { ClientSetupStatus } from "../types.js";
import type { SetupChoice } from "./columns.js";
import { useCall, useSetupHost, useText } from "./host.js";

// The terminal is big and rarely needed: it loads when one opens.
const Terminal = lazy(() => import("./terminal.js"));

/** What a test call came to. */
export interface TestResult {
  ok: boolean;
  ref?: string;
  reply?: string;
  error?: string;
  ms: number;
}

/**
 * One short call, as the app would make it; the answer shows the way is open. `auto`: the call
 * is made right away, as the setup tests by itself once a source is ready.
 */
export function ModelTest({ auto = false }: { auto?: boolean }) {
  const host = useSetupHost();
  const t = useText();
  const test = useCall(async () => {
    const result = await host.post<TestResult>("/models/test", {});
    // A working call ends the setup: the page learns it.
    if (result.ok) {
      await host.changed();
    }
    return result;
  });
  const { run } = test;
  const started = useRef(false);
  useEffect(() => {
    if (auto && !started.current) {
      started.current = true;
      void run();
    }
  }, [auto, run]);
  const r = test.data;
  const failed = test.error ?? (r && !r.ok ? (r.error ?? "") : undefined);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[0.8125rem] text-ink-3">{t("local.testHint")}</p>
      <div>
        <Button variant="secondary" busy={test.busy} onClick={() => void run()}>
          {t("local.test")}
        </Button>
      </div>
      {r?.ok ? (
        <p className="flex items-start gap-2 text-[0.875rem] text-ink-2">
          <Check className="mt-0.5 size-4 shrink-0 text-moss" />
          <span>
            {t("local.testOk", {
              s: (r.ms / 1000).toFixed(1),
              ref: r.ref ?? "",
              reply: r.reply ?? "",
            })}
          </span>
        </p>
      ) : null}
      {failed !== undefined ? (
        <p className="text-[0.875rem] text-rose">{t("local.testFailed", { error: failed })}</p>
      ) : null}
    </div>
  );
}

/**
 * Installed clients first, and among each, the one whose app is on this computer; else in the
 * catalog's order.
 */
export function rankClients<T extends Pick<ClientSetupStatus<ClientId>, "id" | "version" | "app">>(
  clients: readonly T[],
): T[] {
  const rank = (c: T) => (c.version === null ? 2 : 0) + (c.app ? 0 : 1);
  return [...clients].sort(
    (a, b) => rank(a) - rank(b) || CLIENT_IDS.indexOf(a.id) - CLIENT_IDS.indexOf(b.id),
  );
}

/**
 * The clients the list opens with: those signed in. Where none is, those installed or with their
 * app on this computer; where nothing is there, the first. The others are among the rest.
 */
export function foundClients<
  T extends Pick<ClientSetupStatus<ClientId>, "id" | "version" | "app" | "auth">,
>(clients: readonly T[]): T[] {
  const ranked = rankClients(clients);
  const signedIn = ranked.filter((c) => c.version !== null && c.auth !== "none");
  if (signedIn.length) {
    return signedIn;
  }
  const here = ranked.filter((c) => c.version !== null || c.app);
  return here.length ? here : ranked.slice(0, 1);
}

/** The clients as rows of the list, the first one recommended. */
export function useClientChoices(clients: readonly ClientSetupStatus<ClientId>[]): SetupChoice[] {
  const t = useText();
  const found = foundClients(clients);
  return rankClients(clients).map((client) => ({
    id: client.id,
    title: client.label,
    description: t(`harness.desc.${client.id}`),
    ...(client === found[0] ? { badge: t("setup.recommended") } : {}),
    ...(found.includes(client) ? {} : { more: true }),
    ...(client.version === null
      ? { note: t("harness.notInstalled") }
      : client.auth === "none"
        ? { note: t("harness.signedOut") }
        : client.auth === "subscription"
          ? { note: t("harness.ready") }
          : {}),
  }));
}

/** Where a client stands: its step, and what to do now. */
export function useClientStage(client: ClientSetupStatus | undefined, works: boolean) {
  const t = useText();
  if (works) {
    return { stage: 2, heading: t("setup.h.done") };
  }
  if (!client) {
    return { stage: 1, heading: t("setup.h.test") };
  }
  if (client.version === null) {
    return { stage: 0, heading: t("setup.h.install", { name: client.name }) };
  }
  return client.auth === "none"
    ? { stage: 0, heading: t("setup.h.signIn", { name: client.name }) }
    : { stage: 1, heading: t("setup.h.test") };
}

/**
 * One AI client on this computer: found with its version, how it is signed in, the sign-in
 * itself in a terminal, and the test call. The setup and the settings both show it.
 */
export function ClientPanel({
  client,
  autoTest = false,
  hint,
}: {
  client: ClientSetupStatus<ClientId>;
  /** Make the test call without a click as soon as the client is signed in. */
  autoTest?: boolean;
  /** What the app does with it; the package's own line when none is given. */
  hint?: string;
}) {
  const host = useSetupHost();
  const t = useText();
  const { id } = client;
  // The terminal runs the install or the sign-in; one of them at a time.
  const [terminal, setTerminal] = useState<{ id: string; job: "install" | "login" } | null>(null);
  const [ended, setEnded] = useState<number | null>(null);
  const recheck = useCall(async () => {
    await host.post(`/harness/${id}/detect`);
    await host.changed();
  });
  const open = async (job: "install" | "login") => {
    const started = await host.post<{ terminal: string }>(`/harness/${id}/${job}`, {
      cols: 100,
      rows: 24,
    });
    setTerminal({ id: started.terminal, job });
    setEnded(null);
  };
  const install = useCall(() => open("install"));
  const login = useCall(() => open("login"));
  const signedIn = client.auth === "subscription";
  const installed = client.version !== null;
  // What the terminal was for is there and its command is over: it has done its job.
  useEffect(() => {
    if (ended !== null && (terminal?.job === "install" ? installed : signedIn)) {
      setTerminal(null);
    }
  }, [signedIn, installed, ended, terminal?.job]);
  const sub = t(`harness.sub.${id}`);
  const again = (
    <Button variant="ghost" size="sm" busy={recheck.busy} onClick={() => void recheck.run()}>
      <RefreshCw className="size-3.5" /> {t("local.recheck")}
    </Button>
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] text-ink-3">
        {hint ??
          t(client.images ? "harness.hintImages" : "harness.hint", { name: client.name, sub })}
      </p>
      {installed ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-[0.875rem] text-ink-2">
            <Check className="size-4 text-moss" />
            {t("harness.found", { name: client.name, version: client.version ?? "" })}
          </p>
          <p className={cn("text-[0.8125rem]", signedIn ? "text-ink-3" : "text-rose")}>
            {signedIn
              ? t("harness.authSubscription", { sub })
              : client.auth === "api_key"
                ? t("harness.authKey", { sub })
                : t("harness.authNone")}
          </p>
          {signedIn || terminal ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button busy={login.busy} onClick={() => void login.run()}>
                {t("harness.signIn")}
              </Button>
              {again}
            </div>
          )}
          {login.error ? <p className="text-[0.8125rem] text-rose">{login.error}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[0.875rem] text-rose">{t("harness.missing", { name: client.name })}</p>
          {client.app ? (
            <p className="text-[0.8125rem] text-ink-3">
              {t("harness.appHere", { app: client.app, name: client.name, sub })}
            </p>
          ) : null}
          {terminal ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button busy={install.busy} onClick={() => void install.run()}>
                {t("harness.installButton", { name: client.name })}
              </Button>
              {again}
            </div>
          )}
          {install.error ? <p className="text-[0.8125rem] text-rose">{install.error}</p> : null}
          <p className="text-[0.8125rem] text-ink-3">
            {t("harness.install")}{" "}
            <code className="rounded bg-paper px-1.5 py-0.5 font-mono text-[0.75rem] text-ink-2">
              {client.install}
            </code>
          </p>
        </div>
      )}
      {terminal ? (
        <div className="flex flex-col gap-2">
          <p className="text-[0.8125rem] text-ink-3">
            {terminal.job === "install"
              ? t("harness.installing", { name: client.name })
              : client.interactiveLogin
                ? t("harness.signInInteractive", { name: client.name, sub })
                : t("harness.signingIn")}
          </p>
          <Suspense fallback={<div className="h-[28rem] max-h-[60dvh] rounded-lg bg-[#0f1424]" />}>
            <Terminal
              key={terminal.id}
              id={terminal.id}
              onDone={() => void recheck.run()}
              onExit={(code) => {
                setEnded(code);
                void recheck.run();
              }}
            />
          </Suspense>
          <div className="flex flex-wrap items-center gap-2">
            {ended === null ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void host.del(`/terminal/${terminal.id}`).catch(() => undefined);
                  setTerminal(null);
                }}
              >
                {t("setup.cancel")}
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => setTerminal(null)}>
                  {t("setup.close")}
                </Button>
                {terminal.job === "install" ? (
                  installed ? null : (
                    <span className="text-[0.8125rem] text-rose">
                      {t("harness.installEnded", { name: client.name })}
                    </span>
                  )
                ) : signedIn ? null : (
                  <span className="text-[0.8125rem] text-rose">
                    {t("harness.loginEnded", { name: client.name })}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}
      {/* A new sign-in is a new start: the test of the old one is put away. */}
      {installed ? (
        <ModelTest key={`${id}:${client.auth}`} auto={autoTest && client.auth !== "none"} />
      ) : null}
    </div>
  );
}
