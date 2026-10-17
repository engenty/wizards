import {
  DEFAULT_RUNNER_SETTINGS,
  type RunnerInfo,
  type RunnerSettings,
} from "@engenty-wizards/shared/runners";
import {
  AudioLines,
  Check,
  Globe,
  ListChecks,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  MessageSquareText,
  Phone,
  Plus,
  Video,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Key, t } from "../lib/i18n";
import { cn } from "../ui";

/**
 * How a new wizard is to run, asked before it is built: the channels a person reaches it on.
 * The browser's channels each have an address of their own, so several can be on; a WhatsApp
 * call comes in at the same door as a phone call.
 */

export type ChannelId =
  | "steps"
  | "chat"
  | "talk"
  | "video"
  | "call"
  | "wacall"
  | "sms"
  | "whatsapp";
export type ChannelGroup = "web" | "phone" | "message";
type Group = ChannelGroup;

export interface Channel {
  id: ChannelId;
  group: Group;
  /** The runner that serves it. */
  runner: string;
  label: Key;
  icon: LucideIcon | null;
}

const CHANNELS: Channel[] = [
  { id: "steps", group: "web", runner: "steps", label: "new.ch.steps", icon: ListChecks },
  { id: "chat", group: "web", runner: "chat", label: "new.ch.chat", icon: MessageCircle },
  { id: "talk", group: "web", runner: "talk", label: "new.ch.talk", icon: AudioLines },
  { id: "video", group: "web", runner: "video", label: "new.ch.video", icon: Video },
  { id: "call", group: "phone", runner: "call", label: "new.ch.call", icon: Phone },
  { id: "wacall", group: "phone", runner: "call", label: "new.ch.whatsapp", icon: null },
  { id: "sms", group: "message", runner: "sms", label: "new.ch.sms", icon: MessageSquare },
  { id: "whatsapp", group: "message", runner: "whatsapp", label: "new.ch.whatsapp", icon: null },
];

export const CHANNEL_GROUPS: { id: Group; label: Key; icon: LucideIcon }[] = [
  { id: "web", label: "new.web", icon: Globe },
  { id: "phone", label: "new.phone", icon: Phone },
  { id: "message", label: "new.messages", icon: MessageSquareText },
];

/** What a wizard offers when nobody chooses: the runners a new wizard has switched on. */
export const DEFAULT_CHANNELS = CHANNELS.filter((c) =>
  DEFAULT_RUNNER_SETTINGS.enabled.includes(c.id),
).map((c) => c.id);

const picked = (ids: ChannelId[]) => CHANNELS.filter((c) => ids.includes(c.id));

/** True where the choice is what a wizard gets anyway. */
export function isDefaultChoice(ids: ChannelId[]): boolean {
  return ids.length === DEFAULT_CHANNELS.length && DEFAULT_CHANNELS.every((id) => ids.includes(id));
}

/** The runner settings of a choice: the link opens the first browser channel, else the first on. */
export function runnerSettingsOf(ids: ChannelId[]): RunnerSettings {
  const chosen = picked(ids);
  const enabled = [...new Set(chosen.map((c) => c.runner))];
  const web = chosen.find((c) => c.group === "web");
  return { default: web?.runner ?? enabled[0] ?? DEFAULT_RUNNER_SETTINGS.default, enabled };
}

const names = (chosen: Channel[]) => chosen.map((c) => t(c.label));

/**
 * The channel a runner stands for, in the studio's words: its group, its name, its icon. A
 * call runner takes WhatsApp calls too; it is the phone call here.
 */
export function channelOfRunner(runner: string): Channel | undefined {
  return CHANNELS.find((c) => c.runner === runner);
}

/** The channels the runners switched on stand for: one per runner, a call is the phone call. */
export function channelsOfRunners(enabled: string[]): ChannelId[] {
  return CHANNELS.filter((c) => c.id !== "wacall" && enabled.includes(c.runner)).map((c) => c.id);
}

/** The choice as a line of the first message, so the assistant builds for these channels. */
export function channelLine(ids: ChannelId[]): string {
  const chosen = picked(ids);
  const parts = CHANNEL_GROUPS.flatMap((g) => {
    const inGroup = names(chosen.filter((c) => c.group === g.id));
    if (!inGroup.length) {
      return [];
    }
    return [g.id === "web" ? inGroup.join(", ") : `${t(g.label)}: ${inGroup.join(", ")}`];
  });
  return `${t("new.runsAs")}: ${parts.join(" · ")}`;
}

/** Two names, then a count: "Chat, Live Voice +1". */
function summary(list: string[]): string {
  return list.length <= 2 ? list.join(", ") : `${list.slice(0, 2).join(", ")} +${list.length - 2}`;
}

/** A channel's icon; WhatsApp, which lucide has none for, as its initials. */
export function ChannelIcon({ channel, className }: { channel: Channel; className?: string }) {
  const Icon = channel.icon;
  return Icon ? (
    <Icon className={className ?? "size-4"} />
  ) : (
    <span aria-hidden="true" className="font-semibold text-[0.625rem] tracking-wide">
      WA
    </span>
  );
}

/** The channels the tenant's runners serve; until the runners are known, the browser's own. */
function offeredOf(runners: RunnerInfo[] | undefined): Channel[] {
  const have = new Set(runners?.map((r) => r.id) ?? ["steps", "chat", "talk", "video"]);
  return CHANNELS.filter((c) => have.has(c.runner));
}

