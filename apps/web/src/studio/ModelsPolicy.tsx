/**
 * Settings › Models › how the organization's admins share out its model tier (`modelPolicy`):
 * who picks the model (way A/B/C), the lists of way C (Approved models) and the defaults of way B
 * (Defaults), the switches of the access pages, masking and apps in spaces. Saved through the
 * runtime at the Manage-App. Behind `modelTiers` (docs/manage-contract.md, "Model tiers").
 */
import { EFFORTS, type Effort } from "@engenty/wizards-shared/definition";
import {
  MAX_MASK_INSTRUCTIONS,
  MAX_MASK_LABEL_CHARS,
  MAX_MASK_LABELS,
  type ModelPolicy,
  type ModelTier,
  type Purpose,
  type PurposePolicy,
  splitClassId,
} from "@engenty/wizards-shared/tiers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  EyeOff,
  KeyRound,
  Laptop,
  ListChecks,
  Lock,
  type LucideIcon,
  MessageCircle,
  Plug,
  Plus,
  Sparkles,
  TerminalSquare,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useFeatures } from "../lib/features";
import { type Key, t } from "../lib/i18n";
import { Button, Card, cn, Input, Segmented, Select, Switch, Textarea } from "../ui";
import { Hint, PanelHead, Part } from "./models-parts";
import {
  approvable,
  approved,
  chooserItem,
  offered,
  pickable,
  preselection,
  tierClassLabel,
} from "./tiers";

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
  maskInstructions: "",
  maskLabels: [],
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

/** The way's name, short, for the menu: "preselection", "defaults", "expert mode". */
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
  warn,
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
  /** A sentence after the hint, highlighted: where the data goes when this is on. */
  warn?: string | null;
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
        <p className="mt-0.5 text-[0.8125rem] text-ink-3">
          {hint}
          {warn ? <span className="font-medium text-amber"> {warn}</span> : null}
        </p>
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

/** Modellwahl: who picks the model, Auto (way A), the admins' defaults (B) or their list (C). */
export function ChoicePanel({
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
                onClick={() => save.mutate({ ...shown, way })}
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
        {save.error ? (
          <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
        ) : null}
      </Card>
    </div>
  );
}

/** The switches of the policy an access page carries: own keys, subscriptions, local models. */
export type PolicySwitch = "ownKeys" | "subscriptions" | "localModels";

const SWITCH_ICON: Record<PolicySwitch, LucideIcon> = {
  ownKeys: KeyRound,
  subscriptions: TerminalSquare,
  localModels: Laptop,
};

/**
 * One switch of the policy, for the organization's admins, on its access page. On a strict tier
 * own keys and subscriptions say where the data goes then, outside the tier's promises.
 */
