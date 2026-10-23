import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Contact, Copy, MailPlus, Trash2, UserRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ApiError, api } from "../lib/api";
import { type Key, t } from "../lib/i18n";
import { initialsOf, type Me } from "../lib/session";
import { useStudioPlugins } from "../plugins/host";
import { Button, Chip, IconButton, Input, Select, Spinner, useAutosave } from "../ui";
import { Section } from "./project/Section";

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

/**
 * Settings › Allgemein: the organization's name, saved as it is typed (owners and admins), its
 * addresses, and leaving it.
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
  const [leaving, setLeaving] = useState(false);
  const leave = useMutation({
    mutationFn: () => api.del(`/api/studio/organization/members/${encodeURIComponent(me.user.id)}`),
    // The studio's sign-in still names this organization: a new one goes to another.
    onSuccess: () => window.location.assign("/api/auth/login"),
  });
  const studioUrl = me.tenant.slug ? `${window.location.origin}/studio/${me.tenant.slug}/` : null;
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
      {studioUrl || me.tenant.pagesHost ? (
        <Section title={t("orgSettings.address")} hint={t("orgSettings.addressHint")}>
          <div className="flex flex-col divide-y divide-border-soft">
            {studioUrl ? <CopyRow label={t("orgSettings.studioAddress")} text={studioUrl} /> : null}
            {me.tenant.pagesHost ? (
              <CopyRow label={t("orgSettings.pagesAddress")} text={me.tenant.pagesHost} />
            ) : null}
          </div>
        </Section>
      ) : null}
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
    </div>
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
    </div>
  );
}
