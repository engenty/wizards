import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserRound, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { type Me, type Space, useMe } from "../../lib/session";
import { Button, Dialog, Input } from "../../ui";
import { spaceLabel } from "../SpacePath";

/*
 * Sharing a space (docs/plans/org-spaces.md, behind `orgSpaces`): every member of the
 * organization sees a space under the root; a Kund:in is an outside person who signs in on the
 * firm's page and sees only the spaces shared with them. Inviting Kund:innen needs `clientSpaces`.
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

/** Who is in the space, and an invitation for a Kund:in. */
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
  const members = useQuery({
    queryKey: ["space-members", space.id],
    queryFn: () => api.get<{ members: Member[] }>(`/api/studio/spaces/${space.id}/members`),
    enabled: open && clientsOn,
  });
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
  return (
    <Dialog open={open} onClose={onClose} title={t("share.dialogTitle", { name: space.name })}>
      <p className="-mt-2 text-[0.875rem] text-ink-2">
        {t("share.membersSee", { organization: me.tenant.name || t("nav.space") })}
      </p>
      {clientsOn ? (
        <>
          <form onSubmit={submit} className="mt-4 flex gap-2">
            <Input
              id={`share-${space.id}`}
              type="email"
              value={email}
              maxLength={254}
              placeholder={t("clients.invitePlaceholder")}
              aria-label={t("clients.invitePlaceholder")}
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
                  {m.userId ? t("clients.roleClient") : t("clients.invited")}
                </span>
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
