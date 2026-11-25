import { type ReactNode, useEffect, useRef } from "react";
import { type Key, t } from "../../lib/i18n";
import { useCurrentSpace, useMe } from "../../lib/session";
import { Button } from "../../ui";
import { useCrumbs } from "../AppFrame";
import { useAssistantPage } from "../assistant/page";
import { openExternal } from "../LocalRuntime";
import { spaceLabel } from "../SpacePath";
import { tellSpace } from "./open-space";
import { type TeamHome as Home, useHomeAddress, useTeamHome } from "./waiting";

/**
 * Work's chats: the page of the team's Bot Server (wizards.bot), shown inside the studio. The
 * server runs the chats; this browser is paired with it as the person, with a pass the runtime
 * fetches. Without a server the page says who makes one.
 */
export function TeamHome() {
  useCrumbs([{ label: t("work.chats") }]);
  // The chats have their own field to write in: Goose stays small beside them.
  useAssistantPage({ ownInput: true });
  const home = useTeamHome();
  if (home.isError) {
    return <Note>{(home.error as Error).message}</Note>;
  }
  if (!home.data) {
    return null;
  }
  return <Shown home={home.data} />;
}

function Shown({ home }: { home: Home }) {
  if (home.state === "unmanaged") {
    return <Note>{t("work.home.unmanaged")}</Note>;
  }
  if (home.state === "none") {
    return home.mayMake ? (
      <Note action={{ label: "work.home.make", url: home.makeUrl }}>{t("work.home.none")}</Note>
    ) : (
      <Note>{t("work.home.askAdmin")}</Note>
    );
  }
  if (home.state === "making") {
    return <Note>{t("work.home.making")}</Note>;
  }
  if (home.state === "stopped") {
    return (
      <Note action={home.runs ? { label: "work.home.manage", url: home.makeUrl } : undefined}>
        {t("work.home.stopped")}
      </Note>
    );
  }
  // Everyone of the team chats on its server, each as themselves; a client has no chats there.
  if (home.team && !home.may) {
    return <Note>{t("work.home.noChats")}</Note>;
  }
  return home.team ? <Paired origin={home.origin} /> : <Page address={home.origin} />;
}

/** The team's server, opened with a pass for the person. */
function Paired({ origin }: { origin: string }) {
  const address = useHomeAddress(origin);
  if (address.isError) {
    return <Note>{(address.error as Error).message}</Note>;
  }
  return address.data ? <Page address={address.data.url} /> : null;
}

/**
 * The server's own page. What it may use is what its chats use: the microphone, the camera. Once
 * the page says it listens it is told the space open in the top bar, and each one opened after
 * it, so its chats work in that space (open-space.ts).
 */
function Page({ address }: { address: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const telling = useRef<ReturnType<typeof tellSpace> | null>(null);
  const origin = new URL(address).origin;
  const me = useMe().data;
  const { space } = useCurrentSpace();
  const id = space?.id;
  const name = space && me ? spaceLabel(me, space) : undefined;
  useEffect(() => {
    const told = tellSpace(window, () => frame.current?.contentWindow ?? null, origin);
    telling.current = told;
    return () => {
      told.stop();
      telling.current = null;
    };
  }, [origin]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a server at another origin has a listener of its own to tell.
  useEffect(() => {
    if (id && name) {
      telling.current?.open({ id, name });
    }
  }, [id, name, origin]);
  return (
    <iframe
      ref={frame}
      title={t("work.chats")}
      src={address}
      allow="microphone; camera; clipboard-read; clipboard-write; fullscreen"
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0"
    />
  );
}

function Note({ children, action }: { children: ReactNode; action?: { label: Key; url: string } }) {
  return (
    <div className="mx-auto grid max-w-md justify-items-center gap-4 px-6 py-24 text-center">
      <p className="text-[0.9375rem] text-ink-3">{children}</p>
      {action ? (
        <Button size="sm" onClick={() => openExternal(action.url)}>
          {t(action.label)}
        </Button>
      ) : null}
    </div>
  );
}
