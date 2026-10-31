import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Trash2, UsersRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import type { Space, WizardSummary } from "../../lib/session";
import { Button, cn, IconButton, Input, Switch } from "../../ui";
import { Section } from "./Section";

/**
 * The space's part „Kunden“ (docs/plans/client-spaces.md): its client spaces, each a client's own
 * data, results and chats under the space, and which of the space's wizards its clients may
 * start. Admins only, behind `clientSpaces`.
 */

interface ClientSpaceRow {
  id: string;
  name: string;
  createdAt: string;
  clients: number;
  members: number;
}

interface Member {
  userId: string;
  role: "member" | "client";
}

type Open = Record<"document" | "table" | "page" | "wizard", string[]>;

const clientsKey = (spaceId: string) => ["client-spaces", spaceId];
const openKey = (spaceId: string) => ["open-to-clients", spaceId];

export function ClientSpaces({ space }: { space: Space }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: clientsKey(space.id),
    queryFn: () => api.get<{ clients: ClientSpaceRow[] }>(`/api/studio/spaces/${space.id}/clients`),
  });
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (value: string) =>
      api.post<{ id: string }>(`/api/studio/spaces/${space.id}/clients`, { name: value }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: clientsKey(space.id) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      create.mutate(name.trim());
    }
  };
  const clients = list.data?.clients ?? [];
  return (
    <div className="flex flex-col gap-9">
      <Section title={t("clients.title")} hint={t("clients.hint")} locked={space.readOnly}>
        <div className="flex flex-col gap-3">
          <form onSubmit={submit} className="flex gap-2">
            <Input
              id="client-space-name"
              value={name}
              maxLength={200}
              placeholder={t("clients.newPlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {t("clients.new")}
            </Button>
          </form>
          {create.error ? (
            <p className="text-[0.8125rem] text-danger">{(create.error as Error).message}</p>
          ) : null}
          {list.isSuccess && !clients.length ? (
            <p className="text-[0.875rem] text-ink-3">{t("clients.empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-soft">
              {clients.map((c) => (
                <ClientRow key={c.id} spaceId={space.id} client={c} />
              ))}
            </ul>
          )}
        </div>
      </Section>
      <ClientWizards space={space} />
    </div>
  );
}

/** One client space: opens to who is in it, and closes it. */
function ClientRow({ spaceId, client }: { spaceId: string; client: ClientSpaceRow }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const members = useQuery({
    queryKey: ["space-members", client.id],
    queryFn: () => api.get<{ members: Member[] }>(`/api/studio/spaces/${client.id}/members`),
    enabled: open,
  });
  const close = useMutation({
    mutationFn: () => api.del(`/api/studio/spaces/${client.id}/client`),
    onSuccess: () => qc.invalidateQueries({ queryKey: clientsKey(spaceId) }),
  });
  return (
    <li className="py-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn("size-4 shrink-0 text-ink-4 transition-transform", open && "rotate-90")}
          />
          <UsersRound className="size-4 shrink-0 text-ink-3" />
          <span className="truncate font-medium text-[0.9375rem]">{client.name}</span>
          <span className="shrink-0 text-[0.8125rem] text-ink-4">
            {t("clients.counts", { clients: client.clients, members: client.members })}
          </span>
        </button>
        <IconButton
          label={t("clients.close", { name: client.name })}
          onClick={() => {
            if (window.confirm(t("clients.closeConfirm", { name: client.name }))) {
              close.mutate();
            }
          }}
        >
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      {open ? (
        <div className="mt-2 ml-8 flex flex-col gap-1 text-[0.875rem]">
          {members.data?.members.length ? (
            members.data.members.map((m) => (
              <div key={m.userId} className="flex items-center gap-2 text-ink-2">
                <span className="truncate">{m.userId}</span>
                <span className="text-ink-4">
                  {m.role === "client" ? t("clients.roleClient") : t("clients.roleMember")}
                </span>
              </div>
            ))
          ) : (
            <p className="text-ink-3">{t("clients.noPeople")}</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** Which of the space's published wizards its clients may start: a rule each. */
function ClientWizards({ space }: { space: Space }) {
  const qc = useQueryClient();
  const wizards = useQuery({
    queryKey: ["space-wizards", space.id],
    queryFn: () => api.get<WizardSummary[]>(`/api/studio/spaces/${space.id}/wizards`),
  });
  const open = useQuery({
    queryKey: openKey(space.id),
    queryFn: () => api.get<{ open: Open }>(`/api/studio/spaces/${space.id}/open-to-clients`),
  });
  const set = useMutation({
    mutationFn: (v: { id: string; open: boolean }) =>
      api.put(`/api/studio/spaces/${space.id}/open-to-clients`, { kind: "wizard", ...v }),
    onSettled: () => qc.invalidateQueries({ queryKey: openKey(space.id) }),
  });
  const published = (wizards.data ?? []).filter((w) => w.published);
  const opened = new Set(open.data?.open.wizard ?? []);
  return (
    <Section title={t("clients.wizards")} hint={t("clients.wizardsHint")} locked={space.readOnly}>
      {wizards.isSuccess && !published.length ? (
        <p className="text-[0.875rem] text-ink-3">{t("clients.noWizards")}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border-soft">
          {published.map((w) => (
            <div key={w.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[0.9375rem]">{w.title}</span>
              <Switch
                checked={opened.has(w.id)}
                onChange={(on: boolean) => set.mutate({ id: w.id, open: on })}
                label={w.title}
              />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/**
 * „Für Kunden sichtbar“ on an item of the space's Knowledge: its clients read it from their client
 * spaces. Off by default; a rule of the space when on.
 */
export function OpenToClients({
  spaceId,
  kind,
  id,
}: {
  spaceId: string;
  kind: "page" | "table" | "document";
  id: string;
}) {
  const qc = useQueryClient();
  const open = useQuery({
    queryKey: openKey(spaceId),
    queryFn: () => api.get<{ open: Open }>(`/api/studio/spaces/${spaceId}/open-to-clients`),
  });
  const set = useMutation({
    mutationFn: (on: boolean) =>
      api.put(`/api/studio/spaces/${spaceId}/open-to-clients`, { kind, id, open: on }),
    onSettled: () => qc.invalidateQueries({ queryKey: openKey(spaceId) }),
  });
  const on = open.data?.open[kind].includes(id) ?? false;
  return (
    <div className="flex items-center gap-3 rounded-lg bg-ink/5 px-4 py-2.5">
      <UsersRound className="size-4 shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[0.875rem]">{t("clients.openTitle")}</p>
        <p className="text-[0.8125rem] text-ink-3">
          {on ? t("clients.openOn") : t("clients.openOff")}
        </p>
      </div>
      <Switch
        checked={on}
        disabled={!open.isSuccess || set.isPending}
        onChange={(next: boolean) => set.mutate(next)}
        label={t("clients.openTitle")}
      />
    </div>
  );
}
