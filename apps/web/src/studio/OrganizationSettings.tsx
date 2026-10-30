import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Contact,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  MailPlus,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ApiError, api } from "../lib/api";
import { useFeature } from "../lib/features";
import { type Key, lang, t } from "../lib/i18n";
import { initialsOf, type Me, useProjects } from "../lib/session";
import { useStudioPlugins } from "../plugins/host";
import { Button, Chip, IconButton, Input, Select, Spinner, useAutosave } from "../ui";
import { billingUrl } from "./AppFrame";
import { Section } from "./project/Section";
import { useModelTiers } from "./tiers";

type Role = "owner" | "admin" | "member";

interface OrganizationInfo {
  members: {
    userId: string;
    name: string;
    email: string;
    image: string | null;
    role: Role;
    joinedAt: string;
  }[];
  invitations: { id: string; email: string; role: Role; expiresAt: string }[];
  seats: { limit: number | null; taken: number };
  plan: { id: string; name: string } | null;
  canManage: boolean;
}

const ROLES: Role[] = ["owner", "admin", "member"];

/** A refusal of the Manage-App, said by its code; anything else as it came. */
const REFUSALS: Record<string, Key> = {
  forbidden: "orgSettings.refused.forbidden",
  PLAN_SEATS: "orgSettings.refused.seats",
  PLAN_ROLES: "orgSettings.refused.roles",
  already_member: "orgSettings.refused.alreadyMember",
  last_owner: "orgSettings.refused.lastOwner",
};
function refusal(error: unknown): string | null {
  if (!error) {
    return null;
  }
  const code = error instanceof ApiError ? (error.body?.code as string | undefined) : undefined;
  return code && REFUSALS[code] ? t(REFUSALS[code]) : (error as Error).message;
}

function useOrganization(me: Me) {
  return useQuery({
    queryKey: ["organization", me.tenant.id],
    queryFn: () => api.get<OrganizationInfo>("/api/studio/organization"),
  });
}

function Avatar({ name, image }: { name: string; image: string | null }) {
  return image ? (
    <img src={image} alt="" className="size-9 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper-2 font-medium text-[0.75rem] text-ink-2">
      {initialsOf(name)}
    </span>
  );
}

function CopyRow({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="text-[0.8125rem] text-ink-3">{label}</div>
        <div className="truncate font-mono text-[0.875rem]">{text}</div>
      </div>
      <IconButton
        label={copied ? t("settings.copied") : t("settings.copy")}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // The address stays on screen to select.
          }
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </IconButton>
    </div>
  );
}

/** One fact of the plan: what it is, how much, and a line under it. */
function PlanFact({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="min-w-0 rounded-lg bg-paper-2/60 px-3 py-2.5">
      <span className="block font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.1em]">
        {label}
      </span>
      <b className="block truncate font-medium text-[0.9375rem]">{value}</b>
      {sub ? <span className="block truncate text-[0.75rem] text-ink-3">{sub}</span> : null}
    </div>
  );
}

/** "3 von 5", or "3 · ohne Grenze" where the plan sets none. */
const ofLimit = (n: number, limit: number | null) =>
  limit === null ? t("orgSettings.planNoLimit", { n }) : t("orgSettings.planOf", { n, limit });

/**
 * The organization's plan: its name, what of it is in use (spaces, members), the credits left,
 * the model tier it is on and the tiers the plan offers.
 */
