import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UsersRound } from "lucide-react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import type { Space, WizardSummary } from "../../lib/session";
import { Switch } from "../../ui";
import { Section } from "./Section";

/*
 * What of the organization's own space its client spaces reach (docs/plans/org-spaces.md): the
 * wizards its clients may start, and „Für Kunden sichtbar“ on an item of its Knowledge. A client
 * space's own Knowledge and wizards are its clients' already. Admins only, behind `clientSpaces`.
 */

type Open = Record<"document" | "table" | "page" | "wizard", string[]>;

const openKey = (spaceId: string) => ["open-to-clients", spaceId];

/** Which of the organization's published wizards clients may start in their client space: a rule each. */
export function ClientWizards({ space }: { space: Space }) {
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
 * „Für Kunden sichtbar“ on an item of the organization's Knowledge: clients read it in their client
 * space. Off by default; a rule of the space when on.
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
