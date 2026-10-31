import type { PersonConnectionView, PersonSignIns } from "@engenty/wizards-shared/connectors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, UserRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { initialsOf } from "../lib/session";
import { Button, Chip, Input, Label, Spinner } from "../ui";
import { Section } from "./space/Section";

const KEY = ["person-sign-ins"];
const day = (iso: string) =>
  new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(iso));

/**
 * Konto › Verbindungen (docs/plans/capabilities.md, "A person's own page"): per space of the
 * person, the connections they may use. Where each person signs in, they sign in or out here;
 * where the space signs in, they see which account and who set it up. Nobody sets one up here.
 */
export function PersonSignInsPage() {
  const qc = useQueryClient();
  const signIns = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<PersonSignIns>("/api/studio/person/sign-ins"),
  });
  // The provider's sign-in window tells the studio when it is done (`/api/connect/callback`).
  useEffect(() => {
    const heard = (e: MessageEvent) => {
      if (e.data?.type === "wizards:connected") {
        void qc.invalidateQueries({ queryKey: KEY });
      }
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  }, [qc]);
  const data = signIns.data;
  if (!data) {
    return signIns.isError ? (
      <p className="text-[0.875rem] text-rose">{t("konto.connectionsFailed")}</p>
    ) : (
      <Spinner />
    );
  }
  const spaces = data.spaces.filter((s) => s.connections.length);
  return (
    <div className="flex flex-col gap-9">
      <Section title={t("konto.connections")} hint={t("konto.connectionsHint")} plain>
        {spaces.length ? null : (
          <p className="px-1 text-[0.875rem] text-ink-3">{t("konto.connectionsNone")}</p>
        )}
      </Section>
      {spaces.map((space) => (
        <Section
          key={space.id}
          title={space.name}
          hint={t("konto.connectionsCount", { n: space.connections.length })}
        >
          <div className="flex flex-col divide-y divide-border-soft">
            {space.connections.map((c) => (
              <ConnectionRow key={c.id} connection={c} />
            ))}
          </div>
        </Section>
      ))}
      {spaces.length ? (
        <p className="px-1 text-[0.8125rem] text-ink-3">{t("konto.connectionsFoot")}</p>
      ) : null}
    </div>
  );
}

/** What it is: the connector's name, and the connection's where it says more. */
function titleOf(c: PersonConnectionView): string {
  const connector = c.connector?.name ?? c.connectorId;
  return c.name === connector ? c.name : `${connector} · ${c.name}`;
}

function ConnectionRow({ connection: c }: { connection: PersonConnectionView }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [keys, setKeys] = useState<Record<string, string> | null>(null);
  const path = `/api/studio/connections/${encodeURIComponent(c.id)}/my-sign-in`;
  const reload = () => qc.invalidateQueries({ queryKey: KEY });
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
  const fields = c.connector?.fields ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate(keys ?? {});
  };
  const person = c.signIn === "person";
  const sub = person
    ? [t("konto.connectionEach"), c.mySignIn?.label].filter(Boolean).join(" · ")
    : [
        c.account ? t("konto.connectionAsSpace") : t("konto.connectionSpaceNotYet"),
        c.setUpBy
          ? t("konto.connectionSetUpBy", { name: c.setUpBy, when: day(c.setUpAt) })
          : t("konto.connectionSetUpAt", { when: day(c.setUpAt) }),
      ].join(" · ");
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 font-semibold text-[0.75rem] text-ink-2">
          {initialsOf(c.connector?.name ?? c.connectorId) || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.9375rem]">{titleOf(c)}</div>
          <div className="flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
            {person ? (
              <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{sub}</span>
          </div>
        </div>
        {person ? (
          <div className="flex shrink-0 items-center gap-2">
            {c.mySignIn ? (
              <>
                <span className="max-sm:hidden">
                  <Chip tone="live">{t("konto.signedIn")}</Chip>
                </span>
                <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
                  {t("konto.signOut")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                busy={signIn.isPending && !keys}
                onClick={() =>
                  c.connector?.auth === "api_key"
                    ? setKeys(keys ? null : {})
                    : signIn.mutate(undefined)
                }
              >
                {t("konto.connectionSignIn")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {keys && !c.mySignIn ? (
        <form onSubmit={submit} className="mt-3 ml-12 flex flex-col gap-3">
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
                onChange={(e) => setKeys({ ...keys, [f.key]: e.target.value })}
              />
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="submit" size="sm" busy={signIn.isPending}>
              {t("konto.connectionSignIn")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setKeys(null)}>
              {t("orgSettings.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
      {signIn.isError ? (
        <p className="mt-2 ml-12 text-[0.8125rem] text-rose">{(signIn.error as Error).message}</p>
      ) : null}
      {confirm ? (
        <div className="mt-3 ml-12 flex flex-wrap items-center gap-3 rounded-lg bg-paper p-3 text-[0.875rem] ring-1 ring-border-soft">
          <p className="min-w-48 flex-1">
            {t("konto.connectionSignOutConfirm", { name: titleOf(c) })}
          </p>
          <Button variant="ghost" onClick={() => setConfirm(false)}>
            {t("orgSettings.cancel")}
          </Button>
          <Button busy={signOut.isPending} onClick={() => signOut.mutate()}>
            {t("konto.signOut")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
