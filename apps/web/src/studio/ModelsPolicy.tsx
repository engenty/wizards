/**
 * Settings › Models › how the organization's admins share out its model tier (`modelPolicy`):
 * who picks the model (way A/B/C), where models may run and masking (Who chooses), the lists of
 * way C (Approved models) and the defaults of way B (Defaults). Saved through the runtime at the
 * Manage-App. Behind `modelTiers` (docs/manage-contract.md, "Model tiers").
 */
import { EFFORTS, type Effort } from "@engenty/wizards-shared/definition";
import {
  type ModelPolicy,
  type ModelTier,
  type Purpose,
  type PurposePolicy,
  splitClassId,
} from "@engenty/wizards-shared/tiers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Coins,
  EyeOff,
  KeyRound,
  Laptop,
  ListChecks,
  Lock,
  type LucideIcon,
  MessageCircle,
  Plug,
  Sparkles,
  TerminalSquare,
  Users,
  Wand2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useFeatures } from "../lib/features";
import { type Key, t } from "../lib/i18n";
import { Card, cn, Segmented, Select, Switch } from "../ui";
import { Hint, PanelHead, Part } from "./models-parts";
import { approved, offered, pickable, reasonText, tierClassLabel } from "./tiers";

const OPEN: PurposePolicy = { models: null, default: null, effortCap: null, efforts: null };

/** Where an organization stands before its admins saved a policy: way A, everything as today. */
export const DEFAULT_POLICY: ModelPolicy = {
  way: "A",
  purposes: { wizard: OPEN, assistant: OPEN, work: OPEN },
  credits: true,
  ownKeys: true,
  subscriptions: true,
  localModels: true,
  apps: { local: true, subscriptions: true },
  masking: false,
};

/** The purposes people see: work chats only once the Work mode is on. */
export function usePurposes(): Purpose[] {
  // The Work mode's switch (`workMode`) comes with it; until then the tab stays away.
  const workMode = useFeatures().workMode === true;
  return workMode ? ["wizard", "assistant", "work"] : ["wizard", "assistant"];
}

const PURPOSE_ICON: Record<Purpose, LucideIcon> = {
  wizard: Wand2,
  assistant: Sparkles,
  work: MessageCircle,
};

export function useSavePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (modelPolicy: ModelPolicy) => api.put("/api/studio/model-policy", modelPolicy),
    onSuccess: (state) => qc.setQueryData(["models"], state),
  });
}

/** The way's name, short, for the menu: "engenty decides", "defaults", "approved only". */
export function wayShort(way: ModelPolicy["way"]): string {
  return t(`policy.wayShort.${way}`);
}

function Locked({ children }: { children: string }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-paper-2 px-2.5 text-[0.75rem] text-ink-3">
      <Lock className="size-3" />
      {children}
    </span>
  );
}

