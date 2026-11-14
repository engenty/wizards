import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserRound, Users, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { type Me, type Space, useMe } from "../../lib/session";
import { Button, cn, Dialog, IconButton, Input, Switch } from "../../ui";
import { spaceLabel } from "../SpacePath";

/*
 * Sharing a space (docs/plans/org-spaces.md, behind `orgSpaces`): every member of the
 * organization sees a space under the root, or only the people chosen; a client is an outside
 * person who signs in on the firm's page and sees only the spaces shared with them. Inviting
 * clients needs `clientSpaces`.
 */

interface Member {
  userId: string | null;
  email: string | null;
  role: "member" | "client";
}

/** Whether the space can be shared here: not the root, not Mein Space, and the person is an admin. */
export function shareable(me: Me | undefined, space: Space | null): boolean {
  return Boolean(
    me &&
      space &&
      !space.root &&
      !space.personal &&
      !space.readOnly &&
      (me.tenant.role === "owner" || me.tenant.role === "admin"),
  );
}

/** The foot of Work's sidebar: the space, who is in it, and "Teilen". */
export function SpaceFoot({ space }: { space: Space }) {
  const me = useMe().data;
  const [open, setOpen] = useState(false);
  // On a computer alone there is nobody to share with: no foot.
  if (me?.mode !== "managed") {
    return null;
  }
  const share = shareable(me, space);
  return (
    <div className="mt-auto flex items-center gap-2.5 border-border-soft border-t px-1.5 pt-2.5 pb-1">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-paper-3 text-ink-2 ring-1 ring-border">
        <Users className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate font-medium text-[0.8125rem] text-ink">
          {spaceLabel(me, space)}
        </span>
        <span className="truncate text-[0.75rem] text-ink-3">
          {space.personal
            ? t("nav.spaceMine")
            : space.clients
              ? t("nav.spaceClients", { n: space.clients })
              : space.access === "members"
                ? t("share.whoMembers")
                : t("share.everyone")}
        </span>
      </span>
      {share ? (
        <Button variant="ghost" onClick={() => setOpen(true)}>
          {t("share.title")}
        </Button>
      ) : null}
      {share ? (
        <ShareSpaceDialog me={me} space={space} open={open} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * Who of the organization sees a space: everyone, or only the people chosen. Asked in „Neuer
 * Space“ and changed in Teilen (docs/plans/org-spaces.md).
 */
export function WhoSees({
  value,
  organization,
  onChange,
  disabled,
  here = false,
}: {
  value: "all" | "members";
  organization: string;
  onChange: (value: "all" | "members") => void;
  disabled?: boolean;
  /** In Teilen itself, where the people are chosen below. */
  here?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium text-[0.875rem] text-ink">{t("share.who")}</legend>
      {(["all", "members"] as const).map((v) => (
        <label
          key={v}
          className={cn(
            "flex cursor-pointer items-start gap-2.5 rounded-lg p-2.5 ring-1 transition",
            value === v ? "bg-background ring-ember/50" : "ring-border-soft hover:bg-ink/5",
          )}
        >
          <input
            type="radio"
            name={name}
            checked={value === v}
            disabled={disabled}
            onChange={() => onChange(v)}
            className="mt-0.5 accent-ember"
          />
          <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="text-[0.875rem] text-ink">
              {v === "all" ? t("share.whoAll", { organization }) : t("share.whoMembers")}
            </span>
            <span className="text-[0.75rem] text-ink-3">
              {v === "all"
                ? t("share.whoAllHint")
                : here
                  ? t("share.whoMembersHere")
                  : t("share.whoMembersHint")}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

interface Person {
  userId: string;
  name: string;
  email: string;
  role: string;
}

/** Who is in the space, and an invitation for a client. */
function ShareSpaceDialog({
  me,
  space,
  open,
  onClose,
}: {
  me: Me;
  space: Space;
  open: boolean;
  onClose: () => void;
}) {
  const clientsOn = useFeature("clientSpaces");
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const organization = me.tenant.name || t("nav.space");
  const members = useQuery({
    queryKey: ["space-members", space.id],
    queryFn: () => api.get<{ members: Member[] }>(`/api/studio/spaces/${space.id}/members`),
    enabled: open,
  });
  const chosen = space.access === "members";
  const people = useQuery({
    queryKey: ["organization", me.tenant.id],
    queryFn: () => api.get<{ members: Person[] }>("/api/studio/organization"),
    enabled: open,
  });
  const access = useMutation({
    mutationFn: (value: "all" | "members") =>
      api.patch(`/api/studio/spaces/${space.id}`, { access: value }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.spaces() });
      await qc.invalidateQueries({ queryKey: ["space-members", space.id] });
    },
  });
  const person = useMutation({
    mutationFn: ({ userId, inside }: { userId: string; inside: boolean }) =>
      inside
        ? api.put(`/api/studio/spaces/${space.id}/members/${userId}`, { role: "member" })
        : api.del(`/api/studio/spaces/${space.id}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["space-members", space.id] }),
  });
  const inside = new Set(
    (members.data?.members ?? []).filter((m) => m.role === "member").map((m) => m.userId),
  );
  const invite = useMutation({
    mutationFn: (address: string) =>
      api.post(`/api/studio/spaces/${space.id}/invite`, { email: address, lang }),
    onSuccess: async () => {
      setEmail("");
      await qc.invalidateQueries({ queryKey: ["space-members", space.id] });
      await qc.invalidateQueries({ queryKey: keys.spaces() });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      invite.mutate(email.trim());
    }
  };
  const clients = (members.data?.members ?? []).filter((m) => m.role === "client");
  const remove = useMutation({
    mutationFn: (userId: string) => api.del(`/api/studio/spaces/${space.id}/members/${userId}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["space-members", space.id] });
      await qc.invalidateQueries({ queryKey: keys.spaces() });
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("share.dialogTitle", { name: space.name })}>
      <p className="-mt-2 text-[0.875rem] text-ink-2">
        {chosen ? t("share.membersOnlySee") : t("share.membersSee", { organization })}
      </p>
      <div className="mt-4">
        <WhoSees
          value={space.access}
          organization={organization}
          disabled={access.isPending}
          here
          onChange={(value) => access.mutate(value)}
        />
      </div>
      {/* Always there, so the dialog keeps its height: all on while everyone sees the space. */}
      <div className="mt-4">
        <div className="mb-1.5 font-medium text-[0.875rem] text-ink">{t("share.people")}</div>
        <ul className="flex max-h-56 flex-col overflow-y-auto">
          {(people.data?.members ?? [])
            .filter((p) => p.role !== "client")
            .map((p) => (
              <li
                key={p.userId}
                className="flex items-center gap-2.5 border-border-soft border-b py-2 text-[0.875rem] last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate">{p.name || p.email}</span>
                {p.userId === me.user.id ? (
                  <span className="text-[0.75rem] text-ink-4">{t("share.you")}</span>
                ) : null}
                <Switch
                  checked={!chosen || inside.has(p.userId)}
                  disabled={!chosen || p.userId === me.user.id || person.isPending}
                  label={p.name || p.email}
                  onChange={(on) => person.mutate({ userId: p.userId, inside: on })}
                />
              </li>
            ))}
        </ul>
      </div>
      {clientsOn ? (
        <>
          <form onSubmit={submit} className="mt-4 flex gap-2">
            <Input
              id={`share-${space.id}`}
              type="email"
              value={email}
              maxLength={254}
              placeholder={t("share.clientEmail")}
              aria-label={t("share.clientEmail")}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              busy={invite.isPending}
              disabled={!email.trim()}
            >
              {t("share.inviteClient")}
            </Button>
          </form>
          {invite.error ? (
            <p className="mt-2 text-[0.8125rem] text-rose">{(invite.error as Error).message}</p>
          ) : null}
          <ul className="mt-4 flex flex-col">
            {clients.map((m) => (
              <li
                key={m.userId ?? m.email}
                className="flex items-center gap-2.5 border-border-soft border-b py-2 text-[0.875rem] last:border-b-0"
              >
                <UserRound className="size-4 shrink-0 text-violet-700 dark:text-violet-300" />
                <span className="min-w-0 flex-1 truncate">{m.email ?? m.userId}</span>
                <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[0.75rem] text-violet-700 dark:text-violet-300">
                  {m.userId ? t("share.client") : t("share.invited")}
                </span>
                {m.userId ? (
                  <IconButton
                    label={t("share.removeClient", { name: m.email ?? "" })}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(m.userId as string)}
                  >
                    <X className="size-4" />
                  </IconButton>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.8125rem] text-ink-3">{t("share.clientsSee")}</p>
        </>
      ) : null}
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("share.done")}</Button>
      </div>
    </Dialog>
  );
}
