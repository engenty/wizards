import type { ResultStep, ShareOption, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { ShareTargetInfo } from "@engenty/wizards-shared/sharing";
import { Bot, ChevronDown, Eye, Link2, Lock, Plug, RotateCcw } from "lucide-react";
import { useContext, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type Key, t } from "../../lib/i18n";
import { TARGET_ICON } from "../../share/icons";
import { Button, Chip, cn, IconButton, Input, Label, Select, Switch, Textarea } from "../../ui";
import {
  addTarget,
  audiences,
  extraTargets,
  listText,
  type Placeholder,
  placeholdersFor,
  prefillRow,
  ResultPageOpener,
  type ShareMode,
  type ShareRow,
  shareRows,
  switchRow,
  useShareTargets,
} from "./share";

const MODE_LABEL: Record<ShareMode, Key> = {
  default: "shareEditor.default",
  own: "shareEditor.own",
  off: "shareEditor.off",
};

/**
 * Where a result can be sent or published: one row per target, switched on or off, each with its
 * state and the form it starts with. Visitors and the owner may get different targets: the
 * summary says which.
 */
export function ShareEditor({
  wizardId,
  def,
  step,
  set,
}: {
  wizardId: string;
  def: WizardDefinition;
  step: ResultStep;
  set: (step: ResultStep) => void;
}) {
  const navigate = useNavigate();
  const openPage = useContext(ResultPageOpener);
  const known = useShareTargets(wizardId).data ?? [];
  const { mode, rows, unset } = shareRows(step, known);
  const { visitors, onlyYou } = audiences(mode, rows);
  const extras = extraTargets(rows, known);
  const [open, setOpen] = useState<string | null>(null);
  const setShare = (share: ShareOption[] | undefined) => set({ ...step, share });
  const link = t("share.link");

  return (
    <>
      <div className="flex items-center gap-2">
        <Chip tone={mode === "default" ? "neutral" : "ember"}>{t(MODE_LABEL[mode])}</Chip>
        {mode === "default" ? null : (
          <button
            type="button"
            onClick={() => setShare(undefined)}
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[0.8125rem] text-ink-2 hover:bg-accent hover:text-ink coarse:h-11"
          >
            <RotateCcw className="size-3.5" /> {t("shareEditor.reset")}
          </button>
        )}
      </div>
      <p className="text-[0.8125rem] text-ink-2 leading-relaxed">
        {mode === "off"
          ? t("shareEditor.offSummary")
          : t(mode === "own" ? "shareEditor.visitorsGetOrder" : "shareEditor.visitorsGet", {
              names: listText([link, ...visitors.map((r) => r.name)]),
            })}
        {onlyYou.length
          ? ` ${t("shareEditor.onlyYouGet", { names: listText(onlyYou.map((r) => r.name)) })}`
          : null}
      </p>

      <ul className="overflow-hidden rounded-xl bg-paper ring-1 ring-border-soft">
        <li className="flex items-center gap-3 border-border-soft border-b px-3 py-2.5">
          <RowIcon icon={Link2} on />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-[0.875rem]">{link}</span>
            <span className="block text-[0.75rem] text-ink-3">{t("shareEditor.linkHint")}</span>
          </span>
          <Lock className="mr-2.5 size-4 shrink-0 text-ink-4" aria-hidden="true" />
        </li>
        {rows.map((row) => (
          <TargetRow
            key={row.key}
            row={row}
            mode={mode}
            open={open === row.key}
            placeholders={placeholdersFor(def, step)}
            onOpen={() => setOpen(open === row.key ? null : row.key)}
            onSwitch={(on) => {
              setShare(switchRow(step, known, row, on));
              if (!on && open === row.key) {
                setOpen(null);
              }
            }}
            onPrefill={(option) => setShare(prefillRow(step, known, row, option))}
          />
        ))}
        {unset.length ? (
          <li className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-tint text-amber">
              <Plug className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-[0.875rem] text-ink-2">
                {t("shareEditor.unset", { n: unset.length })}
              </span>
              <span className="block truncate text-[0.75rem] text-ink-3">
                {listText(unset.map((k) => k.name))}
              </span>
            </span>
            <button
              type="button"
              onClick={() => navigate("/settings/connectors")}
              className="shrink-0 rounded-full px-2.5 py-1.5 font-medium text-[0.8125rem] text-ember-strong hover:bg-ember-tint coarse:min-h-11"
            >
              {t("shareEditor.setUp")}
            </button>
          </li>
        ) : null}
      </ul>

      {extras.length ? (
        <Select
          value=""
          placeholder={t("shareEditor.addTarget")}
          options={extras.map((k) => ({ value: k.id, label: k.name }))}
          onChange={(target) => target && setShare(addTarget(step, known, target))}
        />
      ) : null}
      {mode === "default" ? (
        <p className="text-[0.75rem] text-ink-3 leading-relaxed">{t("shareEditor.ownHint")}</p>
      ) : null}
      {openPage ? (
        <Button variant="secondary" size="sm" className="self-start" onClick={openPage}>
          <Eye className="size-4" /> {t("shareEditor.preview")}
        </Button>
      ) : null}
    </>
  );
}

function RowIcon({ icon: Icon, on, warn }: { icon: typeof Link2; on: boolean; warn?: boolean }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full",
        warn
          ? "bg-amber-tint text-amber"
          : on
            ? "bg-paper-2 text-ink-2"
            : "bg-paper-2/60 text-ink-4",
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

/** A row's state in words: works, works for whom, or does not work here. */
function rowState(
  row: ShareRow,
  mode: ShareMode,
): { text: string; tone: "ok" | "agent" | "warn" | "off" } {
  const info = row.info;
  if (!info?.usable) {
    return { text: t("shareEditor.notReady"), tone: "warn" };
  }
  if (!row.on) {
    return { text: info.description, tone: "off" };
  }
  if (info.agent) {
    return {
      text: t(mode === "default" ? "shareEditor.onlyYou" : "shareEditor.everyone"),
      tone: "agent",
    };
  }
  return { text: t("shareEditor.ready"), tone: "ok" };
}

function TargetRow({
  row,
  mode,
  open,
  placeholders,
  onOpen,
  onSwitch,
  onPrefill,
}: {
  row: ShareRow;
  mode: ShareMode;
  open: boolean;
  placeholders: Placeholder[];
  onOpen: () => void;
  onSwitch: (on: boolean) => void;
  onPrefill: (option: ShareOption) => void;
}) {
  const state = rowState(row, mode);
  return (
    <li className={cn("border-border-soft border-b", open && "bg-card/60")}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <RowIcon
          icon={TARGET_ICON[row.info?.icon ?? "plug"]}
          on={row.on}
          warn={state.tone === "warn"}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn("block truncate font-medium text-[0.875rem]", !row.on && "text-ink-2")}
          >
            {row.name}
          </span>
          <span
            className={cn(
              "flex items-center gap-1.5 text-[0.75rem]",
              state.tone === "warn" ? "text-amber" : "text-ink-3",
            )}
          >
            {state.tone === "ok" ? (
              <span className="size-1.5 shrink-0 rounded-full bg-moss" aria-hidden="true" />
            ) : state.tone === "agent" ? (
              <Bot className="size-3.5 shrink-0" aria-hidden="true" />
            ) : null}
            <span className="truncate">{state.text}</span>
          </span>
        </span>
        <Switch checked={row.on} label={row.name} onChange={onSwitch} />
        {row.on && row.info ? (
          <IconButton
            label={t("shareEditor.prefill", { name: row.name })}
            aria-expanded={open}
            onClick={onOpen}
          >
            <ChevronDown className={cn("size-4 transition", open && "rotate-180")} />
          </IconButton>
        ) : (
          <span className="size-9 shrink-0 coarse:size-11" />
        )}
      </div>
      {open && row.info ? (
        <Prefill row={row} info={row.info} placeholders={placeholders} onPrefill={onPrefill} />
      ) : null}
    </li>
  );
}

/** The name on the result page and what the target's form starts with; placeholders welcome. */
function Prefill({
  row,
  info,
  placeholders,
  onPrefill,
}: {
  row: ShareRow;
  info: ShareTargetInfo;
  placeholders: Placeholder[];
  onPrefill: (option: ShareOption) => void;
}) {
  const option: ShareOption = row.option ?? { target: row.target };
  /** The field a placeholder goes into: the one last in focus, with its selection. */
  const last = useRef<{ id: string; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const change = (id: string, text: string) => {
    const values = { ...option.values, [id]: text };
    if (!text) {
      delete values[id];
    }
    onPrefill({ ...option, values: Object.keys(values).length ? values : undefined });
  };
  const insert = (ref: string) => {
    const target = last.current ?? null;
    const id = target?.id ?? info.fields.at(-1)?.id;
    if (!id) {
      return;
    }
    const value = option.values?.[id] ?? "";
    const start = target?.el.selectionStart ?? value.length;
    const end = target?.el.selectionEnd ?? start;
    const token = `{{${ref}}}`;
    change(id, value.slice(0, start) + token + value.slice(end));
    const el = target?.el;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    }
  };
  const focus = (id: string) => (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    last.current = { id, el: e.currentTarget };
  };
  return (
    <div className="flex flex-col gap-3 px-3 pt-1 pb-4 sm:pl-14">
      <div>
        <Label>{t("shareEditor.label")}</Label>
        <Input
          value={option.label ?? ""}
          placeholder={info.name}
          onChange={(e) => onPrefill({ ...option, label: e.target.value || undefined })}
        />
      </div>
      {info.fields.map((field) => {
        const value = option.values?.[field.id] ?? "";
        const placeholder = t("shareEditor.prefilled", { label: field.label });
        return (
          <div key={field.id}>
            <Label>{field.label}</Label>
            {field.kind === "textarea" ? (
              <Textarea
                minRows={2}
                value={value}
                placeholder={placeholder}
                onFocus={focus(field.id)}
                onChange={(e) => change(field.id, e.target.value)}
              />
            ) : (
              <Input
                value={value}
                placeholder={placeholder}
                onFocus={focus(field.id)}
                onChange={(e) => change(field.id, e.target.value)}
              />
            )}
          </div>
        );
      })}
      {info.fields.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[0.75rem] text-ink-3">{t("shareEditor.insert")}</span>
          {placeholders.map((p) => (
            <button
              key={p.ref}
              type="button"
              title={`{{${p.ref}}}`}
              // The field keeps its focus and selection: the placeholder goes where the cursor is.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(p.ref)}
              className="h-7 max-w-full truncate rounded-full bg-card px-2.5 text-[0.75rem] text-ink-2 ring-1 ring-input transition hover:text-ink hover:ring-ember coarse:h-9"
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
