import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, FileText, Upload } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Mascot } from "../brand";
import { EngentyLogoMark } from "../engenty/logo";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { pendingWish, useCurrentProject, useMe } from "../lib/session";
import { useGround } from "../lib/theme";
import { cn } from "../ui";
import { LangSwitch } from "./LangSwitch";

/** The ground the wizard stands on and the text on white, as on the landing page and the setup. */
const GROUND = "oklch(50% 0.2 262)";
const GROUND_INK = "oklch(32% 0.15 262)";
const CREAM = "oklch(90% 0.1 80)";

const ON_GROUND = {
  "--on": "white",
  "--dot": CREAM,
  "--ink-2": "oklch(96% 0.02 262)",
  "--ink-3": "oklch(90% 0.035 262)",
  "--moss": "oklch(90% 0.14 150)",
  "--rose": "oklch(89% 0.09 45)",
} as CSSProperties;

type Step = 1 | 2 | 3 | 4;
/**
 * The pages, in the address (`?page=site`): the browser's Back and Forward go between them.
 * Step 1 has three pages the dots count as one: what for, the questions that fit, the name.
 */
type Page = "kind" | "details" | "team" | "site" | "know" | "space";
const STEP_OF: Record<Page, Step> = { kind: 1, details: 1, team: 1, site: 2, know: 3, space: 4 };
const isPage = (value: string | null): value is Page =>
  value !== null && Object.hasOwn(STEP_OF, value);

const FIELD =
  "w-full rounded-[18px] border border-white/30 bg-white/15 px-6 py-5 text-[1.375rem] text-white outline-none placeholder:text-white/55 focus:border-white/60";

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <EngentyLogoMark size={28} />
      <span className="font-display font-semibold text-[1.0625rem] tracking-tight">
        engenty
        <span className="mr-[0.09em] ml-[0.06em] text-(color:--dot)">.</span>
        <span className="font-normal text-white/70">wizards</span>
      </span>
    </span>
  );
}

/** The white pill that moves the wizard on. */
function Next({
  children,
  busy,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  busy?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={busy}
      onClick={onClick}
      className="inline-flex h-13 cursor-pointer items-center gap-2.5 rounded-full bg-white px-7 font-semibold text-[1rem] transition hover:bg-white/90 disabled:cursor-default disabled:opacity-70"
      style={{ color: GROUND_INK }}
    >
      {children}
      <ArrowRight className="size-[18px]" />
    </button>
  );
}

/** The quiet way on, beside the pill: skip, or another way to answer. */
function Quiet({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer font-semibold text-[0.9375rem] text-white/85 transition hover:text-white"
    >
      {children}
    </button>
  );
}

/** Four dots: where the person stands in the wizard. */
function Dots({ step }: { step: Step }) {
  return (
    <span
      className="ml-auto inline-flex gap-1.5"
      role="img"
      aria-label={t("onboard.step", { n: step })}
    >
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={cn("size-2 rounded-full", n === step ? "bg-white" : "bg-white/40")}
        />
      ))}
    </span>
  );
}

// --- Who the team is: what it uses engenty for, and the questions that fit ----------------

type Kind = "personal" | "club" | "small" | "corp";

const KINDS: { kind: Kind; label: Key; sub: Key }[] = [
  { kind: "personal", label: "onboard.kindPersonal", sub: "onboard.kindPersonalSub" },
  { kind: "club", label: "onboard.kindClub", sub: "onboard.kindClubSub" },
  { kind: "small", label: "onboard.kindSmall", sub: "onboard.kindSmallSub" },
  { kind: "corp", label: "onboard.kindCorp", sub: "onboard.kindCorpSub" },
];

/** Addresses anyone can have: they say nothing about a business. */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "gmx.at",
  "gmx.de",
  "gmx.net",
  "web.de",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "yahoo.de",
  "aon.at",
  "a1.net",
  "chello.at",
  "t-online.de",
  "proton.me",
  "protonmail.com",
]);