export function PolicySwitchCard({
  tier,
  policy,
  field,
  canEdit,
}: {
  tier: ModelTier;
  policy: ModelPolicy;
  field: PolicySwitch;
  canEdit: boolean;
}) {
  const save = useSavePolicy();
  const shown = save.isPending && save.variables ? save.variables : policy;
  const strict = Boolean(tier.rules.regions || tier.rules.zdr || tier.rules.noTraining);
  const warn =
    strict && field === "ownKeys"
      ? t("policy.ownKeys.warn", { tier: tier.name })
      : strict && field === "subscriptions"
        ? t("policy.subscriptions.warn")
        : null;
  return (
    <Card className="flex flex-col gap-3 p-5 sm:p-6">
      <PolicyRow
        icon={SWITCH_ICON[field]}
        title={t(`policy.${field}`)}
        hint={t(`policy.${field}.hint`)}
        checked={shown[field]}
        warn={warn}
        disabled={!canEdit}
        onChange={(on) => save.mutate({ ...shown, [field]: on })}
      />
      {save.error ? (
        <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </Card>
  );
}

/** Maskierung: personal data turns into placeholders before a call leaves, and what else to mask. */
export function MaskingPanel({
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
  const set = (patch: Partial<ModelPolicy>) => save.mutate({ ...shown, ...patch });
  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        icon={EyeOff}
        title={t("overview.menu.masking")}
        lead={t("overview.maskingLead")}
      />
      <Card className="flex flex-col gap-3 p-5 sm:p-6">
        <PolicyRow
          icon={EyeOff}
          title={t("policy.masking")}
          hint={t("policy.masking.hint")}
          checked={shown.masking}
          note={tier.rules.regions ? t("policy.recommendedOn", { tier: tier.name }) : null}
          disabled={!canEdit}
          onChange={(masking) => set({ masking })}
        />
        {shown.masking ? (
          <MaskingInstructions policy={policy} shown={shown} canEdit={canEdit} set={set} />
        ) : null}
        {save.error ? (
          <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
        ) : null}
      </Card>
    </div>
  );
}

/**
 * O: what else to mask, in a sentence; the labels it turned into when saved (the Manage-App asks
 * a model in the EU), which admins can remove or add to; and what a model would see of a sentence.
 */
function MaskingInstructions({
  policy,
  shown,
  canEdit,
  set,
}: {
  policy: ModelPolicy;
  shown: ModelPolicy;
  canEdit: boolean;
  set: (patch: Partial<ModelPolicy>) => void;
}) {
  const [draft, setDraft] = useState(policy.maskInstructions);
  const [label, setLabel] = useState("");
  const [sentence, setSentence] = useState("");
  // Saved elsewhere or turned into labels: the field shows what is saved.
  useEffect(() => setDraft(policy.maskInstructions), [policy.maskInstructions]);
  const tryIt = useMutation({
    mutationFn: (text: string) =>
      api.post<{ text: string; counts: Record<string, number> }>("/api/studio/model-policy/try", {
        text,
        maskLabels: shown.maskLabels,
      }),
  });
  const labels = shown.maskLabels;
  const addLabel = () => {
    const next = label.trim().toLowerCase().replace(/\s+/g, " ");
    if (next && !labels.includes(next) && labels.length < MAX_MASK_LABELS) {
      set({ maskLabels: [...labels, next] });
    }
    setLabel("");
  };
  return (
    <div className="flex flex-col gap-4 border-border-soft border-t py-4">
      <div className="flex flex-col gap-2">
        <span className="font-medium text-[0.875rem]">{t("policy.maskWhat")}</span>
        <Hint>{t("policy.maskWhat.hint")}</Hint>
        <Textarea
          minRows={2}
          maxLength={MAX_MASK_INSTRUCTIONS}
          value={draft}
          disabled={!canEdit}
          placeholder={t("policy.maskWhat.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
        />
        {canEdit && draft.trim() !== shown.maskInstructions.trim() ? (
          <div>
            <Button size="sm" onClick={() => set({ maskInstructions: draft.trim() })}>
              {t("policy.maskWhat.save")}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-medium text-[0.875rem]">{t("policy.maskLabels")}</span>
        <div className="flex flex-wrap items-center gap-2">
          {labels.length ? (
            labels.map((l) => (
              <span
                key={l}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-border-soft bg-paper-2 pr-1.5 pl-3 text-[0.8125rem] text-ink-2"
              >
                {l}
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={t("policy.maskLabels.remove", { label: l })}
                    className="grid size-5 place-items-center rounded-full text-ink-3 hover:bg-paper-3 hover:text-ink"
                    onClick={() => set({ maskLabels: labels.filter((x) => x !== l) })}
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </span>
            ))
          ) : (
            <Hint>{t("policy.maskLabels.none")}</Hint>
          )}
        </div>
        {canEdit && labels.length < MAX_MASK_LABELS ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addLabel();
            }}
          >
            <Input
              value={label}
              maxLength={MAX_MASK_LABEL_CHARS}
              placeholder={t("policy.maskLabels.addPlaceholder")}
              onChange={(e) => setLabel(e.target.value)}
              className="max-w-xs"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={!label.trim()}>
              <Plus className="size-3.5" />
              {t("policy.maskLabels.add")}
            </Button>
          </form>
        ) : null}
        <Hint>{t("policy.maskLabels.hint")}</Hint>
      </div>
      <div className="flex flex-col gap-2 rounded-xl bg-paper-2/60 p-3">
        <span className="font-medium text-[0.875rem]">{t("policy.maskTry")}</span>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (sentence.trim()) {
              tryIt.mutate(sentence.trim());
            }
          }}
        >
          <Input
            value={sentence}
            maxLength={2000}
            placeholder={t("policy.maskTry.placeholder")}
            onChange={(e) => setSentence(e.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            busy={tryIt.isPending}
            disabled={!sentence.trim()}
          >
            {t("policy.maskTry.button")}
          </Button>
        </form>
        {tryIt.data ? (
          <p className="text-[0.8125rem] text-ink-2">
            <span className="text-ink-3">{t("policy.maskTry.sees")} </span>
            {tryIt.data.text.split(/(‹[^‹›]+›)/).map((part, i) =>
              part.startsWith("‹") ? (
                <span key={i} className="text-cobalt">
                  {part}
                </span>
              ) : (
                part
              ),
            )}
          </p>
        ) : null}
        {tryIt.error ? (
          <p className="text-[0.8125rem] text-rose">{(tryIt.error as Error).message}</p>
        ) : null}
      </div>
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

/** J: way C (expert mode) per purpose: which models people may pick, with which efforts, and the default. */
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
  const inPreselection = new Set(preselection(tier).map((i) => i.model));
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
            {approvable(tier).map((item) => {
              // The list's entry running this model: the line's class, or one saved before.
              const entry = list.find(
                (id) => id === item.id || chooserItem(tier, id)?.model === item.model,
              );
              const key = entry ?? item.id;
              const bound = tier.classes[item.id];
              const takes = EFFORTS.filter((e) => item.efforts.includes(e));
              return (
                <tr key={item.model} className="border-border-soft border-b last:border-b-0">
                  <td className="px-4 py-3">
                    <Switch
                      checked={Boolean(entry)}
                      disabled={!canEdit}
                      onChange={(next) => toggle(key, next)}
                      label={item.name}
                    />
                  </td>
                  <td className="px-2 py-3">
                    <span className="font-medium">{item.name}</span>
                    <span className="block text-[0.75rem] text-ink-3">
                      {inPreselection.has(item.model)
                        ? item.hint
                        : [item.hint, t("chooser.notInPreselection")].filter(Boolean).join(" · ")}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-ink-2">
                    {offered(bound) ? [bound.route, bound.region].filter(Boolean).join(", ") : null}
                  </td>
                  <td className="px-2 py-3">
                    {entry && takes.length ? (
                      <Segmented
                        multi
                        value={effortsOf(key).filter((e) => takes.includes(e))}
                        options={takes}
                        label={(e) => t(`class.effort.${e}` as Key)}
                        onChange={(efforts: Effort[]) =>
                          canEdit && efforts.length
                            ? setPurpose({
                                efforts: { ...(current.efforts ?? {}), [key]: efforts },
                              })
                            : undefined
                        }
                      />
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {entry ? (
                      <label className="inline-flex items-center gap-1.5 text-ink-3">
                        <input
                          type="radio"
                          name={`default-${purpose}`}
                          checked={current.default === key}
                          disabled={!canEdit}
                          onChange={() => setPurpose({ default: key })}
                          className="accent-ember"
                        />
                        {current.default === key ? t("policy.isDefault") : null}
                      </label>
                    ) : null}
                  </td>
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
