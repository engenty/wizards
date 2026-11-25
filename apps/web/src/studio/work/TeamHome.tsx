import type { ReactNode } from "react";
import { type Key, t } from "../../lib/i18n";
import { Button } from "../../ui";
import { useCrumbs } from "../AppFrame";
import { useAssistantPage } from "../assistant/page";
import { openExternal } from "../LocalRuntime";
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
      <Note action={home.may ? { label: "work.home.manage", url: home.makeUrl } : undefined}>
        {t("work.home.stopped")}
      </Note>
    );
  }
  // A team's server is run by its owners and admins; a person's own server is theirs.
  if (home.team && !home.may) {
    return <Note>{t("work.home.adminsOnly")}</Note>;
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

/** The server's own page. What it may use is what its chats use: the microphone, the camera. */
function Page({ address }: { address: string }) {
  return (
    <iframe
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