/**
 * The channels to tick, by kind: the browser's in one column, the phone's and the messages' in
 * the other. One always stays on.
 */
export function ChannelList({
  value,
  onChange,
  runners,
  without,
  disabled,
}: {
  value: ChannelId[];
  onChange: (ids: ChannelId[]) => void;
  runners: RunnerInfo[] | undefined;
  /** Channels not offered here. */
  without?: ChannelId[];
  disabled?: boolean;
}) {
  const offered = offeredOf(runners).filter((c) => !without?.includes(c.id));
  const on = (c: Channel) => value.includes(c.id);
  // One channel always stays on: a wizard nobody can reach is no choice.
  const toggle = (c: Channel) => {
    if (disabled || (on(c) && value.length === 1)) {
      return;
    }
    onChange(on(c) ? value.filter((id) => id !== c.id) : [...value, c.id]);
  };

  const column = (group: Group) => {
    const meta = CHANNEL_GROUPS.find((g) => g.id === group);
    const rows = offered.filter((c) => c.group === group);
    if (!(meta && rows.length)) {
      return null;
    }
    const GroupIcon = meta.icon;
    return (
      <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
        <legend className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[0.75rem] text-ink-3">
          <GroupIcon className="size-3.5" /> {t(meta.label)}
        </legend>
        {rows.map((c) => (
          <div key={c.id}>
            <label
              className={cn(
                "flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[0.875rem] transition hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus coarse:h-11",
                on(c) && "bg-paper-2",
              )}
            >
              <span className="flex w-5 justify-center text-ink-3">
                <ChannelIcon channel={c} />
              </span>
              <span className="flex-1">{t(c.label)}</span>
              <input
                type="checkbox"
                className="sr-only"
                aria-label={t(c.label)}
                checked={on(c)}
                disabled={disabled}
                aria-disabled={on(c) && value.length === 1}
                onChange={() => toggle(c)}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-[1.125rem] items-center justify-center rounded-md ring-1",
                  on(c) ? "bg-ink text-paper ring-ink" : "ring-border",
                )}
              >
                {on(c) ? <Check className="size-3" strokeWidth={3} /> : null}
              </span>
            </label>
            {c.id === "call" && on(c) ? (
              <p className="px-2 pb-1.5 pl-9 text-[0.75rem] text-ink-3">{t("new.callHandoff")}</p>
            ) : null}
          </div>
        ))}
      </fieldset>
    );
  };

  return (
    <div className="grid gap-x-4 sm:grid-cols-2">
      {column("web")}
      <div className="flex flex-col">
        {column("phone")}
        {column("message")}
      </div>
    </div>
  );
}

/**
 * "Läuft als" and one button per kind of channel: in the browser, on the phone, by message. A
 * kind with something on shows what; one without is a quiet icon. Any of them opens the list.
 */
export function ChannelPicker({
  value,
  onChange,
  runners,
  className,
}: {
  value: ChannelId[];
  onChange: (ids: ChannelId[]) => void;
  /** The runners this tenant has; until they are known, the browser's own. */
  runners: RunnerInfo[] | undefined;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  /** Where the list grows from: the middle of the button that opened it. */
  const [origin, setOrigin] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const offered = offeredOf(runners);
  const groups = CHANNEL_GROUPS.filter((g) => offered.some((c) => c.group === g.id));
  const on = (c: Channel) => value.includes(c.id);

  return (
    <div ref={box} className={cn("relative flex flex-wrap items-center gap-1.5", className)}>
      <span className="mr-0.5 px-1 text-[0.8125rem] text-ink-3">{t("new.runsAs")}</span>
      {groups.map((g) => {
        const list = names(offered.filter((c) => c.group === g.id && on(c)));
        const GroupIcon = g.icon;
        return (
          <button
            key={g.id}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`${t(g.label)}: ${list.length ? list.join(", ") : t("new.off")}`}
            onClick={(e) => {
              const button = e.currentTarget;
              setOrigin(button.offsetLeft + button.offsetWidth / 2);
              setOpen((o) => !o);
            }}
            className={cn(
              "inline-flex h-9 items-center justify-center gap-1.5 rounded-full font-medium text-[0.8125rem] transition coarse:h-11",
              list.length
                ? "bg-ink px-3 text-paper"
                : "w-9 text-ink-3 ring-1 ring-border hover:text-ink coarse:w-11",
            )}
          >
            <GroupIcon className="size-4 shrink-0" />
            {list.length ? <span className="truncate">{summary(list)}</span> : null}
          </button>
        );
      })}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("new.where")}
        onClick={(e) => {
          const button = e.currentTarget;
          setOrigin(button.offsetLeft + button.offsetWidth / 2);
          setOpen((o) => !o);
        }}
        className="inline-flex size-9 items-center justify-center rounded-full text-ink-3 ring-1 ring-border transition hover:text-ink coarse:size-11"
      >
        <Plus className="size-4" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("new.where")}
          style={{ transformOrigin: `${origin}px top` }}
          className="absolute top-full left-0 z-20 mt-2 w-[min(32rem,calc(100vw-2rem))] animate-unfold rounded-2xl bg-card p-3 text-left shadow-overlay ring-1 ring-border"
        >
          <p className="px-2 pt-1 font-semibold text-[0.9375rem]">{t("new.where")}</p>
          <ChannelList value={value} onChange={onChange} runners={runners} />
        </div>
      ) : null}
    </div>
  );
}