/** What the address says: free mail is someone on their own, a club's domain a club, else a business. */
function guessKind(email: string): { kind: Kind | null; domain: string } {
  const domain = (email.split("@")[1] ?? "").trim().toLowerCase();
  if (!domain) {
    return { kind: null, domain };
  }
  if (FREE_MAIL.has(domain)) {
    return { kind: "personal", domain };
  }
  if (/(verein|club|klub|^sv-|^fc-|^ff-|feuerwehr|musik|chor)/.test(domain)) {
    return { kind: "club", domain };
  }
  return { kind: "small", domain };
}

/** People or members, as ranges; kept as these ids, shown in the reader's numbers. */
const SIZES: Record<Exclude<Kind, "personal">, string[]> = {
  club: ["0-50", "50-250", "250-1000", "1000+"],
  small: ["1", "2-9", "10-49"],
  corp: ["50-249", "250-999", "1000+"],
};
const num = (n: string) => Number(n).toLocaleString(lang);
const sizeLabel = (id: string) => {
  if (id === "1") {
    return t("onboard.justMe");
  }
  if (id.endsWith("+")) {
    return `${num(id.slice(0, -1))}+`;
  }
  const [from, to] = id.split("-");
  return from === "0" ? `≤ ${num(to)}` : `${num(from)}–${num(to)}`;
};

const CLUB_KINDS = [
  "sport",
  "culture",
  "social",
  "education",
  "environment",
  "rescue",
  "other",
] as const;
const CLUB_ROLES = ["chair", "board", "treasurer", "secretary", "member"] as const;
const CORP_ROLES = ["management", "it", "marketing", "sales", "operations", "other"] as const;

interface Profile {
  kind: Kind | null;
  size: string | null;
  sector: string;
  role: string | null;
  need: string;
  legalName: string;
  phone: string;
}

const SMALL_FIELD =
  "w-full rounded-[14px] border border-white/30 bg-white/15 px-4 py-3 text-[1.0625rem] text-white outline-none placeholder:text-white/55 focus:border-white/60";

/** One of the four answers to "what for": a card that shows when it is picked. */
function Choice({
  picked,
  label,
  sub,
  onClick,
}: {
  picked: boolean;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onClick}
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-[18px] border px-5 py-4 text-left transition",
        picked ? "border-white bg-white/25" : "border-white/30 bg-white/10 hover:bg-white/15",
      )}
    >
      <span className="font-display font-semibold text-[1.125rem]">{label}</span>
      <span className="text-[0.875rem] text-white/80">{sub}</span>
    </button>
  );
}