/** A switch of the policy: an icon, what it is, why, and the switch; locked where the tier says no. */
function PolicyRow({
  icon: Icon,
  title,
  hint,
  checked,
  locked,
  note,
  disabled,
  onChange,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  checked: boolean;
  locked?: string | null;
  /** A word beside the title: "recommended on EU Private". */
  note?: string | null;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-border-soft border-t py-3 first:border-t-0",
        locked && "-mx-3 rounded-lg bg-paper-2/60 px-3",
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-paper-2 text-ink-3">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-[0.875rem]">{title}</span>
          {locked ? <Locked>{locked}</Locked> : null}
          {note ? (
            <span className="inline-flex h-6 items-center rounded-full bg-cobalt-tint px-2.5 text-[0.75rem] text-cobalt">
              {note}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-[0.8125rem] text-ink-3">{hint}</p>
      </div>
      <Switch
        checked={checked && !locked}
        disabled={disabled || Boolean(locked)}
        onChange={onChange}
        label={title}
      />
    </div>
  );
}

/** I: who picks the model, where models may run, and masking. */
export function WayPanel({
  tier,
  policy,
  organization,
  canEdit,
}: {
  tier: ModelTier;
  policy: ModelPolicy;
  organization: string | null;
  canEdit: boolean;
}) {
  const save = useSavePolicy();
  const shown = save.isPending && save.variables ? save.variables : policy;
  const set = (patch: Partial<ModelPolicy>) => save.mutate({ ...shown, ...patch });
  const notIn = t("policy.notIn", { tier: tier.name });
  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        icon={Users}
        title={t("policy.way")}
        lead={t("policy.wayLead", {
          organization: organization ?? t("policy.yourOrganization"),
          tier: tier.name,
        })}
        status={<WayChip way={shown.way} />}
      />
      <Card className="flex flex-col gap-6 p-5 sm:p-6">
        <Part title={t("policy.whoPicks")}>
          <div className="grid gap-2.5 sm:grid-cols-3">
            {(["A", "B", "C"] as const).map((way) => (
              <button
                key={way}
                type="button"
                aria-pressed={shown.way === way}
                disabled={!canEdit}
                onClick={() => set({ way })}
                className={cn(
                  "flex flex-col gap-1.5 rounded-xl border p-4 text-left transition",
                  shown.way === way
                    ? "border-ember ring-1 ring-ember"
                    : "border-border-soft hover:border-ink-4",
                  !canEdit && "cursor-default hover:border-border-soft",
                )}
              >
                <span className="flex items-center justify-between">
                  <span className="font-medium text-[0.75rem] text-ink-3">{way}</span>
                  <span
                    className={cn(
                      "size-4 rounded-full border",
                      shown.way === way ? "border-[5px] border-ember" : "border-ink-4",
                    )}
                  />
                </span>
                <span className="font-medium text-[0.9375rem]">{t(`policy.way.${way}`)}</span>
                <span className="text-[0.8125rem] text-ink-3">{t(`policy.way.${way}.hint`)}</span>
              </button>
            ))}
          </div>
        </Part>
        <Part
          title={t("policy.where")}
          aside={
            <span className="text-[0.75rem] text-ink-3">
              {t("policy.whereAside", { tier: tier.name })}
            </span>
          }
        >
          <div>
            <PolicyRow
              icon={Coins}
              title={t("policy.credits")}
              hint={t("policy.credits.hint")}
              checked
              disabled
              onChange={() => {}}
            />
            <PolicyRow
              icon={Laptop}
              title={t("policy.localModels")}
              hint={t("policy.localModels.hint")}
              checked={shown.localModels}
              disabled={!canEdit}
              onChange={(localModels) => set({ localModels })}
            />
            <PolicyRow
              icon={KeyRound}
              title={t("policy.ownKeys")}
              hint={t("policy.ownKeys.hint")}
              checked={shown.ownKeys}
              locked={tier.rules.ownKeys ? null : notIn}
              disabled={!canEdit}
              onChange={(ownKeys) => set({ ownKeys })}
            />
            <PolicyRow
              icon={TerminalSquare}
              title={t("policy.subscriptions")}
              hint={t("policy.subscriptions.hint")}
              checked={shown.subscriptions}
              locked={tier.rules.zdr ? notIn : null}
              disabled={!canEdit}
              onChange={(subscriptions) => set({ subscriptions })}
            />
          </div>
        </Part>
        <Part title={t("policy.personalData")}>
          <div>
            <PolicyRow
              icon={EyeOff}
              title={t("policy.masking")}
              hint={t("policy.masking.hint")}
              checked={shown.masking}
              note={tier.rules.regions ? t("policy.recommendedOn", { tier: tier.name }) : null}
              disabled={!canEdit}
              onChange={(masking) => set({ masking })}
            />
          </div>
        </Part>
        {save.error ? (
          <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
        ) : null}
      </Card>
    </div>
  );
}

function WayChip({ way }: { way: ModelPolicy["way"] }) {
  return (
    <span className="inline-flex h-7 items-center rounded-full bg-cobalt-tint px-3 font-medium text-[0.75rem] text-cobalt">
      {t(`policy.way.${way}`)}
    </span>
  );
}

/** The purposes as tabs, each with how many entries it has. */
function PurposeTabs({
  purposes,
  count,
}: {
  purposes: Purpose[];
  count: (p: Purpose) => ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const current = purposeOf(params.get("for"), purposes);
  return (
    <div className="flex flex-wrap gap-2" role="tablist">
      {purposes.map((p) => {
        const Icon = PURPOSE_ICON[p];
        return (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={current === p}
            onClick={() =>
              setParams((prev) => ({ ...Object.fromEntries(prev), for: p }), { replace: true })
            }
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[0.8125rem] transition",
              current === p
                ? "border-ember bg-ember-tint font-medium text-ink"
                : "border-border-soft text-ink-2 hover:border-ink-4",
            )}
          >
            <Icon className="size-3.5" />
            {t(`policy.purpose.${p}`)}
            <span className="text-ink-3">{count(p)}</span>
          </button>
        );
      })}
    </div>
  );
}

