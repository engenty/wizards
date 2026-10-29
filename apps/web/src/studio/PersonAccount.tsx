import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Laptop, Plug, Search } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { initialsOf, type Me, type Organization, type UserProfile } from "../lib/session";
import { Button, Chip, Input, Label, Spinner, Textarea } from "../ui";
import { LangPick } from "./LangSwitch";
import { switchTo } from "./Organizations";
import { useAutosave } from "./space/data";
import { Section } from "./space/Section";
import { ThemeSwitch } from "./ThemeSwitch";

const hint = "mt-1.5 text-[0.8125rem] text-ink-3";
const when = (iso: string) =>
  new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/**
 * Konto › Profil: the person's name (kept at the Manage-App, the same in every organization), what
 * they say about themselves, and how the studio looks for them.
 */
export function PersonProfile({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.user.name);
  const [profile, setProfile] = useState<UserProfile>(me.profile);
  const set = (patch: Partial<UserProfile>) => setProfile((now) => ({ ...now, ...patch }));
  const nameSave = useAutosave(name.trim(), async (next) => {
    if (next) {
      await api.put("/api/studio/person/name", { name: next });
      await qc.invalidateQueries({ queryKey: ["me"] });
    }
  });
  const profileSave = useAutosave(profile, async (next) => {
    await api.put("/api/studio/profile", next);
    await qc.invalidateQueries({ queryKey: ["me"] });
  });
  const save =
    nameSave.state === "error" ? nameSave : nameSave.state === "saving" ? nameSave : profileSave;
  return (
    <div className="flex flex-col gap-9">
      <Section title={t("konto.profile")} hint={t("konto.profileHint")} save={save}>
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
          <div className="flex shrink-0 flex-col items-center gap-2 sm:w-32">
            <div className="flex size-20 items-center justify-center overflow-hidden rounded-full bg-ember-tint font-semibold text-[1.75rem] text-ember-strong ring-1 ring-border-soft">
              {me.user.image ? (
                <img src={me.user.image} alt="" className="size-full object-cover" />
              ) : (
                initialsOf(name) || "?"
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label>{t("account.name")}</Label>
                <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label>{t("account.email")}</Label>
                <Input type="email" value={me.user.email} disabled readOnly />
                <p className={hint}>{t("konto.emailHint")}</p>
              </div>
            </div>
            <div>
              <Label>{t("account.about")}</Label>
              <Textarea
                minRows={3}
                maxLength={2000}
                value={profile.about}
                onChange={(e) => set({ about: e.target.value })}
              />
              <p className={hint}>{t("account.aboutHint")}</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label>{t("account.phone")}</Label>
                <Input
                  type="tel"
                  value={profile.phone}
                  maxLength={40}
                  onChange={(e) => set({ phone: e.target.value })}
                />
              </div>
            </div>
          </div>
        </div>
      </Section>
      <Section title={t("account.look")} hint={t("account.lookHint")}>
        <div className="flex flex-col divide-y divide-border-soft">
          <div className="flex items-center justify-between gap-4 pb-4">
            <span className="font-medium text-[0.875rem]">{t("nav.language")}</span>
            <LangPick />
          </div>
          <div className="flex items-center justify-between gap-4 pt-4">
            <span className="font-medium text-[0.875rem]">{t("nav.theme")}</span>
            <ThemeSwitch />
          </div>
        </div>
      </Section>
    </div>
  );
}

const ROLE: Record<Organization["role"], Key> = {
  owner: "organization.role.owner",
  admin: "organization.role.admin",
  member: "organization.role.member",
};

/** From seven organizations on, the list starts with a search field (as every list of them does). */
const SEARCH_FROM = 7;

/**
 * Konto › Organisationen: where the person is a member, and the way into each. “Wechseln” opens
 * the studio in that organization.
 */
export function PersonOrganizations({ me }: { me: Me }) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const many = me.organizations.length >= SEARCH_FROM;
  const typed = query.trim().toLowerCase();
  const found = typed
    ? me.organizations.filter((o) => o.name.toLowerCase().includes(typed))
    : me.organizations;
  const shown = many && !typed && !all ? found.slice(0, 6) : found;
  return (
    <Section
      title={t("konto.organizations")}
      hint={t("konto.organizationsHint", { n: me.organizations.length })}
    >
      {many ? (
        <div className="relative mb-4">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-ink-4" />
          <Input
            className="pl-9"
            value={query}
            placeholder={t("konto.organizationsSearch")}
            aria-label={t("konto.organizationsSearch")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      <div className="flex flex-col divide-y divide-border-soft">
        {shown.map((o) => {
          const here = o.id === me.tenant.id;
          return (
            <div key={o.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 font-medium text-[0.75rem] text-ink-2">
                {initialsOf(o.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.9375rem]">{o.name}</div>
                <div className="truncate text-[0.8125rem] text-ink-3">
                  {[t(ROLE[o.role]), o.plan?.name].filter(Boolean).join(" · ")}
                </div>
              </div>
              {here ? (
                <Chip>{t("konto.here")}</Chip>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => switchTo(o)}>
                  {t("konto.switch")}
                </Button>
              )}
            </div>
          );
        })}
        {typed && !found.length ? (
          <p className="text-[0.875rem] text-ink-3">{t("konto.organizationsNone")}</p>
        ) : null}
      </div>
      {many && !typed && !all && found.length > shown.length ? (
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => setAll(true)}>
          {t("konto.organizationsAll", { n: found.length - shown.length })}
        </Button>
      ) : null}
      <p className="mt-4 text-[0.8125rem] text-ink-3">{t("konto.organizationsLeave")}</p>
    </Section>
  );
}

interface Connections {
  apps: {
    id: string;
    name: string | null;
    clientId: string;
    uri: string | null;
    scopes: string[];
    tenantName: string | null;
    connectedAt: string;
    lastUsed: string;
  }[];
  computers: { id: string; tenantName: string | null; lastUsed: string }[];
}

/** What an app may do, in the words of the consent page. */
const SCOPES: Record<string, Key> = {
  "wizards:read": "konto.scope.read",
  "wizards:write": "konto.scope.write",
  "wizards:publish": "konto.scope.publish",
  "runs:test": "konto.scope.test",
  "runs:read": "konto.scope.results",
  profile: "konto.scope.profile",
};

/**
 * Konto › Verbundene Apps: everything that holds a sign-in of the person. Apps gave a consent and
 * may do what was allowed then; computers and terminals are engenty wizards signed in there.
 */
export function PersonApps() {
  const qc = useQueryClient();
  const connections = useQuery({
    queryKey: ["person-connections"],
    queryFn: () => api.get<Connections>("/api/studio/person/connections"),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["person-connections"] });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/api/studio/person/connections/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      setConfirm(null);
      await reload();
    },
  });
  const signOut = useMutation({
    mutationFn: (id: string) => api.del(`/api/studio/person/computers/${encodeURIComponent(id)}`),
    onSuccess: reload,
  });
  const data = connections.data;
  if (!data) {
    return connections.isError ? (
      <p className="text-[0.875rem] text-rose">{t("konto.appsFailed")}</p>
    ) : (
      <Spinner />
    );
  }
  return (
    <div className="flex flex-col gap-9">
      <Section title={t("konto.appsTitle")} hint={t("konto.appsHint")}>
        {data.apps.length ? (
          <div className="flex flex-col divide-y divide-border-soft">
            {data.apps.map((a) => {
              const name = a.name ?? a.clientId;
              const expanded = open === a.id;
              const may = a.scopes.filter((s) => SCOPES[s]);
              return (
                <div key={a.id} className="py-3 first:pt-0 last:pb-0">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : a.id)}
                    className="flex w-full items-center gap-3 text-left"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-ink-2">
                      <Plug className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[0.9375rem]">{name}</span>
                        {a.tenantName ? <Chip>{a.tenantName}</Chip> : null}
                      </span>
                      <span className="block truncate text-[0.8125rem] text-ink-3">
                        {t("konto.lastUsed", { when: when(a.lastUsed) })}
                      </span>
                    </span>
                    {expanded ? (
                      <ChevronDown className="size-4 text-ink-3" />
                    ) : (
                      <ChevronRight className="size-4 text-ink-3" />
                    )}
                  </button>
                  {expanded ? (
                    <div className="mt-3 ml-12 flex flex-col gap-3 text-[0.875rem]">
                      {may.length ? (
                        <div>
                          <div className="text-[0.8125rem] text-ink-3">{t("konto.may")}</div>
                          <ul className="mt-1 flex flex-col gap-1 text-ink-2">
                            {may.map((s) => (
                              <li key={s}>{t(SCOPES[s])}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <div className="text-[0.8125rem] text-ink-3">
                        {t("konto.connectedAt", { when: when(a.connectedAt) })}
                      </div>
                      {confirm === a.id ? (
                        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-paper p-3 ring-1 ring-border-soft">
                          <p className="min-w-48 flex-1">
                            {t("konto.disconnectConfirm", {
                              name,
                              organization: a.tenantName ?? "",
                            })}
                          </p>
                          <Button variant="ghost" onClick={() => setConfirm(null)}>
                            {t("orgSettings.cancel")}
                          </Button>
                          <Button
                            busy={disconnect.isPending && disconnect.variables === a.id}
                            onClick={() => disconnect.mutate(a.id)}
                          >
                            {t("konto.disconnect")}
                          </Button>
                        </div>
                      ) : (
                        <div>
                          <Button variant="secondary" size="sm" onClick={() => setConfirm(a.id)}>
                            {t("konto.disconnect")}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[0.875rem] text-ink-3">{t("konto.appsNone")}</p>
        )}
      </Section>
      <Section title={t("konto.computers")} hint={t("konto.computersHint")}>
        {data.computers.length ? (
          <div className="flex flex-col divide-y divide-border-soft">
            {data.computers.map((m) => (
              <div key={m.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-ink-2">
                  <Laptop className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[0.9375rem]">{t("konto.computer")}</span>
                    {m.tenantName ? <Chip>{m.tenantName}</Chip> : null}
                  </div>
                  <div className="truncate text-[0.8125rem] text-ink-3">
                    {t("konto.lastUsed", { when: when(m.lastUsed) })}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  busy={signOut.isPending && signOut.variables === m.id}
                  onClick={() => signOut.mutate(m.id)}
                >
                  {t("konto.signOut")}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[0.875rem] text-ink-3">{t("konto.computersNone")}</p>
        )}
      </Section>
    </div>
  );
}
