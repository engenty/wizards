import type { AssistantPrompt } from "@engenty/wizards-shared/assistant";
import { Activity } from "lucide-react";
import { useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { useMe } from "../../lib/session";
import { IconButton } from "../../ui";
import type { DevTurn } from "../assistant/chat";
import { CopyThread, DevSwitch, TurnsDialog } from "../assistant/dev";
import { setDockPrefs, useDockPrefs } from "../assistant/dock";
import type { ChatMessage, TurnTap } from "./chats";

/**
 * A Work chat's developer mode, with Goose's pieces (assistant/dev.tsx): the same switch, on or
 * off per browser for both, and the turns to look at, copy and download. While it is on, the
 * browser records each turn's stream as it comes: its tool calls, and the prompt and each step's
 * model, tokens and time, which the runtime sends to a person it offers the mode to.
 */

export interface WorkDev {
  offered: boolean;
  on: boolean;
  turns: DevTurn[];
  /** Hears the turns' streams while the mode is on (`useAiTurn`). */
  tap: React.RefObject<TurnTap | null>;
}

/** The chunk names Goose's timeline reads, from the AI SDK's. */
function eventOf(chunk: { type: string } & Record<string, unknown>): {
  event: string;
  data: unknown;
} {
  switch (chunk.type) {
    case "tool-input-available":
      return {
        event: "tool_call",
        data: { toolCallId: chunk.toolCallId, toolCallName: chunk.toolName, input: chunk.input },
      };
    case "tool-output-available":
    case "tool-output-error":
      return { event: "tool_result", data: chunk };
    case "data-dev-step":
      return { event: "step", data: chunk.data };
    case "data-dev-prompt":
      return { event: "prompt", data: chunk.data };
    default:
      return { event: chunk.type, data: chunk };
  }
}

export function useWorkDev(chatId: string): WorkDev {
  const offered = Boolean(useMe().data?.assistantDev);
  const prefs = useDockPrefs();
  const on = offered && prefs.dev;
  // The turns of the open chat: another chat starts with none.
  const [shown, setShown] = useState<{ chat: string; turns: DevTurn[] }>({ chat: "", turns: [] });
  const all = useRef<{ chat: string; turns: DevTurn[] }>({ chat: "", turns: [] });
  const tap = useRef<TurnTap | null>(null);
  const turn = useRef<DevTurn | null>(null);
  const show = () => setShown({ chat: all.current.chat, turns: [...all.current.turns] });
  tap.current = on
    ? {
        start: (message) => {
          turn.current = {
            id: crypto.randomUUID(),
            message,
            startedAt: Date.now(),
            endedAt: null,
            prompt: null,
            events: [],
          };
          all.current = {
            chat: chatId,
            turns: [...(all.current.chat === chatId ? all.current.turns : []), turn.current],
          };
          show();
        },
        chunk: (chunk) => {
          const current = turn.current;
          if (!current) {
            return;
          }
          const { event, data } = eventOf(chunk);
          current.events.push({ at: Date.now(), event, data });
          if (event === "prompt") {
            current.prompt = data as AssistantPrompt;
          }
          // Each word of the answer is kept, but drawn with the next step.
          if (!chunk.type.endsWith("-delta")) {
            show();
          }
        },
        end: () => {
          if (turn.current) {
            turn.current.endedAt = Date.now();
            turn.current = null;
            show();
          }
        },
      }
    : null;
  return { offered, on, turns: shown.chat === chatId ? shown.turns : [], tap };
}

/**
 * In a Work chat's composer, where the runtime offers the developer mode: its switch and, while
 * it is on, the turns of the chat.
 */
export function DevButtons({ dev, messages }: { dev: WorkDev; messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  if (!dev.offered) {
    return null;
  }
  return (
    <span className="flex h-9 shrink-0 items-center gap-0.5 px-1 coarse:h-11">
      <DevSwitch on={dev.on} set={(next) => setDockPrefs({ dev: next })} />
      {dev.on ? (
        <>
          <IconButton
            label={t("assistant.inspect")}
            onClick={() => setOpen(true)}
            className="size-8"
          >
            <Activity className="size-4" />
          </IconButton>
          {messages.length ? <CopyThread messages={messages} turns={dev.turns} /> : null}
          <TurnsDialog
            open={open}
            onClose={() => setOpen(false)}
            turns={dev.turns}
            messages={messages}
            file="work"
          />
        </>
      ) : null}
    </span>
  );
}