function purposeOf(value: string | null, purposes: Purpose[]): Purpose {
  return purposes.find((p) => p === value) ?? "wizard";
}

/** J: way C's list per purpose: which classes people may pick, with which efforts, and the default. */
export function ApprovedPanel({
  tier,
  policy,
  canEdit,
}: {
  tier: ModelTier;
  policy: ModelPolicy;
  canEdit: boolean;
}) {
  const save = useSavePolicy();
  const shown = save.isPending && save.variables ? save.variables : policy;
  const purposes = usePurposes();
  const [params] = useSearchParams();
  const purpose = purposeOf(params.get("for"), purposes);
  const current = shown.purposes[purpose];
  const list = approved(tier, current);
  const setPurpose = (patch: Partial<PurposePolicy>) =>
    save.mutate({
      ...shown,
      purposes: { ...shown.purposes, [purpose]: { ...current, ...patch } },
    });
  const effortsOf = (id: string): Effort[] => current.efforts?.[id] ?? [...EFFORTS];
  const toggle = (id: string, on: boolean) => {
    const models = on ? [...list, id] : list.filter((m) => m !== id);
    setPurpose({
      models,
      default: current.default === id && !on ? null : current.default,
    });
  };
  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        icon={ListChecks}
        title={t("policy.approved")}
        lead={t("policy.approvedLead")}
        status={<WayChip way="C" />}
      />
      <PurposeTabs purposes={purposes} count={(p) => approved(tier, shown.purposes[p]).length} />
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[40rem] text-[0.8125rem]">
          <thead className="text-left text-[0.75rem] text-ink-3">
            <tr className="border-border-soft border-b">
              <th className="px-4 py-2.5 font-normal">{t("policy.col.use")}</th>
              <th className="px-2 py-2.5 font-normal">{t("policy.col.model")}</th>
              <th className="px-2 py-2.5 font-normal">{t("policy.col.runsOn")}</th>
              <th className="px-2 py-2.5 font-normal">{t("policy.col.effort")}</th>
              <th className="px-4 py-2.5 font-normal">{t("policy.col.default")}</th>
            </tr>
          </thead>
          <tbody>
            {pickable(tier).map((id) => {
              const bound = tier.classes[id];
              const on = offered(bound) && list.includes(id);
              const { maker } = splitClassId(id);
              return (
                <tr
                  key={id}
                  className={cn(
                    "border-border-soft border-b last:border-b-0",
                    !offered(bound) && "bg-paper-2/60",
                  )}
                >
                  <td className="px-4 py-3">
                    <Switch
                      checked={on}
                      disabled={!canEdit || !offered(bound)}
                      onChange={(next) => toggle(id, next)}
                      label={tierClassLabel(id)}
                    />
                  </td>
                  <td className="px-2 py-3">
                    <span className={cn("font-medium", !offered(bound) && "text-ink-3")}>
                      {tierClassLabel(id)}
                    </span>
                    <span className="block font-mono text-[0.75rem] text-ink-3">
                      {maker ? id : `${id} · ${t("policy.anyMaker")}`}
                    </span>
                  </td>
                  {offered(bound) ? (
                    <>
                      <td className="px-2 py-3">
                        {bound.name}
                        <span className="block text-[0.75rem] text-ink-3">
                          {[bound.route, bound.region].filter(Boolean).join(", ")}
                        </span>
                      </td>
                      <td className="px-2 py-3">
                        {on ? (
                          <Segmented
                            multi
                            value={effortsOf(id)}
                            options={[...EFFORTS]}
                            label={(e) => t(`class.effort.${e}` as Key)}
                            onChange={(efforts: Effort[]) =>
                              canEdit && efforts.length
                                ? setPurpose({
                                    efforts: { ...(current.efforts ?? {}), [id]: efforts },
                                  })
                                : undefined
                            }
                          />
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {on ? (
                          <label className="inline-flex items-center gap-1.5 text-ink-3">
                            <input
                              type="radio"
                              name={`default-${purpose}`}
                              checked={current.default === id}
                              disabled={!canEdit}
                              onChange={() => setPurpose({ default: id })}
                              className="accent-ember"
                            />
                            {current.default === id ? t("policy.isDefault") : null}
                          </label>
                        ) : null}
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} className="px-2 py-3 text-ink-2">
                      {t("policy.notInTier", { tier: tier.name, why: reasonText(bound) })}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Hint>{t("policy.approvedFoot")}</Hint>
      {save.error ? (
        <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </div>
  );
}

/** K: way B's default and effort cap per purpose. */
export function DefaultsPanel({
  tier,
  policy,
  canEdit,
}: {
  tier: ModelTier;
  policy: ModelPolicy;
  canEdit: boolean;
}) {
  const save = useSavePolicy();
  const shown = save.isPending && save.variables ? save.variables : policy;
  const purposes = usePurposes();
  const options = pickable(tier).filter((id) => offered(tier.classes[id]));
  const setPurpose = (purpose: Purpose, patch: Partial<PurposePolicy>) =>
    save.mutate({
      ...shown,
      purposes: { ...shown.purposes, [purpose]: { ...shown.purposes[purpose], ...patch } },
    });
  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        icon={ListChecks}
        title={t("policy.defaults")}
        lead={t("policy.defaultsLead")}
        status={<WayChip way="B" />}
      />
      <Card className="flex flex-col gap-6 p-5 sm:p-6">
        <Part title={t("policy.defaultPerTask")}>
          <div className="grid items-center gap-x-4 gap-y-3 sm:grid-cols-[8rem_minmax(0,16rem)_auto]">
            <span className="hidden text-[0.75rem] text-ink-3 sm:block">
              {t("policy.col.task")}
            </span>
            <span className="hidden text-[0.75rem] text-ink-3 sm:block">
              {t("policy.col.model")}
            </span>
            <span className="hidden text-[0.75rem] text-ink-3 sm:block">{t("policy.col.cap")}</span>
            {purposes.map((purpose) => {
              const Icon = PURPOSE_ICON[purpose];
              const current = shown.purposes[purpose];
              return (
                <div key={purpose} className="contents">
                  <span className="flex items-center gap-1.5 text-[0.875rem]">
                    <Icon className="size-3.5 text-ink-3" />
                    {t(`policy.purpose.${purpose}`)}
                  </span>
                  <Select
                    value={current.default ?? ""}
                    onChange={(value) => setPurpose(purpose, { default: value || null })}
                    options={[
                      { value: "", label: t("policy.engentyPicks") },
                      ...options.map((id) => ({
                        value: id,
                        label: splitClassId(id).maker
                          ? tierClassLabel(id)
                          : `${tierClassLabel(id)} · ${t("policy.anyMaker")}`,
                        disabled: !canEdit,
                      })),
                    ]}
                  />
                  <Segmented
                    value={current.effortCap ?? "high"}
                    options={[...EFFORTS]}
                    label={(e) => t(`class.effort.${e}` as Key)}
                    disabled={canEdit ? [] : [...EFFORTS]}
                    onChange={(effortCap: Effort) => setPurpose(purpose, { effortCap })}
                  />
                </div>
              );
            })}
          </div>
          <Hint>{t("policy.capHint")}</Hint>
        </Part>
        <Part
          title={t("policy.tierModels")}
          aside={
            <span className="text-[0.75rem] text-ink-3">
              {t("policy.tierModelsCount", { n: options.length, tier: tier.name })}
            </span>
          }
        >
          <Hint>{t("policy.tierModelsHint")}</Hint>
        </Part>
        {save.error ? (
          <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
        ) : null}
      </Card>
    </div>
  );
}

/** An app members used on a space, checked against the policy (`GET /api/studio/model-policy/apps`). */
interface CheckedApp {
  app: string;
  kind: "local" | "subscription";
  person: string | null;
  allowed: number;
  refused: number;
  at: number;
}

/** "local only": which apps may read a space, short, for the menu. */
export function appsShort(apps: ModelPolicy["apps"]): string {
  return t(
    apps.local && apps.subscriptions
      ? "policy.apps.all"
      : apps.local
        ? "policy.apps.localOnly"
        : apps.subscriptions
          ? "policy.apps.subscriptionsOnly"
          : "policy.apps.none",
  );
}

/** M: which apps may read a space over MCP, and the ones members used, allowed or refused. */
export function AppsPanel({
  tier,
  policy,
  canEdit,
}: {
  tier: ModelTier;
  policy: ModelPolicy;
  canEdit: boolean;
}) {
  const save = useSavePolicy();
  const shown = save.isPending && save.variables ? save.variables : policy;
  const setApps = (patch: Partial<ModelPolicy["apps"]>) =>
    save.mutate({ ...shown, apps: { ...shown.apps, ...patch } });
  const seen = useQuery({
    queryKey: ["model-policy-apps"],
    queryFn: () => api.get<{ apps: CheckedApp[] }>("/api/studio/model-policy/apps"),
    refetchInterval: 30_000,
  });
  const apps = seen.data?.apps ?? [];
  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        icon={Plug}
        title={t("policy.apps")}
        lead={t("policy.appsLead")}
        status={
          <span className="inline-flex h-7 items-center rounded-full bg-paper-2 px-3 font-medium text-[0.75rem] text-ink-2">
            {appsShort(shown.apps)}
          </span>
        }
      />
      <Card className="flex flex-col gap-6 p-5 sm:p-6">
        <Part title={t("policy.appsWhich")}>
          <div>
            <PolicyRow
              icon={Laptop}
              title={t("policy.apps.local")}
              hint={t("policy.apps.local.hint")}
              checked={shown.apps.local}
              locked={tier.rules.zdr ? t("policy.notIn", { tier: tier.name }) : null}
              disabled={!canEdit}
              onChange={(local) => setApps({ local })}
            />
            <PolicyRow
              icon={TerminalSquare}
              title={t("policy.apps.subscriptions")}
              hint={t("policy.apps.subscriptions.hint")}
              checked={shown.apps.subscriptions}
              locked={tier.rules.zdr ? t("policy.notIn", { tier: tier.name }) : null}
              disabled={!canEdit}
              onChange={(subscriptions) => setApps({ subscriptions })}
            />
          </div>
        </Part>
        <Part title={t("policy.appsSeen")}>
          {apps.length ? (
            <ul className="flex flex-col">
              {apps.map((a) => (
                <li
                  key={`${a.app}-${a.person ?? ""}`}
                  className="flex items-center gap-3 border-border-soft border-t py-2.5 first:border-t-0"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-[0.875rem]">{a.app}</span>
                    {a.person ? (
                      <span className="block text-[0.75rem] text-ink-3">{a.person}</span>
                    ) : null}
                  </span>
                  {a.refused ? (
                    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-amber-tint px-2.5 text-[0.75rem] text-ink-2">
                      <X className="size-3" />
                      {t("policy.appsRefused", { n: a.refused })}
                    </span>
                  ) : null}
                  {a.allowed ? (
                    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-moss-tint px-2.5 text-[0.75rem] text-moss">
                      <Check className="size-3" strokeWidth={3} />
                      {t("policy.appsAllowed")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <Hint>{t("policy.appsNone")}</Hint>
          )}
          <Hint>{t("policy.appsNote")}</Hint>
        </Part>
        {save.error ? (
          <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
        ) : null}
      </Card>
    </div>
  );
}
