import { FORMAT_LABEL, Markdown } from "@engenty-wizards/runner";
import {
  listRef,
  type ResultStep,
  type WizardDefinition,
} from "@engenty-wizards/shared/definition";
import type { SharePreview, SharePreviewTarget } from "@engenty-wizards/shared/sharing";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Eye,
  History,
  Link2,
  RotateCcw,
  Share2,
  TriangleAlert,
  User,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { Mascot } from "../../brand";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { TARGET_ICON } from "../../share/icons";
import { Tile } from "../../share/ShareSheet";
import {
  type Deliverable,
  FieldInput,
  FilePicker,
  type Picked,
  Steps,
} from "../../share/ShareTargetFlow";
import { Button, Card, cn, IconButton, Spinner } from "../../ui";
import { listText } from "./share";

export type Audience = "visitor" | "owner";

/** The deliverables of the draft's result, named as its page names them. */
function deliverablesOf(def: WizardDefinition, step: ResultStep): Deliverable[] {
  return step.deliverables.map((d) => {
    const list = listRef(d.from);
    const title = list
      ? def.lists?.find((l) => l.id === list)?.title
      : def.steps.find((s) => s.id === d.from)?.title;
    return { from: d.from, label: d.label ?? title ?? d.from, formats: d.formats };
  });
}

/**
 * The result page of the draft as a visitor or as its owner gets it: the head, the share sheet
 * opened, each target's form as it starts, and the deliverables. Texts come from the wizard's
 * last finished test run; nothing is sent from here.
 */
