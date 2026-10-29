import { type SurfaceChat, type SurfaceFormAnswer, SurfaceView } from "@engenty/wizards-runner";
import type { SurfaceComponent } from "@engenty/wizards-shared/surface";
import { LayoutDashboard } from "lucide-react";
import { createContext, useContext } from "react";
import { useHref, useNavigate } from "react-router";
import { TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { withBase } from "../../lib/base";
import { t } from "../../lib/i18n";
import { chatRoutes } from "./chats";

/**
 * A view the space's AI shows in a chat (`show_view`, services/work-ai.ts): the call's input drawn
 * with the runner's surface, the same components as a wizard's views, where the call stands in
 * the turn. While its input streams, the view builds up as its components arrive; once checked,
 * it stays; a view the check refused is gone (the AI tries again).
 */

export const VIEW_TOOL = "tool-show_view";

/** What a chat does for its views: asks the AI, sends a Form, knows which Forms were answered. */
export interface ViewHost {
  chatId: string;
  spaceId: string;
  ask(text: string): void;
  submit(call: string, answer: SurfaceFormAnswer): Promise<void>;
  /** The Forms someone answered, by the call that showed them. */
  answered: Map<string, { by: string; values: Record<string, unknown> }>;
  /** Where a file of the space is read; the view lab hands in its own. */
  assetUrl?: (id: string) => string;
}

export const ViewContext = createContext<ViewHost | null>(null);

interface ViewInput {
  title?: string;
  components?: unknown[];
  data?: Record<string, unknown>;
}

/** A view's call as the AI SDK holds it: its input (partial while it streams), its result. */
export interface ViewPart {
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
}

/** Components complete enough to draw: an id and a kind. A half-streamed one waits. */
const drawable = (list: unknown[] | undefined): SurfaceComponent[] =>
  (list ?? []).filter(
    (c): c is SurfaceComponent =>
      Boolean(c) &&
      typeof (c as SurfaceComponent).id === "string" &&
      typeof (c as SurfaceComponent).component === "string",
  );

/** Where a Ref leads in the studio: a page, table or file of Knowledge, a chat, a wizard. */
function refPath(open: string): string | null {
  const [kind, ...rest] = open.split(":");
  const id = rest.join(":");
  if (!id) {
    return null;
  }
  if (["p", "t", "f", "v"].includes(kind)) {
    return `/space/knowledge?show=${encodeURIComponent(open)}`;
  }
  if (kind === "chat") {
    return `/work/c/${encodeURIComponent(id)}`;
  }
  if (kind === "wizard") {
    return `/edit/${encodeURIComponent(id)}`;
  }
  return null;
}

export function ChatViewPart({ part, live }: { part: ViewPart; live: boolean }) {
  const host = useContext(ViewContext);
  const navigate = useNavigate();
  const root = useHref("/").replace(/\/$/, "");
  const input = (part.input ?? {}) as ViewInput;
  const output = part.output as { ok?: boolean } | undefined;
  const components = drawable(input.components);
  const streaming = part.state === "input-streaming" || part.state === "input-available";
  // Refused or failed, the view is gone; drawn while it comes, and once the check let it through.
  if (
    !host ||
    part.state === "output-error" ||
    (part.state === "output-available" && output?.ok !== true)
  ) {
    return null;
  }
  if (!components.some((c) => c.id === "root")) {
    return streaming && live ? (
      <TraceLine status="running">
        <TraceIcon>
          <LayoutDashboard />
        </TraceIcon>
        <TraceTitle>{t("work.view.building")}</TraceTitle>
      </TraceLine>
    ) : null;
  }
  const answered = host.answered.get(part.toolCallId) ?? null;
  const chat: SurfaceChat = {
    href: (open) => {
      const path = refPath(open);
      return path ? `${root}${path}` : null;
    },
    follow: (href) => navigate(href.slice(root.length) || "/"),
    fieldBase: chatRoutes(host.chatId),
    // The message says which view it answers: its title first, unless the Form has its own.
    submit: (answer) =>
      host.submit(part.toolCallId, {
        ...answer,
        text:
          input.title && !answer.text.startsWith(input.title)
            ? `${input.title}\n${answer.text}`
            : answer.text,
      }),
    answered,
  };
  return (
    <div className="grid gap-3">
      {input.title ? (
        <div className="font-display font-semibold text-[1rem] leading-snug">{input.title}</div>
      ) : null}
      <SurfaceView
        surface={{ components, data: input.data ?? {} }}
        assetUrl={(id) =>
          host.assetUrl?.(id) ??
          withBase(
            `/api/studio/spaces/${host.spaceId}/files/${encodeURIComponent(id.replace(/^f:/, ""))}/content`,
          )
        }
        onAction={(a) => {
          if (a.action === "ask" && typeof a.target === "string" && a.target) {
            host.ask(a.target);
          }
        }}
        chat={chat}
      />
    </div>
  );
}
