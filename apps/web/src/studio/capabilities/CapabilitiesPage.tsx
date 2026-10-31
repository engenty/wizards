import { featureOn } from "@engenty/wizards-shared/features";
import { Toolbox } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useFeature, useFeatures } from "../../lib/features";
import { t } from "../../lib/i18n";
import { useCurrentSpace, useIsAdmin } from "../../lib/session";
import { cn, Empty } from "../../ui";
import { scrollRoot, useCrumbs } from "../AppFrame";
import {
  BackRow,
  LevelHead,
  LevelList,
  SettingsMenuContext,
  stepClass,
  useNarrow,
  useStepDirection,
} from "../settings-menu";
import { useSkills } from "../space/Skills";
import { useSpaceConnections } from "./ConnectorsSection";
import { shownSections } from "./sections";

/** The height of the page's scroll container: the menu beside the page scrolls within it. */
function useScrollRootHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const root = scrollRoot();
    const measure = () => setHeight(root.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return height;
}

/**
 * Fähigkeiten at /capabilities/<section>, behind the `capabilities` switch: what the space's
 * wizards, chats and Goose may use. The left container shows one level at a time, as the space
 * page does: the sections (`sections.ts`), or the menu of the one that is open. On a phone the
 * menu and the page take turns.
 */
export function CapabilitiesPage() {
  const on = useFeature("capabilities");
  const features = useFeatures();
  const { section: param } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { space, loading } = useCurrentSpace();
  const narrow = useNarrow();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  // Back up to the sections, while the section's page stays; another section opens its menu again.
  const [upAt, setUpAt] = useState<string | null>(null);
  const admin = useIsAdmin();
  const sections = shownSections((name) => featureOn(features, name), admin);
  const open = sections.find((s) => s.id === param);
  // How many skills and connections the space has, beside their rows.
  const skills = useSkills(sections.some((s) => s.id === "skills") ? space?.id : undefined);
  const connections = useSpaceConnections(space?.id ?? "");
  const counts: Record<string, number | undefined> = {
    skills: skills.data?.skills.length,
    connectors: connections.data?.connections.length,
  };
  const entries = sections.map((s) => ({
    id: s.id,
    label: t(s.label),
    icon: s.icon,
    // A section without a menu has only its page: a phone goes there at once.
    to: s.menu === false && narrow ? `/capabilities/${s.id}?show=page` : `/capabilities/${s.id}`,
    count: counts[s.id],
  }));
  const entry = entries.find((e) => e.id === open?.id);
  // A phone: 1 the section's menu, 2 the page.
  const phone = params.get("show") || params.has("setup") ? 2 : 1;
  const level = open && open.menu !== false && upAt !== open.id ? 1 : 0;
  const levelStep = useStepDirection(level);
  const pageStep = useStepDirection(phone);
  const menu = useMemo(() => ({ slot, narrow, setDetail }), [slot, narrow]);
  const rootHeight = useScrollRootHeight();

  useCrumbs([
    { label: t("nav.capabilities"), to: "/capabilities" },
    ...(entry ? [{ label: entry.label, to: entry.to }] : []),
    ...(entry && detail ? [{ label: detail }] : []),
  ]);

  if (!on) {
    return <Navigate to="/" replace />;
  }
  // Entdecken is the overview's second tab: an old or shared address opens it there.
  if (param === "discover") {
    const search = new URLSearchParams(location.search);
    search.set("tab", "discover");
    return <Navigate to={{ pathname: "/capabilities/overview", search: `?${search}` }} replace />;
  }
  // `/capabilities`, or a section not built yet: the first that is.
  if (!open && sections[0]) {
    return (
      <Navigate
        to={{ pathname: `/capabilities/${sections[0].id}`, search: location.search }}
        replace
      />
    );
  }

  const Element = open?.element;
  return (
    <SettingsMenuContext.Provider value={menu}>
      <div className="animate-rise">
        <div className="grid gap-6 md:grid-cols-[10.5rem_minmax(0,1fr)] md:gap-5 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
          <aside
            className={cn(
              "menu-scroll min-w-0 md:sticky md:top-6 md:self-start md:overflow-y-auto md:overscroll-contain",
              narrow && phone === 2 && "hidden",
              narrow && pageStep === "back" && stepClass("back"),
            )}
            // A menu longer than the page's frame scrolls on its own, beside the page, and keeps
            // the room of Goose's docked card below its last row.
            style={
              !narrow && rootHeight
                ? { maxHeight: rootHeight - 48, paddingBottom: "var(--assistant-dock, 0px)" }
                : undefined
            }
          >
            <LevelHead
              title={t("nav.capabilities")}
              open={level === 1 ? (entry ?? null) : null}
              // With one section there is no level above it to go back to.
              onBack={sections.length > 1 ? () => setUpAt(open?.id ?? null) : undefined}
              root={{
                icon: Toolbox,
                label: t("nav.capabilities"),
              }}
            />
            <div key={level} className={cn(stepClass(levelStep))}>
              {level === 0 ? (
                <LevelList
                  entries={entries}
                  current={entry}
                  onPick={(picked) => {
                    setUpAt(null);
                    // A section without a menu, picked again: its page from the top (all skills,
                    // not the one open); on a phone the page behind the list.
                    if (open?.menu === false) {
                      navigate(picked.to);
                    }
                  }}
                />
              ) : (
                <div ref={setSlot} />
              )}
            </div>
          </aside>
          <div
            className={cn(
              "min-w-0",
              narrow && phone < 2 && "hidden",
              narrow && pageStep === "deeper" && stepClass("deeper"),
            )}
          >
            {narrow && entry ? (
              <div className="mb-3">
                <BackRow label={entry.label} onBack={() => navigate(entry.to)} />
              </div>
            ) : null}
            {Element ? <Element /> : null}
            {/* No space yet: nothing is built here, and no local install has sent one. */}
            {!(space || loading) ? <Empty>{t("settings.noSpace")}</Empty> : null}
          </div>
        </div>
      </div>
    </SettingsMenuContext.Provider>
  );
}
