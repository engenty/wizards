import type { WizardNeedView } from "@engenty/wizards-shared/connectors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, UserRound } from "lucide-react";
import { Link } from "react-router";
import { api } from "../../lib/api";
import { type Key, t } from "../../lib/i18n";
import { Button, Chip, cn, Select, Spinner } from "../../ui";

/**
 * The wizard's needs (docs/plans/run-connections.md, step 4): per service it names, the steps
 * that use it and how a run resolves it here. An admin also chooses the space's connection for
 * runs nobody watches, changes it or clears it; where the space has none, the row links to
 * Capabilities › Connectors. Members see the needs without the choice.
 */
export function NeedsSection({ wizardId }: { wizardId: string }) {
  const key = ["wizard-needs", wizardId];
  const needs = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ needs: WizardNeedView[] }>(`/api/studio/wizards/${wizardId}/needs`),
  });
  if (!needs.data) {
    return needs.isError ? (
      <p className="text-[0.8125rem] text-rose">{t("needs.failed")}</p>
    ) : (
      <Spinner />
    );
  }
  return (
    <>
      <p className="text-[0.8125rem] text-ink-3">{t("needs.hint")}</p>
      {needs.data.needs.map((need) => (
        <NeedRow key={need.id} wizardId={wizardId} need={need} />
      ))}
    </>
  );
}

const STATE_CHIP: Partial<Record<WizardNeedView["here"]["state"], Key>> = {
  cannot: "needs.chip.cannot",
  choose: "needs.chip.choose",
  connect: "needs.chip.connect",
};

function hereText(here: WizardNeedView["here"]): string {
  switch (here.state) {
    case "named":
    case "chosen":
    case "only":
      return here.account.owner === "space"
        ? t("needs.usesSpace", { label: here.account.label })
        : t("needs.usesYours", { label: here.account.label });
    case "choose":
      return t("needs.choose", { n: here.count });
    case "connect":
      return t("needs.connect");
    case "cannot":
      return here.problem;
  }
}

function NeedRow({ wizardId, need }: { wizardId: string; need: WizardNeedView }) {
  const chip = STATE_CHIP[need.here.state];
  const owner = "account" in need.here ? need.here.account.owner : null;
  return (
    <div className="rounded-lg bg-paper px-3 py-2.5 ring-1 ring-border-soft">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[0.875rem]">
          {need.name ?? t(`editor.connections.${need.kind ?? "mail"}` as Key)}
        </div>
        {chip ? (
          <Chip tone={need.here.state === "cannot" ? "warn" : "neutral"}>{t(chip)}</Chip>
        ) : null}
      </div>
      {need.steps.length ? (
        <div className="text-[0.75rem] text-ink-4">
          {t("needs.steps", { steps: need.steps.map((s) => `„${s.title}“`).join(", ") })}
          {need.unavoidable ? null : ` · ${t("needs.somePaths")}`}
        </div>
      ) : null}
      <div
        className={cn(
          "mt-1.5 flex items-start gap-1.5 text-[0.8125rem]",
          need.here.state === "cannot" ? "text-ember" : "text-ink-3",
        )}
      >
        {owner === "space" ? (
          <Building2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        ) : owner === "person" ? (
          <UserRound className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        ) : null}
        <span>{hereText(need.here)}</span>
      </div>
      {need.space ? <SpaceChoice wizardId={wizardId} need={need} /> : null}
    </div>
  );
}

/** The admins' choice of the space's connection for runs nobody watches. */
function SpaceChoice({ wizardId, need }: { wizardId: string; need: WizardNeedView }) {
  const qc = useQueryClient();
  const path = `/api/studio/wizards/${wizardId}/needs/${encodeURIComponent(need.id)}/space-choice`;
  const save = useMutation({
    mutationFn: (connection: string | null) =>
      connection ? api.put(path, { connection }) : api.del(path),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["wizard-needs", wizardId] }),
        qc.invalidateQueries({ queryKey: ["wizard-models", wizardId] }),
      ]),
  });
  const space = need.space;
  if (!space) {
    return null;
  }
  const chosen = save.isPending ? save.variables : space.chosen;
  return (
    <div className="mt-2.5 border-border-soft border-t pt-2.5">
      <div className="font-medium text-[0.75rem] text-ink-3">{t("needs.unwatched")}</div>
      <p className="mb-2 text-[0.75rem] text-ink-4">{t("needs.unwatchedHint")}</p>
      {space.options.length ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Select
              value={chosen ?? ""}
              onChange={(v) => save.mutate(v || null)}
              options={[
                ...(chosen ? [] : [{ value: "", label: t("needs.notChosen") }]),
                ...space.options.map((o) => ({
                  value: o.id,
                  label: `${o.connectorName} · ${o.label}`,
                })),
              ]}
            />
          </div>
          {chosen ? (
            <Button
              size="sm"
              variant="quiet"
              busy={save.isPending && save.variables === null}
              onClick={() => save.mutate(null)}
            >
              {t("needs.clear")}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-ink-3">
          <span>{t("needs.noSpaceConnection")}</span>
          <Link to="/capabilities/connectors" className="text-ember hover:underline">
            {t("needs.setUp")}
          </Link>
        </div>
      )}
      {save.isError ? (
        <p className="mt-1.5 text-[0.75rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </div>
  );
}
