import { featureOn } from "@engenty/wizards-shared/features";
import { type ReactNode, useEffect } from "react";
import { Navigate, useLocation } from "react-router";
import { useFeature } from "../lib/features";
import { setMembersStudio } from "../lib/mode";
import { type Me, useCurrentSpace, useIsAdmin } from "../lib/session";

/**
 * Members in the Studio, one rule per space: „Mitglieder dürfen ins Studio“ (docs/plans/
 * capabilities.md, "Who sees the place"). Behind `capabilities`. The runtime refuses what a
 * member may not do (services/members-studio.ts); the studio hides it.
 */

/** Whether the person sees the Studio's reduced set: a member of an organization, the switch on. */
export function useMemberStudio(): boolean {
  const admin = useIsAdmin();
  return useFeature("capabilities") && !admin;
}

/** The Studio's own addresses: a member without the rule finds Work there instead. */
const STUDIO_ADDRESSES = /^\/($|new$|edit\/|space(\/|$)|skills$|capabilities(\/|$))/;

/**
 * Around every page of the studio: tells the mode switch whether the space at hand opens its
 * Studio to members, and sends a member who opens a Studio address of a closed space to Work.
 */
export function MembersStudio({ me, children }: { me: Me; children: ReactNode }) {
  const { space, loading } = useCurrentSpace();
  const { pathname } = useLocation();
  const open = space?.studio ?? false;
  useEffect(() => setMembersStudio(open), [open]);
  const closed =
    me.mode === "managed" &&
    me.tenant.role === "member" &&
    featureOn(me.features, "capabilities") &&
    featureOn(me.features, "workMode") &&
    !loading &&
    !open;
  return closed && STUDIO_ADDRESSES.test(pathname) ? <Navigate to="/work" replace /> : children;
}