export function ResultPreview({
  wizardId,
  def,
  step,
  revision,
  audience,
  onAudience,
  lead,
  onTest,
  testBusy,
  testDisabled,
  onClose,
}: {
  wizardId: string;
  def: WizardDefinition;
  step: ResultStep;
  revision: number;
  audience: Audience;
  onAudience: (audience: Audience) => void;
  /** The bar's start: a chip beside the flow, the view switch in its place. */
  lead: ReactNode;
  onTest: () => void;
  testBusy: boolean;
  testDisabled: boolean;
  onClose?: () => void;
}) {
  const preview = useQuery({
    queryKey: ["share-preview", wizardId, step.id, revision, audience, lang],
    queryFn: () =>
      api.get<SharePreview>(
        `/api/studio/wizards/${wizardId}/share-preview?step=${encodeURIComponent(step.id)}&as=${audience}&lang=${lang}`,
      ),
    placeholderData: keepPreviousData,
  });
  const [sheetOpen, setSheetOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const data = preview.data;
  const target = data?.targets.find((x) => x.key === picked);
  const deliverables = deliverablesOf(def, step);
  const ran = data?.run
    ? new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" }).format(
        new Date(data.run.at),
      )
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-ember border-b-2 px-3">
        {lead}
        <span className="flex-1" />
        <fieldset
          aria-label={t("resultPreview.seenBy")}
          className="m-0 flex rounded-full border-0 bg-paper-2 p-0.5"
        >
          {(["visitor", "owner"] as const).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={audience === a}
              onClick={() => onAudience(a)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-medium text-[0.8125rem] transition coarse:h-9",
                audience === a ? "bg-card text-ink shadow-soft" : "text-ink-3 hover:text-ink",
              )}
            >
              {a === "visitor" ? <Users className="size-3.5" /> : <User className="size-3.5" />}
              <span className="max-sm:sr-only">
                {t(a === "visitor" ? "resultPreview.visitor" : "resultPreview.you")}
              </span>
            </button>
          ))}
        </fieldset>
        <Button
          variant="ghost"
          size="sm"
          title={t("resultPreview.newTest")}
          busy={testBusy}
          disabled={testDisabled}
          onClick={onTest}
        >
          <RotateCcw className="size-3.5" />
          <span className="max-md:sr-only">{t("resultPreview.newTest")}</span>
        </Button>
        {onClose ? (
          <IconButton label={t("editor.close")} onClick={onClose}>
            <X className="size-5" />
          </IconButton>
        ) : null}
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
          <p className="mb-5 flex items-center gap-2 text-[0.75rem] text-ink-3">
            {preview.isFetching ? (
              <Spinner className="size-3.5 shrink-0" />
            ) : (
              <History className="size-3.5 shrink-0" />
            )}
            {ran ? t("resultPreview.from", { time: ran }) : t("resultPreview.none")}
          </p>

          {/* The head as the result page draws it. */}
          <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-4">
            <Mascot kind={def.avatar} size={56} interactive={false} />
            <div className="min-w-0 flex-1 basis-[12rem]">
              <h2 className="text-balance font-display font-semibold text-[1.5rem] leading-tight tracking-tight">
                {step.title}
              </h2>
              {step.message ? (
                <p className="mt-1 text-[0.9375rem] text-ink-3">{step.message}</p>
              ) : null}
            </div>
            <Button
              variant="secondary"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOpen(!sheetOpen)}
              className={cn(sheetOpen && "ring-2 ring-ember")}
            >
              <Share2 className="size-4" /> {t("shareRun.button")}
            </Button>
          </div>

          {sheetOpen ? (
            <Card className="mb-6 p-4 shadow-elevated sm:p-5">
              {target ? (
                <TargetForm
                  key={`${target.key}:${JSON.stringify(target.fields.map((f) => f.value))}`}
                  target={target}
                  deliverables={deliverables}
                  hasRun={Boolean(data?.run)}
                  onBack={() => setPicked(null)}
                />
              ) : (
                <SheetHome data={data} onPick={setPicked} />
              )}
            </Card>
          ) : null}

          <div className="flex flex-col gap-6">
            {deliverables.map((d) => {
              const text = data?.outputs[d.from];
              return (
                <Card key={d.from} className="p-4 sm:p-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-display font-semibold text-[1.0625rem]">{d.label}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {d.formats.map((f) => (
                        <span
                          key={f}
                          className="inline-flex h-7 items-center rounded-full bg-paper-2 px-3 font-medium text-[0.75rem] text-ink-2"
                        >
                          {FORMAT_LABEL[f]}
                        </span>
                      ))}
                    </div>
                  </div>
                  {text ? (
                    <div className="max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
                      <Markdown text={text} />
                    </div>
                  ) : (
                    <p className="text-[0.875rem] text-ink-3">{t("resultPreview.notMade")}</p>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The sheet's first screen: the link and every target this audience gets, then what it does not. */
function SheetHome({
  data,
  onPick,
}: {
  data: SharePreview | undefined;
  onPick: (key: string) => void;
}) {
  const navigate = useNavigate();
  const agents = data?.left.filter((l) => l.why === "agent") ?? [];
  const unset = data?.left.filter((l) => l.why === "setup") ?? [];
  return (
    <div className="flex flex-col gap-4">
      <h3 className="font-medium text-[1.0625rem]">{t("shareRun.title")}</h3>
      <div className="grid gap-2.5 @lg:grid-cols-2">
        <Tile icon={Link2} name={t("share.link")} description={t("shareRun.linkHint")} />
        {(data?.targets ?? []).map((target) => (
          <Tile
            key={target.key}
            icon={TARGET_ICON[target.icon]}
            name={target.name}
            description={target.description}
            onClick={() => onPick(target.key)}
          />
        ))}
      </div>
      {agents.length ? (
        <p className="flex items-start gap-2 rounded-lg bg-paper-2 px-3 py-2.5 text-[0.8125rem] text-ink-2 leading-relaxed">
          <Eye className="mt-0.5 size-4 shrink-0 text-ink-3" />
          {t("resultPreview.agentLeft", { names: listText(agents.map((l) => l.name)) })}
        </p>
      ) : null}
      {unset.length ? (
        <p className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg bg-amber-tint px-3 py-2.5 text-[0.8125rem] text-ink-2 leading-relaxed">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber" />
          <span className="min-w-0 flex-1">
            {t("resultPreview.setupLeft", { names: listText(unset.map((l) => l.name)) })}
          </span>
          <button
            type="button"
            onClick={() => navigate("/settings/connectors")}
            className="font-medium text-ember-strong hover:underline"
          >
            {t("shareEditor.setUp")}
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** One target's form as the visitor gets it: prefilled, editable here, never sent. */
function TargetForm({
  target,
  deliverables,
  hasRun,
  onBack,
}: {
  target: SharePreviewTarget;
  deliverables: Deliverable[];
  hasRun: boolean;
  onBack: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(target.fields.map((f) => [f.id, f.value ?? ""])),
  );
  const [picked, setPicked] = useState<Picked>(() =>
    Object.fromEntries(deliverables.map((d) => [d.from, d.formats[0]])),
  );
  const steps = [
    ...(target.connection ? [t("shareRun.stepAccount")] : []),
    t("shareRun.stepForm"),
    t("shareRun.stepSend"),
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-1">
        <IconButton label={t("run.back")} onClick={onBack} className="-ml-2">
          <ArrowLeft className="size-4" />
        </IconButton>
        <h3 className="min-w-0 flex-1 truncate font-medium text-[1.0625rem]">{target.name}</h3>
      </div>
      <div className="-mb-6">
        <Steps steps={steps} now={target.connection ? 1 : 0} />
      </div>
      {target.connection?.account ? (
        <p className="rounded-lg bg-paper-2 px-3 py-2 text-[0.8125rem] text-ink-2">
          {t("shareRun.as", { account: target.connection.account.label })}
        </p>
      ) : null}
      {target.agent ? (
        <p className="flex items-start gap-2.5 rounded-lg bg-ember-tint px-3 py-2.5 text-[0.8125rem] text-ink-2 leading-relaxed">
          <Bot className="mt-0.5 size-4 shrink-0 text-ember-strong" /> {t("shareRun.agentHint")}
        </p>
      ) : null}
      {target.fields.map((field) => (
        <FieldInput
          key={field.id}
          field={field}
          value={values[field.id] ?? ""}
          choices={[]}
          onChange={(value) => setValues((v) => ({ ...v, [field.id]: value }))}
        />
      ))}
      {hasRun && target.empty.length ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-tint px-3 py-2.5 text-[0.8125rem] text-ink-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber" />
          {t("resultPreview.empty", {
            names: target.empty.map((ref) => `{{${ref}}}`).join(", "),
          })}
        </p>
      ) : null}
      {target.takes === "files" && deliverables.length ? (
        <FilePicker
          deliverables={deliverables}
          picked={picked}
          onPick={(from, format) => setPicked((p) => ({ ...p, [from]: format }))}
        />
      ) : null}
      <p className="text-[0.8125rem] text-ink-3">{t("resultPreview.nothingSent")}</p>
    </div>
  );
}