/** Pick one: the club's kind, a range, a role. */
function Chips<T extends string>({
  label,
  options,
  value,
  text,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: string | null;
  text: (id: T) => string;
  onChange: (id: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[0.9375rem] text-white/85">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className={cn(
              "cursor-pointer rounded-full border px-4 py-2 text-[0.9375rem] transition",
              value === id ? "border-white bg-white" : "border-white/30 hover:bg-white/15",
            )}
            style={value === id ? { color: GROUND_INK } : undefined}
          >
            {text(id)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

interface Outcome {
  name: string;
  about: boolean;
  colors: number;
  logo: boolean;
}

type UploadState = { name: string; state: "uploading" | "done" | "failed" };

/**
 * A state of the onboarding kept in the tab's session storage, so a reload or the browser's
 * Back and Forward find the answers as they were typed: without it a page went back empty, and
 * going on from it saved the blanks over what the team had already given. `forget` clears it
 * all once the onboarding is done. Storage that refuses (a private window, a full quota) only
 * means the answers live as long as the page.
 */
function useKept<T>(
  user: string,
  name: string,
  initial: T,
): [T, (value: T | ((old: T) => T)) => void] {
  const key = `${KEPT}${user}:${name}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // kept in memory only
    }
  }, [key, value]);
  return [value, setValue];
}

const KEPT = "wizards.onboarding:";

function forgetKept() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(KEPT)) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    // nothing kept
  }
}

/**
 * The first visit of a team's studio in the cloud, as a wizard of the product's own kind: one
 * question per page, the engenty beside it. Who the team is, where its website is, what the
 * wizards should know, and what the space is that holds all of it. Every page but the first
 * can be skipped; everything can be changed later under Space and Settings.
 */
export function OnboardingPage() {
  useGround(GROUND);
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { project } = useCurrentProject();
  const user = me.data?.user.id ?? "";
  const [team, setTeam] = useKept(user, "team", "");
  const [site, setSite] = useKept(user, "site", "");
  const [line, setLine] = useKept<string | null>(user, "line", null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  // A wish typed before signing in (GuestStartPage): in sight here, built on "new" right after.
  const [wish] = useState(pendingWish);
  const [guess] = useState(() => guessKind(me.data?.user.email ?? ""));
  const [profile, setProfile] = useKept<Profile>(user, "profile", {
    kind: guess.kind,
    size: null,
    sector: "",
    role: null,
    need: "",
    legalName: "",
    phone: "",
  });
  const [params, setParams] = useSearchParams();
  const asked = params.get("page");
  // The questions that fit need the answer before them (a reload starts that page anew).
  const page: Page = isPage(asked) && !(asked === "details" && !profile.kind) ? asked : "kind";
  const step = STEP_OF[page];
  /** On to another page, as a step in the browser's history. */
  const go = (next: Page) =>
    setParams((current) => {
      const query = new URLSearchParams(current);
      query.set("page", next);
      return query;
    });
  const answer = (patch: Partial<Profile>) => setProfile((p) => ({ ...p, ...patch }));
  // Kept at the Manage-App with the team; a failure here holds nobody up.
  const keep = useMutation({
    mutationFn: (website: string | undefined) =>
      api.put("/api/studio/team/profile", {
        kind: profile.kind,
        size: profile.size,
        sector: profile.sector.trim() || null,
        role: profile.role,
        need: profile.need.trim() || null,
        legalName: profile.legalName.trim() || null,
        phone: profile.phone.trim() || null,
        website: website?.trim() || null,
      }),
  });
  /** Just them, no business or club: the pages ask about the person, not a team or a brand. */
  const personal = profile.kind === "personal";
  /** On to the website, with the address's domain where it is a business's. */
  const toSite = () => {
    if (!site && guess.domain && profile.kind !== "personal" && !FREE_MAIL.has(guess.domain)) {
      setSite(guess.domain);
    }
    go("site");
  };

  const rename = useMutation({
    mutationFn: (name: string) => api.put("/api/studio/team", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
  const read = useMutation({
    mutationFn: (url: string) =>
      api.post<Outcome>(`/api/studio/projects/${project?.id}/website`, { url }),
    onSuccess: async (result) => {
      setOutcome(result);
      await qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const about = useMutation({
    mutationFn: (text: string) =>
      api.patch(`/api/studio/projects/${project?.id}`, { brand: { about: text } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const finish = useMutation({
    mutationFn: () => api.post("/api/studio/onboarding/done"),
    onSuccess: async () => {
      forgetKept();
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/new", { replace: true });
    },
  });

  // A sign-up by e-mail link has no name yet: the address is no way to greet someone.
  const name = me.data?.user.name ?? "";
  const firstName = name.includes("@") ? "" : name.split(" ")[0];

  const addFiles = async (files: FileList | null) => {
    if (!files || !project) {
      return;
    }
    for (const file of Array.from(files)) {
      setUploads((u) => [...u, { name: file.name, state: "uploading" }]);
      try {
        await api.upload(`/api/studio/projects/${project.id}/files?kind=document`, file);
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, state: "done" } : x)));
      } catch {
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, state: "failed" } : x)));
      }
    }
    await qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const details = outcome
    ? [
        outcome.about ? t("onboard.readAbout") : "",
        outcome.colors ? t("onboard.readColors", { n: outcome.colors }) : "",
        outcome.logo ? t("onboard.readLogo") : "",
      ].join("")
    : "";

  return (
    <div
      className="flex min-h-dvh flex-col px-6 text-white sm:px-10"
      style={{ ...ON_GROUND, background: GROUND }}
    >
      <header className="flex items-center justify-between pt-6 sm:pt-8">
        <Wordmark />
        <LangSwitch tone="ground" ink={GROUND_INK} />
      </header>
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 py-10 lg:grid-cols-[5fr_7fr] lg:gap-12">
        <div className="flex flex-col items-center gap-8 max-lg:order-first">
          <Mascot kind="drop" size={240} fluffy coat="fur" />
          {wish ? (
            <figure className="w-full max-w-sm rounded-[18px] bg-white/15 px-5 py-4">
              <figcaption className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
                {t("onboard.wish")}
              </figcaption>
              <blockquote className="mt-1.5 line-clamp-6 whitespace-pre-line break-words text-[1rem] leading-relaxed">
                {wish}
              </blockquote>
              <p className="mt-2 text-[0.8125rem] text-white/75">{t("onboard.wishNext")}</p>
            </figure>
          ) : null}
        </div>
        <div key={page} className="flex min-w-0 max-w-2xl animate-rise flex-col gap-5">
          {page === "kind" ? (
            <form
              className="contents"
              onSubmit={(e) => {
                e.preventDefault();
                if (profile.kind) {
                  go("details");
                }
              }}
            >
              <p className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
                {firstName ? t("onboard.kicker1", { name: firstName }) : t("onboard.kicker1Anon")}
              </p>
              <h1 className="font-display font-bold text-[2.5rem] leading-[1.05] tracking-[-0.02em] sm:text-[3.25rem]">
                {t("onboard.kind")}
              </h1>
              <p className="text-[1.0625rem] text-white/90 leading-relaxed">
                {t("onboard.kindSub")}
              </p>
              {guess.kind ? (
                <p className="text-[0.9375rem] text-white/80">
                  {t("onboard.guess", {
                    domain: guess.domain,
                    kind: t(KINDS.find((k) => k.kind === guess.kind)?.label ?? "onboard.kindSmall"),
                  })}
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {KINDS.map((k) => (
                  <Choice
                    key={k.kind}
                    picked={profile.kind === k.kind}
                    label={t(k.label)}
                    sub={t(k.sub)}
                    onClick={() =>
                      answer({ kind: k.kind, size: k.kind === profile.kind ? profile.size : null })
                    }
                  />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-5">
                <Next type="submit">{t("onboard.continue")}</Next>
                <Dots step={1} />
              </div>
            </form>
          ) : null}

          {page === "details" && profile.kind ? (
            <form
              className="contents"
              onSubmit={(e) => {
                e.preventDefault();
                keep.mutate(undefined);
                if (profile.kind === "corp" && profile.legalName.trim() && !team) {
                  setTeam(profile.legalName.trim());
                }
                // Just them: no team to name (the account page renames it, should one come).
                if (profile.kind === "personal") {
                  toSite();
                } else {
                  go("team");
                }
              }}
            >
              <p className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
                {firstName ? t("onboard.kicker1", { name: firstName }) : t("onboard.kicker1Anon")}
              </p>
              <h1 className="font-display font-bold text-[2.25rem] leading-[1.05] tracking-[-0.02em] sm:text-[2.75rem]">
                {t(
                  profile.kind === "personal"
                    ? "onboard.personalTitle"
                    : profile.kind === "club"
                      ? "onboard.clubTitle"
                      : "onboard.businessTitle",
                )}
              </h1>
              {profile.kind === "personal" ? (
                <textarea
                  value={profile.need}
                  onChange={(e) => answer({ need: e.target.value })}
                  placeholder={t("onboard.personalPlaceholder")}
                  rows={3}
                  maxLength={2000}
                  aria-label={t("onboard.personalTitle")}
                  className={cn(FIELD, "resize-none text-[1.125rem] leading-relaxed")}
                />
              ) : null}
              {profile.kind === "club" ? (
                <>
                  <Chips
                    label={t("onboard.clubKind")}
                    options={CLUB_KINDS}
                    value={profile.sector}
                    text={(id) => t(`onboard.club.${id}`)}
                    onChange={(id) => answer({ sector: id })}
                  />
                  <Chips
                    label={t("onboard.members")}
                    options={SIZES.club}
                    value={profile.size}
                    text={sizeLabel}
                    onChange={(id) => answer({ size: id })}
                  />
                  <Chips
                    label={t("onboard.yourRole")}
                    options={CLUB_ROLES}
                    value={profile.role}
                    text={(id) => t(`onboard.role.${id}`)}
                    onChange={(id) => answer({ role: id })}
                  />
                </>
              ) : null}
              {profile.kind === "small" ? (
                <>
                  <Chips
                    label={t("onboard.people")}
                    options={SIZES.small}
                    value={profile.size}
                    text={sizeLabel}
                    onChange={(id) => answer({ size: id })}
                  />
                  <label className="flex flex-col gap-2 text-[0.9375rem] text-white/85">
                    {t("onboard.sector")}
                    <input
                      value={profile.sector}
                      onChange={(e) => answer({ sector: e.target.value })}
                      placeholder={t("onboard.sectorPlaceholder")}
                      maxLength={120}
                      className={SMALL_FIELD}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-[0.9375rem] text-white/85">
                    <span>
                      {t("onboard.need")}{" "}
                      <span className="text-white/60">{t("onboard.optional")}</span>
                    </span>
                    <textarea
                      value={profile.need}
                      onChange={(e) => answer({ need: e.target.value })}
                      placeholder={t("onboard.needPlaceholder")}
                      rows={2}
                      maxLength={2000}
                      className={cn(SMALL_FIELD, "resize-none")}
                    />
                  </label>
                </>
              ) : null}
              {profile.kind === "corp" ? (
                <>
                  <Chips
                    label={t("onboard.people")}
                    options={SIZES.corp}
                    value={profile.size}
                    text={sizeLabel}
                    onChange={(id) => answer({ size: id })}
                  />
                  <Chips
                    label={t("onboard.yourRole")}
                    options={CORP_ROLES}
                    value={profile.role}
                    text={(id) => t(`onboard.role.${id}`)}
                    onChange={(id) => answer({ role: id })}
                  />
                  <label className="flex flex-col gap-2 text-[0.9375rem] text-white/85">
                    {t("onboard.legalName")}
                    <input
                      value={profile.legalName}
                      onChange={(e) => answer({ legalName: e.target.value })}
                      placeholder={t("onboard.legalNamePlaceholder")}
                      maxLength={200}
                      autoComplete="organization"
                      className={SMALL_FIELD}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-[0.9375rem] text-white/85">
                    <span>
                      {t("onboard.phone")}{" "}
                      <span className="text-white/60">{t("onboard.phoneWhy")}</span>
                    </span>
                    <input
                      type="tel"
                      value={profile.phone}
                      onChange={(e) =>
                        answer({ phone: e.target.value.replace(/[^+0-9 ()/.-]/g, "") })
                      }
                      placeholder="+43 …"
                      maxLength={40}
                      autoComplete="tel"
                      className={SMALL_FIELD}
                    />
                  </label>
                </>
              ) : null}
              <div className="flex flex-wrap items-center gap-5">
                <Next type="submit" busy={keep.isPending}>
                  {t("onboard.continue")}
                </Next>
                <Quiet
                  // Back the way the browser goes, unless this page was opened by its address.
                  onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : go("kind"))}
                >
                  {t("onboard.back")}
                </Quiet>
                <Dots step={1} />
              </div>
            </form>
          ) : null}

          {page === "team" ? (
            <form
              className="contents"
              onSubmit={(e) => {
                e.preventDefault();
                const name = team.trim();
                if (name) {
                  rename.mutate(name, { onSuccess: toSite });
                } else {
                  toSite();
                }
              }}
            >
              <p className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
                {firstName ? t("onboard.kicker1", { name: firstName }) : t("onboard.kicker1Anon")}
              </p>
              <h1 className="font-display font-bold text-[2.5rem] leading-[1.05] tracking-[-0.02em] sm:text-[3.25rem]">
                {t("onboard.team")}
              </h1>
              <p className="text-[1.0625rem] text-white/90 leading-relaxed">
                {t("onboard.teamSub")}
              </p>
              <input
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                placeholder={t("onboard.teamPlaceholder")}
                maxLength={80}
                aria-label={t("onboard.team")}
                className={FIELD}
              />
              <div className="flex flex-wrap items-center gap-5">
                <Next type="submit" busy={rename.isPending}>
                  {t("onboard.continue")}
                </Next>
                <Dots step={1} />
              </div>
            </form>
          ) : null}

          {step === 2 ? (
            <>
              <p className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
                {t(personal ? "onboard.kicker2Personal" : "onboard.kicker2")}
              </p>
              <h1 className="font-display font-bold text-[2.5rem] leading-[1.05] tracking-[-0.02em] sm:text-[3.25rem]">
                {t("onboard.site")}
              </h1>
              <p className="text-[1.0625rem] text-white/90 leading-relaxed">
                {t(personal ? "onboard.siteSubPersonal" : "onboard.siteSub")}
              </p>
              {line === null ? (
                <form
                  className="contents"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const given = site.trim();
                    if (!given || read.isPending) {
                      return;
                    }
                    if (profile.kind) {
                      keep.mutate(given);
                    }
                    // A name, not an address: kept with the team, nothing to read.
                    if (!given.includes(".")) {
                      go("know");
                      return;
                    }
                    read.mutate(given);
                  }}
                >
                  <input
                    value={site}
                    onChange={(e) => setSite(e.target.value)}
                    placeholder={t(
                      personal ? "onboard.sitePlaceholderPersonal" : "onboard.sitePlaceholder",
                    )}
                    autoCapitalize="none"
                    aria-label={t("onboard.site")}
                    className={FIELD}
                  />
                  {/* A name to keep in mind is a business's or a club's. */}
                  {personal ? null : (
                    <p className="-mt-2 text-[0.875rem] text-white/75">
                      {t("onboard.siteNameHint")}
                    </p>
                  )}
                  {outcome ? (
                    <p className="flex items-center gap-2 text-[0.9375rem] text-(color:--moss)">
                      <Check className="size-4" />
                      {t("onboard.readDone", { name: outcome.name, details })}
                    </p>
                  ) : read.isError ? (
                    <p className="text-[0.9375rem] text-(color:--rose)">
                      {t("onboard.readFailed")}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-5">
                    {outcome ? (
                      <Next onClick={() => go("know")}>{t("onboard.continue")}</Next>
                    ) : (
                      <Next type="submit" busy={read.isPending}>
                        {read.isPending ? t("onboard.reading") : t("onboard.read")}
                      </Next>
                    )}
                    <Quiet onClick={() => setLine("")}>{t("onboard.line")}</Quiet>
                    <Quiet onClick={() => go("know")}>{t("onboard.skip")}</Quiet>
                    <Dots step={2} />
                  </div>
                </form>
              ) : (
                <form
                  className="contents"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = line.trim();
                    if (text) {
                      about.mutate(text, { onSuccess: () => go("know") });
                    } else {
                      go("know");
                    }
                  }}
                >
                  <textarea
                    value={line}
                    onChange={(e) => setLine(e.target.value)}
                    placeholder={t(
                      personal ? "onboard.linePlaceholderPersonal" : "onboard.linePlaceholder",
                    )}
                    rows={3}
                    maxLength={8000}
                    aria-label={t("onboard.line")}
                    className={cn(FIELD, "resize-none text-[1.125rem] leading-relaxed")}
                  />
                  <div className="flex flex-wrap items-center gap-5">
                    <Next type="submit" busy={about.isPending}>
                      {t("onboard.continue")}
                    </Next>
                    <Quiet onClick={() => setLine(null)}>{t("onboard.site")}</Quiet>
                    <Quiet onClick={() => go("know")}>{t("onboard.skip")}</Quiet>
                    <Dots step={2} />
                  </div>
                </form>
              )}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <p className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
                {t("onboard.kicker3")}
              </p>
              <h1 className="font-display font-bold text-[2.5rem] leading-[1.05] tracking-[-0.02em] sm:text-[3.25rem]">
                {t("onboard.know")}
              </h1>
              <p className="text-[1.0625rem] text-white/90 leading-relaxed">
                {t("onboard.knowSub")}
              </p>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void addFiles(e.dataTransfer.files);
                }}
                className="flex cursor-pointer flex-col items-center gap-2 rounded-[18px] border-2 border-white/45 border-dashed bg-white/10 px-6 py-7 text-center transition hover:bg-white/15"
              >
                <Upload className="size-7" />
                <span className="font-semibold text-[1.0625rem]">{t("onboard.drop")}</span>
                <span className="text-[0.875rem] text-white/80">PDF · Word · Excel · Markdown</span>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    void addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </button>
              {uploads.length ? (
                <ul className="flex flex-col gap-2">
                  {uploads.map((u) => (
                    <li
                      key={u.name}
                      className="flex items-center gap-2.5 rounded-xl bg-white/15 px-3.5 py-2.5 text-[0.875rem]"
                    >
                      <FileText className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{u.name}</span>
                      <span
                        className={cn(
                          "text-white/80",
                          u.state === "failed" ? "text-(color:--rose)" : "",
                        )}
                      >
                        {u.state === "uploading"
                          ? t("onboard.uploading")
                          : u.state === "done"
                            ? t("onboard.uploaded")
                            : t("onboard.uploadFailed")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center gap-5">
                <Next
                  busy={uploads.some((u) => u.state === "uploading")}
                  onClick={() => go("space")}
                >
                  {t("onboard.continue")}
                </Next>
                {uploads.length ? null : (
                  <Quiet onClick={() => go("space")}>{t("onboard.skip")}</Quiet>
                )}
                <Dots step={3} />
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <p className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
                {t("onboard.kicker4")}
              </p>
              <h1 className="font-display font-bold text-[2.5rem] leading-[1.05] tracking-[-0.02em] sm:text-[3.25rem]">
                {t("onboard.space")}
              </h1>
              <p className="text-[1.0625rem] text-white/90 leading-relaxed">
                {t("onboard.spaceSub", { space: project?.name ?? "" })}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["partInfo", "partInfoText", Boolean(outcome || line)],
                    ["partKnow", "partKnowText", uploads.some((u) => u.state === "done")],
                    ["partData", "partDataText", false],
                    ["partResults", "partResultsText", false],
                  ] as const
                ).map(([title, text, done]) => (
                  <div
                    key={title}
                    className="flex flex-col gap-1.5 rounded-2xl border border-white/20 bg-white/10 px-4.5 py-4"
                  >
                    <span className="flex items-center gap-2 font-semibold text-[1rem]">
                      {done ? <Check className="size-4 text-(color:--moss)" /> : null}
                      {t(`onboard.${title}` as Key)}
                    </span>
                    <span className="text-[0.84375rem] text-white/85 leading-snug">
                      {t(`onboard.${text}` as Key)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-5">
                <Next busy={finish.isPending} onClick={() => finish.mutate()}>
                  {t("onboard.build")}
                </Next>
                <Dots step={4} />
              </div>
            </>
          ) : null}
        </div>
      </main>
      <footer className="mx-auto flex w-full max-w-6xl items-center justify-between pb-6 text-[0.75rem] text-white/55 sm:pb-8">
        <span>engenty.wizards</span>
        <span aria-hidden="true" className="size-[3px] bg-(color:--dot)" />
      </footer>
    </div>
  );
}
