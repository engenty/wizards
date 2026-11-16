import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { type Key, t } from "../lib/i18n";
import { type Me, type Space, useCurrentSpace, useIsAdmin, useMe } from "../lib/session";
import { setSetupProgress } from "./assistant/page";
import { useSpaceConnections } from "./capabilities/ConnectorsSection";
import { useKnowledge } from "./space/Knowledge";
import { useSkills } from "./space/Skills";

/*
 * The organization's setup, as Home's card walks the admin through it: which steps there are,
 * which are done and which were put off. `SetupReporter` hands the same to Goose with every
 * message, so it knows where the setup stands while it guides the person through it.
 */

export type PageId = "info" | "knowledge" | "connections" | "skills" | "team";

export const PAGES: PageId[] = ["info", "knowledge", "connections", "skills", "team"];

/** Where each step is done; on a local install the last one signs in instead. */
export const GO: Record<Exclude<PageId, "info">, string> = {
  knowledge: "/space/knowledge",
  connections: "/capabilities/connectors",
  skills: "/capabilities/skills",
  team: "/settings/organization",
};

interface Organization {
  members: { userId: string }[];
  invitations: { id: string }[];
}

/** The steps there are: Skills only behind its switch. */
export function usePages(): PageId[] {
  const skills = useFeature("skills");
  return skills ? PAGES : PAGES.filter((p) => p !== "skills");
}

const skippedKey = (me: Me | null | undefined) =>
  me ? `wizards.home.skipped:${me.tenant.id}:${me.user.id}` : "";

/** The steps the person put off, as this browser keeps them now. */
export function readSkipped(me: Me | null | undefined): PageId[] {
  try {
    return JSON.parse(localStorage.getItem(skippedKey(me)) ?? "[]") as PageId[];
  } catch {
    return [];
  }
}

/** The steps the person put off, kept in this browser per organization. */
export function useSkipped(me: Me | null | undefined) {
  const key = skippedKey(me);
  const [skipped, setSkipped] = useState<PageId[]>(() => readSkipped(me));
  const write = (next: PageId[]) => {
    setSkipped(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // kept for this visit only
    }
  };
  return [skipped, write] as const;
}

/** Which steps are done, from what the studio holds. Null: not known yet. */
export function useDone(me: Me | null | undefined, space: Space | null) {
  const knowledge = useKnowledge(space?.id);
  const connections = useSpaceConnections(space?.id ?? "");
  const skills = useSkills(space?.id);
  const managed = me?.mode === "managed";
  const organization = useQuery({
    queryKey: ["organization", me?.tenant.id],
    queryFn: () => api.get<Organization>("/api/studio/organization"),
    enabled: managed,
  });
  if (
    !me ||
    !space ||
    knowledge.isPending ||
    connections.isPending ||
    skills.isPending ||
    (managed && organization.isPending)
  ) {
    return null;
  }
  const people =
    (organization.data?.members.length ?? 1) + (organization.data?.invitations.length ?? 0);
  return {
    info: Boolean(space.brand.name?.trim()) || space.brandFrom === "root",
    knowledge: (knowledge.data?.items.length ?? 0) > 0,
    connections: (connections.data?.connections.length ?? 0) > 0,
    skills: (skills.data?.skills.length ?? 0) > 0,
    team: managed ? people > 1 : Boolean(me.account?.signedIn),
  } satisfies Record<PageId, boolean>;
}

/** A step's name and line as the list shows them; on a local install the team is the organization. */
export function step(me: Me, page: PageId): { title: string; line: string } {
  const id = page === "team" && me.mode === "local" ? "connect" : page;
  return {
    title: t(`start.step.${id}` as Key),
    line: t(`start.step.${id}.line` as Key),
  };
}

/** Where a step is done: Info for the first, the step's page for the others. */
export function stepPath(me: Me, page: PageId): string {
  if (page === "info") {
    return "/space/info";
  }
  return page === "team" && me.mode === "local" ? "/settings/account" : GO[page];
}

/**
 * Hands the setup's state to Goose while it is open: the steps, which are done or put off, and
 * the one the person is on. Mounted once in the frame; renders nothing.
 */
export default function SetupReporter() {
  const me = useMe().data;
  const admin = useIsAdmin();
  const { space } = useCurrentSpace();
  const pages = usePages();
  const done = useDone(me, space as Space | null);
  const skipped = readSkipped(me);
  // Read again on every page: what was put off on Home is in this browser's storage.
  useLocation();
  const open = done ? pages.filter((p) => !done[p]) : [];
  const ahead = open.filter((p) => !skipped.includes(p));
  const progress =
    me && done && admin && open.length
      ? {
          current: ahead[0] ?? null,
          steps: pages.map((p) => ({
            id: p,
            title: step(me, p).title,
            done: done[p],
            skipped: skipped.includes(p),
            to: stepPath(me, p),
          })),
        }
      : undefined;
  // Kept as text, so the snapshot changes only when the setup does.
  const json = JSON.stringify(progress ?? null);
  useEffect(() => {
    setSetupProgress(JSON.parse(json) ?? undefined);
  }, [json]);
  useEffect(() => () => setSetupProgress(undefined), []);
  return null;
}
