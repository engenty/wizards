import type {
  OwnConnectionView,
  PersonConnectionView,
  PersonSignIns,
} from "@engenty/wizards-shared/connectors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, UserRound } from "lucide-react";
import { useCallback } from "react";
import { api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { initialsOf } from "../lib/session";
import { askConfirm, Button, Chip, Spinner } from "../ui";
import { SignInButtons, SignInPanel, useConnectedMessage, useSignIn } from "./connection-sign-in";
import { Section } from "./space/Section";

const KEY = ["person-sign-ins"];
const day = (iso: string) =>
  new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(iso));

/**
 * Konto › Verbindungen (docs/plans/capabilities.md, "A person's own page"): per space of the
 * person, the connections they may use. Where each person signs in, they sign in or out here;
 * where the space signs in, they see which account and who set it up. Nobody sets one up here.
 * A connection an admin paused shows „pausiert“: nobody reaches it until it is resumed.
 *
 * Above them the person's own connections (docs/plans/run-connections.md): what they connected in
 * a run, counted in every space of theirs, with the wizards that use each. Disconnecting one
 * deletes it, and every wizard that used it asks again.
 */
export function PersonSignInsPage() {
  const qc = useQueryClient();
  const signIns = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<PersonSignIns>("/api/studio/person/sign-ins"),
  });
  useConnectedMessage(useCallback(() => void qc.invalidateQueries({ queryKey: KEY }), [qc]));
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
      <Section title={t("konto.own")} hint={data.own.length ? t("konto.ownHint") : undefined}>
        {data.own.length ? (
          <div className="flex flex-col divide-y divide-border-soft">
            {data.own.map((c) => (
              <OwnRow key={c.id} connection={c} />
            ))}
          </div>
        ) : (
          <p className="text-[0.875rem] text-ink-3">{t("konto.ownNone")}</p>
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
  const s = useSignIn(`/api/studio/connections/${encodeURIComponent(c.id)}/my-sign-in`, () =>
    qc.invalidateQueries({ queryKey: KEY }),
  );
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
        {c.pausedAt ? <Chip tone="ember">{t("connection.paused")}</Chip> : null}
        {person ? (
          <SignInButtons s={s} auth={c.connector?.auth} signedIn={Boolean(c.mySignIn)} />
        ) : null}
      </div>
      <SignInPanel
        s={s}
        fields={c.connector?.fields ?? []}
        signedIn={Boolean(c.mySignIn)}
        confirmText={t("konto.connectionSignOutConfirm", { name: titleOf(c) })}
        className="ml-12"
      />
    </div>
  );
}

/** One of the person's own connections, with the wizards that chose it. */
function OwnRow({ connection: c }: { connection: OwnConnectionView }) {
  const qc = useQueryClient();
  const name = [c.connectorName ?? c.connectorId, c.label].join(" · ");
  const disconnect = useMutation({
    mutationFn: () => api.del(`/api/studio/my-connections/${encodeURIComponent(c.id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const ask = async () => {
    if (
      await askConfirm(t("konto.ownDisconnectConfirm", { name }), {
        detail: t("konto.ownDisconnectDetail"),
        action: t("konto.ownDisconnect"),
      })
    ) {
      disconnect.mutate();
    }
  };
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 font-semibold text-[0.75rem] text-ink-2">
          {initialsOf(c.connectorName ?? c.connectorId) || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.9375rem]">{name}</div>
          <div className="truncate text-[0.8125rem] text-ink-3">
            {c.wizards.length
              ? t("konto.ownUsedBy", {
                  wizards: c.wizards.map((w) => t("needs.quoted", { text: w.title })).join(", "),
                })
              : t("konto.ownUnused")}
          </div>
        </div>
        <Button size="sm" variant="quiet" busy={disconnect.isPending} onClick={ask}>
          {t("konto.ownDisconnect")}
        </Button>
      </div>
      {disconnect.isError ? (
        <p className="mt-1.5 ml-12 text-[0.8125rem] text-rose">{t("konto.ownDisconnectFailed")}</p>
      ) : null}
    </div>
  );
}
