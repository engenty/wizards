import { featureOn } from "@engenty/wizards-shared/features";
import { useSyncExternalStore } from "react";
import type { Me } from "./session";

/**
 * The studio's modes (behind `workMode`): Studio for the people who build, Work for the firm's
 * team, Client for the firm's customers. Who may use which follows the roles there are: Studio
 * for whoever makes and deletes here (`limits.create`: builds, and is no mere member), Work and a
 * look at Client for everyone. The pick is kept per person in this browser, like the app bar.
 */

export const MODES = ["studio", "work", "client"] as const;
export type Mode = (typeof MODES)[number];

/** Where each mode starts. */
export const MODE_HOME: Record<Mode, string> = { studio: "/", work: "/work", client: "/client" };

const KEY = "wizards.mode";

/** The modes this person may use; with the switch off, Studio alone, as before. */
export function allowedModes(me: Me): Mode[] {
  if (!featureOn(me.features, "workMode")) {
    return ["studio"];
  }
  // Behind `capabilities`, a member builds too where the space opens its Studio to members.
  const builds =
    me.limits.create ||
    (featureOn(me.features, "capabilities") && me.limits.build && membersStudio);
  return builds ? ["studio", "work", "client"] : ["work", "client"];
}

/** Whether the space the studio looks at opens its Studio to members (studio/members-studio.tsx). */
let membersStudio = false;

export function setMembersStudio(open: boolean) {
  if (open === membersStudio) {
    return;
  }
  membersStudio = open;
  // A new pick object, so that `useMode` draws again.
  picks = { ...picks };
  for (const listener of listeners) {
    listener();
  }
}

function read(): Record<string, Mode> {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, Mode> | null;
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

let picks = read();
const listeners = new Set<() => void>();

export function setMode(me: Me, mode: Mode) {
  picks = { ...picks, [me.user.id]: mode };
  try {
    localStorage.setItem(KEY, JSON.stringify(picks));
  } catch {
    // the pick only lasts this page then
  }
  for (const listener of listeners) {
    listener();
  }
}

/**
 * The mode this person is in: their pick while they may use it, else the first they may. Before
 * the person is known, Studio.
 */
export function useMode(me: Me | null | undefined): Mode {
  const stored = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => picks,
  );
  if (!me) {
    return "studio";
  }
  const allowed = allowedModes(me);
  const picked = stored[me.user.id];
  return picked && allowed.includes(picked) ? picked : (allowed[0] ?? "studio");
}