function PlanSection({ me, billing, admin }: { me: Me; billing: string | null; admin: boolean }) {
  const org = useOrganization(me);
  const projects = useProjects();
  const { tier } = useModelTiers();
  const offered = (tier?.choices ?? []).filter((c) => c.inPlan).map((c) => c.name);
  return (
    <Section title={t("orgSettings.plan")} hint={t("orgSettings.planHint")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <b className="min-w-0 flex-1 font-display font-semibold text-[1.125rem]">
            {me.tenant.plan?.name}
          </b>
          {admin && billing ? (
            <a
              href={billing}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-[0.8125rem] text-ember-strong hover:underline"
            >
              {t("orgSettings.planChange")} <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <PlanFact
            label={t("orgSettings.planSpaces")}
            value={projects.data ? ofLimit(projects.data.length, me.limits.projects) : "–"}
          />
          <PlanFact
            label={t("orgSettings.planMembers")}
            value={org.data ? ofLimit(org.data.seats.taken, org.data.seats.limit) : "–"}
          />
          <PlanFact
            label={t("orgSettings.planCredits")}
            value={
              me.credits === null
                ? "–"
                : t("orgSettings.planCreditsLeft", {
                    n: Math.floor(me.credits).toLocaleString(lang),
                  })
            }
          />
          <PlanFact
            label={t("orgSettings.planModels")}
            value={tier?.name ?? "–"}
            sub={
              offered.length > 1 ? t("orgSettings.planTiers", { tiers: offered.join(", ") }) : null
            }
          />
        </div>
      </div>
    </Section>
  );
}

/**
 * Settings › Allgemein: the organization's name, saved as it is typed (owners and admins), its
 * plan and its addresses; its own domains behind `customDomains`.
 */
export function OrganizationGeneral({ me }: { me: Me }) {
  const qc = useQueryClient();
  const admin = me.tenant.role !== "member";
  const [name, setName] = useState(me.tenant.name ?? "");
  const save = useAutosave(name.trim(), async (value) => {
    if (value) {
      await api.put("/api/studio/organization", { name: value });
      await qc.invalidateQueries({ queryKey: ["me"] });
    }
  });
  const domains = useFeature("customDomains");
  const studioUrl = me.tenant.slug ? `${window.location.origin}/studio/${me.tenant.slug}/` : null;
  const billing = billingUrl(me);
  return (
    <div className="flex flex-col gap-9">
      <Section
        title={t("orgSettings.name")}
        hint={t("orgSettings.nameHint")}
        save={admin ? save : undefined}
        locked={!admin}
      >
        <Input
          value={name}
          maxLength={80}
          aria-label={t("orgSettings.name")}
          onChange={(e) => setName(e.target.value)}
        />
      </Section>
      {me.tenant.plan ? <PlanSection me={me} billing={billing} admin={admin} /> : null}
      <AddressSection me={me} studioUrl={studioUrl} />
      {admin && domains ? <DomainsSection me={me} /> : null}
    </div>
  );
}

/**
 * Leaving the organization, under Mitglieder: only while someone else is in it, so it never
 * stays behind with nobody. The last owner is refused by the Manage-App (`last_owner`).
 */
function LeaveSection({ me }: { me: Me }) {
  const [leaving, setLeaving] = useState(false);
  const leave = useMutation({
    mutationFn: () => api.del(`/api/studio/organization/members/${encodeURIComponent(me.user.id)}`),
    // The studio's sign-in still names this organization: a new one goes to another.
    onSuccess: () => window.location.assign("/api/auth/login"),
  });
  return (
    <Section title={t("orgSettings.leave")} hint={t("orgSettings.leaveHint")}>
      {leaving ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-48 flex-1 text-[0.875rem]">
            {t("orgSettings.leaveConfirm", { name: me.tenant.name ?? "" })}
          </p>
          <Button variant="ghost" onClick={() => setLeaving(false)}>
            {t("orgSettings.cancel")}
          </Button>
          <Button busy={leave.isPending} onClick={() => leave.mutate()}>
            {t("orgSettings.leaveYes")}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setLeaving(true)}>
          {t("orgSettings.leaveButton")}
        </Button>
      )}
      {leave.error ? (
        <p className="mt-3 text-[0.875rem] text-rose">{refusal(leave.error)}</p>
      ) : null}
    </Section>
  );
}

/** The invitation form, opened from the section's head. */
function InviteForm({ me, onDone }: { me: Me; onDone: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const roles = me.tenant.role === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");
  const invite = useMutation({
    mutationFn: () =>
      api.post("/api/studio/organization/invitations", { email: email.trim(), role }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["organization", me.tenant.id] });
      onDone();
    },
  });
  return (
    <form
      className="mb-4 flex flex-col gap-3 rounded-lg bg-paper p-3 ring-1 ring-border-soft"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        invite.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-48 flex-1 flex-col gap-1.5">
          <span className="font-medium text-[0.8125rem]">{t("orgSettings.inviteEmail")}</span>
          <Input
            type="email"
            required
            autoFocus
            value={email}
            placeholder={t("orgSettings.inviteEmailPlaceholder")}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex w-40 flex-col gap-1.5">
          <span className="font-medium text-[0.8125rem]">{t("orgSettings.role")}</span>
          <Select
            value={role}
            onChange={(v) => setRole(v as Role)}
            options={roles.map((r) => ({ value: r, label: t(`organization.role.${r}`) }))}
          />
        </label>
      </div>
      <p className="text-[0.8125rem] text-ink-3">{t("orgSettings.inviteHint")}</p>
      {invite.error ? <p className="text-[0.875rem] text-rose">{refusal(invite.error)}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("orgSettings.cancel")}
        </Button>
        <Button type="submit" busy={invite.isPending}>
          {t("orgSettings.inviteSend")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Settings › Mitglieder: who works in the organization, their roles and who is invited. Owners and
 * admins invite, change roles and remove people; only an owner gives or takes the owner role.
 * Everyone else the organization works with is in Kontakte.
 */
export function OrganizationMembers({ me }: { me: Me }) {
  const qc = useQueryClient();
  const organization = useOrganization(me);
  const plugins = useStudioPlugins();
  const [inviting, setInviting] = useState(false);
  const reload = () => qc.invalidateQueries({ queryKey: ["organization", me.tenant.id] });
  const setRole = useMutation({
    mutationFn: (input: { userId: string; role: Role }) =>
      api.patch(`/api/studio/organization/members/${encodeURIComponent(input.userId)}`, {
        role: input.role,
      }),
    onSuccess: reload,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api.del(`/api/studio/organization/members/${encodeURIComponent(userId)}`),
    onSuccess: reload,
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api.del(`/api/studio/organization/invitations/${encodeURIComponent(id)}`),
    onSuccess: reload,
  });
  const data = organization.data;
  const manage = data?.canManage ?? false;
  const owner = me.tenant.role === "owner";
  const contacts = plugins.plugins.some((p) => p.id === "contacts");
  const seats = data?.seats;
  const hint = seats
    ? seats.limit === null
      ? t("orgSettings.membersHintUnlimited", { name: me.tenant.name ?? "" })
      : t("orgSettings.membersHint", {
          name: me.tenant.name ?? "",
          taken: seats.taken,
          limit: seats.limit,
        })
    : t("orgSettings.membersHintUnlimited", { name: me.tenant.name ?? "" });
  const error = refusal(setRole.error ?? remove.error ?? cancel.error);
  return (
    <div className="flex flex-col gap-9">
      <Section
        title={t("orgSettings.members")}
        hint={hint}
        action={
          manage && !inviting ? (
            <Button size="sm" onClick={() => setInviting(true)}>
              <MailPlus className="size-4" /> {t("orgSettings.invite")}
            </Button>
          ) : null
        }
      >
        {inviting ? <InviteForm me={me} onDone={() => setInviting(false)} /> : null}
        {organization.isPending ? (
          <Spinner />
        ) : organization.isError || !data ? (
          <p className="text-[0.875rem] text-rose">{t("organization.failed")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-border-soft">
            {data.members.map((m) => {
              const self = m.userId === me.user.id;
              // An admin leaves owners alone; nobody changes their own role here.
              const editable = manage && !self && (owner || m.role !== "owner");
              return (
                <div key={m.userId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <Avatar name={m.name} image={m.image} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.9375rem]">
                      {m.name}
                      {self ? <span className="text-ink-4"> · {t("organization.you")}</span> : null}
                    </div>
                    <div className="truncate text-[0.8125rem] text-ink-3">{m.email}</div>
                  </div>
                  {editable ? (
                    <Select
                      className="w-36"
                      value={m.role}
                      onChange={(v) => setRole.mutate({ userId: m.userId, role: v as Role })}
                      options={(owner ? ROLES : ROLES.filter((r) => r !== "owner")).map((r) => ({
                        value: r,
                        label: t(`organization.role.${r}`),
                      }))}
                    />
                  ) : (
                    <Chip tone={m.role === "member" ? undefined : "live"}>
                      {t(`organization.role.${m.role}`)}
                    </Chip>
                  )}
                  {editable ? (
                    <IconButton
                      label={t("orgSettings.remove", { name: m.name })}
                      onClick={() => remove.mutate(m.userId)}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  ) : manage ? (
                    <span className="size-9 shrink-0" />
                  ) : null}
                </div>
              );
            })}
            {data.invitations.map((i) => (
              <div key={i.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-3">
                  <MailPlus className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.9375rem]">{i.email}</div>
                  <div className="truncate text-[0.8125rem] text-ink-3">
                    {t("orgSettings.invitedUntil", {
                      date: new Date(i.expiresAt).toLocaleDateString(),
                    })}
                  </div>
                </div>
                <Chip tone="warn">
                  {t("organization.invited")} · {t(`organization.role.${i.role}`)}
                </Chip>
                {manage && (owner || i.role !== "owner") ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    busy={cancel.isPending && cancel.variables === i.id}
                    onClick={() => cancel.mutate(i.id)}
                  >
                    {t("orgSettings.withdraw")}
                  </Button>
                ) : null}
              </div>
            ))}
            {data.members.length === 0 && data.invitations.length === 0 ? (
              <div className="flex items-center gap-3 text-[0.875rem] text-ink-3">
                <UserRound className="size-4" /> –
              </div>
            ) : null}
          </div>
        )}
        {error ? <p className="mt-4 text-[0.875rem] text-rose">{error}</p> : null}
      </Section>
      {contacts ? (
        <div className="flex items-center gap-3 rounded-xl bg-card p-4 ring-1 ring-border-soft">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-2">
            <Contact className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-[0.9375rem]">{t("orgSettings.contactsTitle")}</div>
            <p className="text-[0.8125rem] text-ink-3 leading-snug">
              {t("orgSettings.contactsText", { name: me.tenant.name ?? "" })}
            </p>
          </div>
          <Link
            to="/contacts"
            className="inline-flex h-8 shrink-0 items-center rounded-full border border-border bg-card px-3 font-medium text-[0.8125rem] text-ink transition hover:bg-paper-2"
          >
            {t("orgSettings.contactsOpen")}
          </Link>
        </div>
      ) : null}
      <p className="px-1 text-[0.8125rem] text-ink-3 leading-relaxed">
        {me.tenant.role === "member" ? t("organization.memberNote") : t("orgSettings.rolesNote")}
      </p>
      {data && data.members.some((m) => m.userId !== me.user.id) ? <LeaveSection me={me} /> : null}
    </div>
  );
}

interface AddressState {
  slug: string;
  host: string;
  canChange: boolean;
  changeUntil: string | null;
  domains: {
    id: string;
    domain: string;
    verified: boolean;
    record: { name: string; value: string };
  }[];
}

function useAddress(me: Me) {
  return useQuery({
    queryKey: ["organization-address", me.tenant.id],
    queryFn: () => api.get<AddressState>("/api/studio/organization/address"),
  });
}

/** What a person types, as an address can hold it: lower case, hyphens for spaces. */
const asSlug = (typed: string) =>
  typed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 30);

const ADDRESS_PROBLEMS: Record<string, Key> = {
  length: "orgSettings.addressProblem.length",
  chars: "orgSettings.addressProblem.chars",
  hyphen: "orgSettings.addressProblem.hyphen",
  reserved: "orgSettings.addressProblem.reserved",
  profanity: "orgSettings.addressProblem.profanity",
  brand: "orgSettings.addressProblem.brand",
  taken: "orgSettings.addressProblem.taken",
};

/**
 * The addresses of the studio and of the published wizards. The creator changes it once in the
 * organization's first 14 days; the studio then moves to the new address.
 */
function AddressSection({ me, studioUrl }: { me: Me; studioUrl: string | null }) {
  const address = useAddress(me);
  const [typed, setTyped] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const a = address.data;
  const slug = typed ?? a?.slug ?? "";
  const changed = a ? slug !== a.slug : false;
  const check = useQuery({
    queryKey: ["organization-address-check", slug],
    queryFn: () =>
      api.get<{ ok: boolean; code?: string }>(
        `/api/studio/organization/address/check?slug=${encodeURIComponent(slug)}`,
      ),
    enabled: changed && slug.length > 0,
  });
  const save = useMutation({
    mutationFn: () => api.put<AddressState>("/api/studio/organization/address", { slug }),
    // The studio lives at the organization's address: it follows the new one.
    onSuccess: (next) => window.location.assign(`/studio/${next.slug}/settings/general`),
  });
  const problem = changed && check.data && !check.data.ok ? check.data.code : null;
  const suffix = a ? a.host.slice(a.slug.length) : "";
  return (
    <Section
      title={t("orgSettings.address")}
      hint={
        a?.canChange && a.changeUntil
          ? t("orgSettings.addressHintOpen", { date: new Date(a.changeUntil).toLocaleDateString() })
          : t("orgSettings.addressHint")
      }
    >
      {a?.canChange ? (
        <div className="mb-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center rounded-lg border border-input bg-card focus-within:border-focus focus-within:ring-4 focus-within:ring-focus-glow">
              <input
                aria-label={t("orgSettings.address")}
                className="h-11 min-w-0 flex-1 bg-transparent pl-3 font-mono text-[0.9375rem] outline-none"
                value={slug}
                maxLength={30}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setTyped(asSlug(e.target.value));
                  setConfirming(false);
                }}
              />
              <span className="shrink-0 pr-3 font-mono text-[0.9375rem] text-ink-4">{suffix}</span>
            </div>
            {changed && !confirming ? (
              <Button
                variant="secondary"
                disabled={check.data?.ok !== true}
                onClick={() => setConfirming(true)}
              >
                {t("orgSettings.addressChange")}
              </Button>
            ) : null}
          </div>
          {problem ? (
            <p className="text-[0.875rem] text-rose">
              {ADDRESS_PROBLEMS[problem] ? t(ADDRESS_PROBLEMS[problem]) : problem}
            </p>
          ) : null}
          {confirming ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-paper p-3 ring-1 ring-border-soft">
              <p className="min-w-48 flex-1 text-[0.875rem]">
                {t("orgSettings.addressConfirm", { host: `${slug}${suffix}` })}
              </p>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t("orgSettings.cancel")}
              </Button>
              <Button busy={save.isPending} onClick={() => save.mutate()}>
                {t("orgSettings.addressConfirmYes")}
              </Button>
            </div>
          ) : null}
          {save.error ? <p className="text-[0.875rem] text-rose">{refusal(save.error)}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-col divide-y divide-border-soft">
        {studioUrl ? <CopyRow label={t("orgSettings.studioAddress")} text={studioUrl} /> : null}
        {(a?.host ?? me.tenant.pagesHost) ? (
          <CopyRow
            label={t("orgSettings.pagesAddress")}
            text={a?.host ?? me.tenant.pagesHost ?? ""}
          />
        ) : null}
      </div>
    </Section>
  );
}

/** The organization's own domains, each proven by a TXT record (owners and admins). */
function DomainsSection({ me }: { me: Me }) {
  const qc = useQueryClient();
  const address = useAddress(me);
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const reload = () => qc.invalidateQueries({ queryKey: ["organization-address", me.tenant.id] });
  const add = useMutation({
    mutationFn: () => api.post("/api/studio/organization/domains", { domain }),
    onSuccess: async () => {
      setDomain("");
      setAdding(false);
      await reload();
    },
  });
  const verify = useMutation({
    mutationFn: (id: string) =>
      api.post<{ verified: boolean }>(
        `/api/studio/organization/domains/${encodeURIComponent(id)}/verify`,
      ),
    onSuccess: reload,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.del(`/api/studio/organization/domains/${encodeURIComponent(id)}`),
    onSuccess: reload,
  });
  const domains = address.data?.domains ?? [];
  return (
    <Section
      title={t("orgSettings.domains")}
      hint={t("orgSettings.domainsHint")}
      action={
        adding ? null : (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> {t("orgSettings.domainAdd")}
          </Button>
        )
      }
    >
      {adding ? (
        <form
          className="mb-4 flex flex-wrap items-center gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Input
            className="min-w-48 flex-1"
            autoFocus
            required
            value={domain}
            placeholder={t("orgSettings.domainPlaceholder")}
            aria-label={t("orgSettings.domains")}
            onChange={(e) => setDomain(e.target.value)}
          />
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
            {t("orgSettings.cancel")}
          </Button>
          <Button type="submit" busy={add.isPending}>
            {t("orgSettings.domainAdd")}
          </Button>
        </form>
      ) : null}
      {domains.length ? (
        <div className="flex flex-col divide-y divide-border-soft">
          {domains.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-2">
                <Globe className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.9375rem]">{d.domain}</div>
                {d.verified ? null : (
                  <div className="break-all font-mono text-[0.75rem] text-ink-3">
                    TXT {d.record.name} = {d.record.value}
                  </div>
                )}
              </div>
              {d.verified ? (
                <Chip tone="live">{t("orgSettings.domainVerified")}</Chip>
              ) : (
                <>
                  <Chip tone="warn">{t("orgSettings.domainWaiting")}</Chip>
                  <Button
                    variant="secondary"
                    size="sm"
                    busy={verify.isPending && verify.variables === d.id}
                    onClick={() => verify.mutate(d.id)}
                  >
                    {t("orgSettings.domainCheck")}
                  </Button>
                </>
              )}
              <IconButton
                label={t("orgSettings.domainRemove", { domain: d.domain })}
                onClick={() => remove.mutate(d.id)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </div>
      ) : adding ? null : (
        <p className="text-[0.875rem] text-ink-3">{t("orgSettings.domainsNone")}</p>
      )}
      {verify.data && !verify.data.verified ? (
        <p className="mt-3 text-[0.875rem] text-ink-3">{t("orgSettings.domainNotYet")}</p>
      ) : null}
      {refusal(add.error ?? verify.error ?? remove.error) ? (
        <p className="mt-3 text-[0.875rem] text-rose">
          {refusal(add.error ?? verify.error ?? remove.error)}
        </p>
      ) : null}
    </Section>
  );
}

interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: string;
  lastRequest: string | null;
}

/**
 * Settings › API-Keys: the person's keys for scripts and apps without a sign-in. A key acts as
 * its creator, in this organization; its secret shows once.
 */
export function OrganizationKeys({ me }: { me: Me }) {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ["organization-keys", me.tenant.id],
    queryFn: () => api.get<{ keys: ApiKeyRow[] }>("/api/studio/organization/keys"),
  });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ id: string; name: string; key: string } | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["organization-keys", me.tenant.id] });
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; name: string; key: string }>("/api/studio/organization/keys", {
        name: name.trim(),
      }),
    onSuccess: async (made) => {
      setFresh({ id: made.id, name: made.name, key: made.key });
      setName("");
      setNaming(false);
      await reload();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/studio/organization/keys/${encodeURIComponent(id)}`),
    // A deleted key's secret no longer stands on the page.
    onSuccess: async (_, id) => {
      setFresh((now) => (now?.id === id ? null : now));
      await reload();
    },
  });
  const list = keys.data?.keys ?? [];
  return (
    <div className="flex flex-col gap-9">
      <Section
        title={t("orgSettings.keys")}
        hint={t("orgSettings.keysHint", { name: me.tenant.name ?? "" })}
        action={
          naming ? null : (
            <Button variant="secondary" size="sm" onClick={() => setNaming(true)}>
              <Plus className="size-4" /> {t("orgSettings.keyCreate")}
            </Button>
          )
        }
      >
        {fresh ? (
          <div className="mb-4 flex flex-col gap-2 rounded-lg bg-paper p-3 ring-1 ring-ember">
            <div className="font-medium text-[0.9375rem]">
              {t("orgSettings.keyNew", { name: fresh.name })}
            </div>
            <p className="text-[0.8125rem] text-ink-3">{t("orgSettings.keyOnce")}</p>
            <CopyRow label={t("orgSettings.keys")} text={fresh.key} />
          </div>
        ) : null}
        {naming ? (
          <form
            className="mb-4 flex flex-wrap items-center gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Input
              className="min-w-48 flex-1"
              autoFocus
              required
              maxLength={32}
              value={name}
              placeholder={t("orgSettings.keyNamePlaceholder")}
              aria-label={t("orgSettings.keyName")}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="button" variant="ghost" onClick={() => setNaming(false)}>
              {t("orgSettings.cancel")}
            </Button>
            <Button type="submit" busy={create.isPending}>
              {t("orgSettings.keyCreate")}
            </Button>
          </form>
        ) : null}
        {keys.isPending ? (
          <Spinner />
        ) : list.length ? (
          <div className="flex flex-col divide-y divide-border-soft">
            {list.map((k) => (
              <div key={k.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-2">
                  <KeyRound className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.9375rem]">{k.name ?? k.start}</div>
                  <div className="truncate text-[0.8125rem] text-ink-3">
                    {k.lastRequest
                      ? t("orgSettings.keyUsed", { date: new Date(k.lastRequest).toLocaleString() })
                      : t("orgSettings.keyNeverUsed")}
                  </div>
                </div>
                <IconButton
                  label={t("orgSettings.keyDelete", { name: k.name ?? "" })}
                  onClick={() => remove.mutate(k.id)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
        ) : naming ? null : (
          <p className="text-[0.875rem] text-ink-3">{t("orgSettings.keysNone")}</p>
        )}
        {refusal(create.error ?? remove.error) ? (
          <p className="mt-3 text-[0.875rem] text-rose">{refusal(create.error ?? remove.error)}</p>
        ) : null}
      </Section>
    </div>
  );
}
