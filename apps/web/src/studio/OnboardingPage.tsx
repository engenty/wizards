import {
  ADDRESS_NAMES,
  type AddressKind,
  addressKind,
  addressUrl,
  FREE_MAIL,
} from "@engenty/wizards-shared/addresses";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, FileText, Upload } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Mascot } from "../brand";
import { EngentyLogoMark } from "../engenty/logo";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { initialsOf, pendingWish, useCurrentProject, useMe, useProjects } from "../lib/session";
import { useDictation, useDictationSettings } from "../lib/speech";
import { useGround } from "../lib/theme";
import { cn } from "../ui";
import { DictationButton } from "../ui/composer";
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

type Step = 1 | 2 | 3 | 4 | 5;
/**
 * The pages, in the address (`?page=site`): the browser's Back and Forward go between them.
 * The first step has two pages the dots count as one: what for, and the name.
 */
type Page = "kind" | "organization" | "site" | "details" | "know" | "space";
const STEP_OF: Record<Page, Step> = {
  kind: 1,
  organization: 1,
  site: 2,
  details: 3,
  know: 4,
  space: 5,
};
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

/** The dots: where the person stands in the wizard, out of `total` steps. */
function Dots({ step, total = 4 }: { step: Step; total?: number }) {
  return (
    <span
      className="ml-auto inline-flex gap-1.5"
      role="img"
      aria-label={t("onboard.step", { n: step, total })}
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <span
          key={n}
          className={cn("size-2 rounded-full", n === step ? "bg-white" : "bg-white/40")}
        />
      ))}
    </span>
  );
}

// --- Who the organization is: what it uses engenty for, and the questions that fit ----------------

type Kind = "personal" | "club" | "small" | "corp";

const KINDS: { kind: Kind; label: Key; sub: Key }[] = [
  { kind: "personal", label: "onboard.kindPersonal", sub: "onboard.kindPersonalSub" },
  { kind: "club", label: "onboard.kindClub", sub: "onboard.kindClubSub" },
  { kind: "small", label: "onboard.kindSmall", sub: "onboard.kindSmallSub" },
  { kind: "corp", label: "onboard.kindCorp", sub: "onboard.kindCorpSub" },
];

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
  /** What a person on their own wishes for. */
  need: string;
  /** “Wünsche oder Fragen” of an organization: a question reaches the team. */
  questions: string;
  phone: string;
}

/** An address the studio offers to tick, as `/api/studio/onboarding/find` names it. */
interface FoundAddress {
  url: string;
  kind: AddressKind;
  title: string;
  source: "email" | "web";
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
  fonts: number;
  logo: boolean;
  facts: number;
  assets: number;
}

type UploadState = { name: string; state: "uploading" | "done" | "failed" };

/**
 * A state of the onboarding kept in the tab's session storage, so a reload or the browser's
 * Back and Forward find the answers as they were typed: without it a page went back empty, and
 * going on from it saved the blanks over what the organization had already given. `forget` clears it
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
 * The first visit of a studio in the cloud. Someone new to the studio in an organization nobody
 * has set up goes through all of it; someone the studio knows gets the organization's questions
 * alone, in its name; everyone else one page that says where they are.
 */
export function OnboardingPage() {
  useGround(GROUND);
  const me = useMe();
  return me.data?.onboarding === "welcome" ? <Welcome /> : <Questions />;
}

/**
 * The organization's questions, as a wizard of the product's own kind: one question per page, the
 * engenty beside it. What it is, where its website is, what the wizards should know and, for
 * someone new to the studio, what the space is that holds all of it. Every page but the first
 * can be skipped; everything can be changed later under Space and Settings.
 */
function Questions() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { project } = useCurrentProject();
  const user = me.data?.user.id ?? "";
  /** Known to the studio: the organization's questions alone, no greeting and no space page. */
  const known = me.data?.onboarding === "organization";
  const steps = known ? 4 : 5;
  /** The organization's name, once it has one of its own (not the one it got at sign-up). */
  const named = me.data?.startingName ? null : (me.data?.tenant.name ?? null);
  const [organization, setOrganization] = useKept(user, "organization", "");
  const [line, setLine] = useKept<string | null>(user, "line", null);
  /** The found addresses the person ticked, and the ones they typed. */
  const [ticked, setTicked] = useKept<string[] | null>(user, "ticked", null);
  const [own, setOwn] = useKept<string[]>(user, "own", [""]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  // A wish typed before signing in (GuestStartPage): in sight here, built on "new" right after.
  const [wish] = useState(pendingWish);
  // The person's address says something about their own organization, not one they joined.
  const [guess] = useState(() =>
    known ? { kind: null, domain: "" } : guessKind(me.data?.user.email ?? ""),
  );
  const [profile, setProfile] = useKept<Profile>(user, "profile", {
    kind: guess.kind,
    size: null,
    sector: "",
    role: null,
    need: "",
    questions: "",
    phone: "",
  });
  const [params, setParams] = useSearchParams();
  const asked = params.get("page");
  // The pages after the first need its answer (a reload starts that page anew).
  const page: Page =
    isPage(asked) && (asked === "kind" || profile.kind) && !(known && asked === "space")
      ? asked
      : "kind";
  /** On to another page, as a step in the browser's history. */
  const go = (next: Page) =>
    setParams((current) => {
      const query = new URLSearchParams(current);
      query.set("page", next);
      return query;
    });
  const answer = (patch: Partial<Profile>) => setProfile((p) => ({ ...p, ...patch }));
  /** Just them, no business or club: the pages ask about the person, not an organization or a brand. */
  const personal = profile.kind === "personal";
  /** The name the questions use: the organization's own, or the one just given. */
  const title = named ?? (organization.trim() || null);

  // The name and site of the person's e-mail domain, for the name page.
  const suggest = useQuery({
    queryKey: ["onboarding", "suggest"],
    queryFn: () =>
      api.get<{ site: { name: string; url: string } | null }>("/api/studio/onboarding/suggest"),
    enabled: !known && !named && Boolean(profile.kind) && !personal,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const suggested = suggest.data?.site ?? null;
  useEffect(() => {
    if (suggested && !organization) {
      setOrganization(suggested.name);
    }
  }, [suggested, organization, setOrganization]);
  // The organization's addresses: its e-mail domain's site and a search for its name. Never a person's.
  const find = useQuery({
    queryKey: ["onboarding", "find", title],
    queryFn: () =>
      api.post<{ addresses: FoundAddress[] }>("/api/studio/onboarding/find", { name: title, lang }),
    enabled: page === "site" && !personal && Boolean(title),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const found = find.data?.addresses ?? [];
  // What is ticked at first: the e-mail domain's site and what the search found, one website only.
  const picked =
    ticked ??
    found
      .filter(
        (a, i) => a.kind !== "website" || !found.slice(0, i).some((b) => b.kind === "website"),
      )
      .map((a) => a.url);
  const typed = own.map((o) => o.trim()).filter((o) => addressUrl(o));
  const chosen = [...picked, ...typed];
  /** Nothing found and nothing typed: the person says in a few sentences what they do. */
  const nothing = !personal && find.isSuccess && found.length === 0;
  /** Asked for an address after all, where nothing was found. */
  const [anyway, setAnyway] = useKept(user, "anyway", false);
  const writing = line !== null || (nothing && !typed.length && !anyway);

  // Kept at the Manage-App with the organization; a failure here holds nobody up.
  const keep = useMutation({
    mutationFn: () =>
      api.put("/api/studio/organization/profile", {
        kind: profile.kind,
        size: profile.size,
        sector: profile.sector.trim() || null,
        role: profile.role,
        need: profile.need.trim() || null,
        questions: (profile.questions ?? "").trim() || null,
        phone: profile.phone.trim() || null,
        website: chosen.find((u) => addressKind(u) === "website") ?? null,
        links: chosen,
      }),
  });
  const rename = useMutation({
    mutationFn: (name: string) => api.put("/api/studio/organization", { name }),
  });
  /** The organization's new name moves its address: on to the next page first, then the studio follows. */
  const renamed = () => {
    go("site");
    void qc.invalidateQueries({ queryKey: ["organization"] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const read = useMutation({
    mutationFn: (urls: string[]) =>
      api.post<Outcome | null>(`/api/studio/projects/${project?.id}/website`, { urls, lang }),
    onSuccess: async (result) => {
      setOutcome(
        result ?? { name: "", about: false, colors: 0, fonts: 0, logo: false, facts: 0, assets: 0 },
      );
      await qc.invalidateQueries({ queryKey: keys.spaces() });
    },
  });
  const about = useMutation({
    mutationFn: (text: string) =>
      api.patch(`/api/studio/projects/${project?.id}`, { brand: { about: text } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.spaces() }),
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
  const kicker1 =
    known && named
      ? t("onboard.kickerNew", { organization: named })
      : firstName
        ? t("onboard.kicker1", { name: firstName })
        : t("onboard.kicker1Anon");
  const kicker = (
    key: "onboard.kicker2Named" | "onboard.kicker3Named" | "onboard.kicker4Named",
    plain: Key,
  ) => (title && !personal ? t(key, { organization: title }) : t(plain));

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
    await qc.invalidateQueries({ queryKey: keys.spaces() });
  };

  const details = outcome
    ? [
        outcome.about ? t("onboard.readAbout") : "",
        outcome.colors ? t("onboard.readColors", { n: outcome.colors }) : "",
        outcome.fonts ? t("onboard.readFonts", { n: outcome.fonts }) : "",
        outcome.logo ? t("onboard.readLogo") : "",
        outcome.facts ? t("onboard.readFacts", { n: outcome.facts }) : "",
        outcome.assets ? t("onboard.readAssets", { n: outcome.assets }) : "",
      ].join("")
    : "";
  const studioAddress = (value: string) => `${window.location.host}/studio/${slugOf(value)}`;

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
                  // Just them, or a name of its own already: nothing to name (the account page renames it).
                  go(profile.kind === "personal" || named ? "site" : "organization");
                }
              }}
            >
              <Kicker>{kicker1}</Kicker>
              <Title>{t("onboard.kind")}</Title>
              <Lead>
                {known && named
                  ? t("onboard.kindSubOrganization", { organization: named })
                  : t("onboard.kindSub")}
              </Lead>
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
                <Dots step={1} total={steps} />
              </div>
            </form>
          ) : null}

          {page === "organization" ? (
            <form
              className="contents"
              onSubmit={(e) => {
                e.preventDefault();
                const value = organization.trim();
                if (value) {
                  rename.mutate(value, { onSuccess: renamed });
                } else {
                  go("site");
                }
              }}
            >
              <Kicker>{kicker1}</Kicker>
              <Title>{t("onboard.organization")}</Title>
              <Lead>{t("onboard.organizationSub")}</Lead>
              <input
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                placeholder={t("onboard.organizationPlaceholder")}
                maxLength={80}
                aria-label={t("onboard.organization")}
                className={FIELD}
              />
              {organization.trim() ? (
                <p className="-mt-2 text-[0.9375rem] text-white/85">
                  {suggested && organization === suggested.name
                    ? `${t("onboard.nameFrom", { domain: new URL(suggested.url).host })} `
                    : ""}
                  {t("onboard.address")}{" "}
                  <span className="font-mono text-[0.875rem]" style={{ color: CREAM }}>
                    {studioAddress(organization)}
                  </span>
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-5">
                <Next type="submit" busy={rename.isPending}>
                  {t("onboard.continue")}
                </Next>
                <Dots step={1} total={steps} />
              </div>
            </form>
          ) : null}

          {page === "site" ? (
            <>
              <Kicker>
                {personal
                  ? t("onboard.kicker2Personal")
                  : kicker("onboard.kicker2Named", "onboard.kicker2")}
              </Kicker>
              <Title>
                {personal
                  ? t("onboard.linksPersonal")
                  : nothing && !anyway && title
                    ? t("onboard.noneFound", { name: title })
                    : title
                      ? t("onboard.siteNamed", { organization: title })
                      : t("onboard.site")}
              </Title>
              <Lead>
                {personal
                  ? t("onboard.linksPersonalSub")
                  : nothing && !anyway && title
                    ? t("onboard.noneFoundSub", { name: title })
                    : find.isPending
                      ? t("onboard.searching", { name: title ?? "" })
                      : t("onboard.foundSub")}
              </Lead>
              {writing ? (
                <form
                  className="contents"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = (line ?? "").trim();
                    if (text) {
                      about.mutate(text, { onSuccess: () => go("details") });
                    } else {
                      go("details");
                    }
                  }}
                >
                  <Spoken
                    value={line ?? ""}
                    onChange={setLine}
                    rows={4}
                    label={t("onboard.line")}
                    placeholder={t(
                      personal ? "onboard.linePlaceholderPersonal" : "onboard.linePlaceholder",
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setLine(null);
                      setAnyway(true);
                      setOwn((o) => (o.length ? o : [""]));
                    }}
                    className="-mt-1 cursor-pointer self-start font-semibold text-[0.9375rem] text-white/85 hover:text-white"
                  >
                    + {t("onboard.addressAfterAll")}
                  </button>
                  <div className="flex flex-wrap items-center gap-5">
                    <Next type="submit" busy={about.isPending}>
                      {t("onboard.continue")}
                    </Next>
                    <Quiet onClick={() => go("details")}>{t("onboard.skip")}</Quiet>
                    <Dots step={2} total={steps} />
                  </div>
                </form>
              ) : (
                <form
                  className="contents"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (outcome) {
                      go("details");
                    } else if (chosen.length && !read.isPending) {
                      read.mutate(chosen);
                    }
                  }}
                >
                  {found.length ? (
                    <div className="flex flex-col gap-2">
                      {found.map((a) => (
                        <Address
                          key={a.url}
                          address={a}
                          picked={picked.includes(a.url)}
                          onToggle={() =>
                            setTicked(
                              picked.includes(a.url)
                                ? picked.filter((u) => u !== a.url)
                                : [...picked, a.url],
                            )
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                  {!personal && found.length ? (
                    <p className="-mb-2 text-[0.9375rem] text-white/85">{t("onboard.own")}</p>
                  ) : null}
                  {own.map((value, i) => (
                    <div key={i} className="relative">
                      <input
                        value={value}
                        onChange={(e) =>
                          setOwn((o) => o.map((x, j) => (j === i ? e.target.value : x)))
                        }
                        placeholder={t(
                          personal ? "onboard.linkPlaceholderPersonal" : "onboard.ownPlaceholder",
                        )}
                        autoCapitalize="none"
                        aria-label={t("onboard.own")}
                        className={cn(SMALL_FIELD, "pr-28")}
                      />
                      {addressUrl(value) ? (
                        <span className="-translate-y-1/2 absolute top-1/2 right-3 rounded-full bg-white/20 px-2.5 py-0.5 font-semibold text-[0.75rem]">
                          {ADDRESS_NAMES[addressKind(value)]}
                        </span>
                      ) : null}
                    </div>
                  ))}
                  {own.length + found.length < 10 ? (
                    <button
                      type="button"
                      onClick={() => setOwn((o) => [...o, ""])}
                      className="-mt-1 cursor-pointer self-start font-semibold text-[0.9375rem] text-white/85 hover:text-white"
                    >
                      + {t("onboard.addAddress")}
                    </button>
                  ) : null}
                  {outcome ? (
                    <p className="flex items-center gap-2 text-[0.9375rem] text-(color:--moss)">
                      <Check className="size-4" />
                      {outcome.name
                        ? t("onboard.readDone", { name: outcome.name, details })
                        : t("onboard.readKept", { n: chosen.length })}
                    </p>
                  ) : read.isError ? (
                    <p className="text-[0.9375rem] text-(color:--rose)">
                      {t("onboard.readFailed")}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-5">
                    {outcome ? (
                      <Next type="submit">{t("onboard.continue")}</Next>
                    ) : (
                      <Next type="submit" busy={read.isPending}>
                        {read.isPending ? t("onboard.reading") : t("onboard.read")}
                      </Next>
                    )}
                    <Quiet onClick={() => setLine("")}>{t("onboard.line")}</Quiet>
                    <Quiet onClick={() => go("details")}>{t("onboard.skip")}</Quiet>
                    <Dots step={2} total={steps} />
                  </div>
                </form>
              )}
            </>
          ) : null}

          {page === "details" && profile.kind ? (
            <form
              className="contents"
              onSubmit={(e) => {
                e.preventDefault();
                keep.mutate();
                go("know");
              }}
            >
              <Kicker>{personal || !title ? kicker1 : title}</Kicker>
              <Title small>
                {personal
                  ? t("onboard.personalTitle")
                  : title
                    ? t("onboard.aboutOrganization", { organization: title })
                    : t(profile.kind === "club" ? "onboard.clubTitle" : "onboard.businessTitle")}
              </Title>
              {personal ? (
                <Spoken
                  value={profile.need}
                  onChange={(need) => answer({ need })}
                  rows={4}
                  label={t("onboard.personalTitle")}
                  placeholder={t("onboard.personalPlaceholder")}
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
              {personal ? null : (
                <div className="flex flex-col gap-2">
                  <span className="text-[0.9375rem] text-white/85">
                    {t("onboard.questions")}{" "}
                    <span className="text-white/60">{t("onboard.optional")}</span>
                  </span>
                  <Spoken
                    value={profile.questions ?? ""}
                    onChange={(questions) => answer({ questions })}
                    rows={3}
                    label={t("onboard.questions")}
                    placeholder={t("onboard.questionsPlaceholder")}
                  />
                  <span className="text-[0.8125rem] text-white/70">
                    {t("onboard.questionsHint")}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-5">
                <Next type="submit" busy={keep.isPending}>
                  {t("onboard.continue")}
                </Next>
                <Quiet
                  // Back the way the browser goes, unless this page was opened by its address.
                  onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : go("site"))}
                >
                  {t("onboard.back")}
                </Quiet>
                <Dots step={3} total={steps} />
              </div>
            </form>
          ) : null}

          {page === "know" ? (
            <>
              <Kicker>{kicker("onboard.kicker3Named", "onboard.kicker3")}</Kicker>
              <Title>{t("onboard.know")}</Title>
              <Lead>{t("onboard.knowSub")}</Lead>
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
                {/* Someone who knows the studio has seen what a space is: the knowledge ends it. */}
                <Next
                  busy={uploads.some((u) => u.state === "uploading") || finish.isPending}
                  onClick={() => (known ? finish.mutate() : go("space"))}
                >
                  {known ? t("onboard.buildFirst") : t("onboard.continue")}
                </Next>
                {uploads.length || known ? null : (
                  <Quiet onClick={() => go("space")}>{t("onboard.skip")}</Quiet>
                )}
                <Dots step={4} total={steps} />
              </div>
            </>
          ) : null}

          {page === "space" && !known ? (
            <>
              <Kicker>{kicker("onboard.kicker4Named", "onboard.kicker4")}</Kicker>
              <Title>
                {title && !personal
                  ? t("onboard.spaceNamed", { organization: title })
                  : t("onboard.space")}
              </Title>
              <Lead>{t("onboard.spaceSub", { space: project?.name ?? "" })}</Lead>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["partInfo", "partInfoText", Boolean(outcome || line)],
                    ["partKnow", "partKnowText", uploads.some((u) => u.state === "done")],
                    ["partData", "partDataText", false],
                    ["partResults", "partResultsText", false],
                  ] as const
                ).map(([part, text, done]) => (
                  <div
                    key={part}
                    className="flex flex-col gap-1.5 rounded-2xl border border-white/20 bg-white/10 px-4.5 py-4"
                  >
                    <span className="flex items-center gap-2 font-semibold text-[1rem]">
                      {done ? <Check className="size-4 text-(color:--moss)" /> : null}
                      {t(`onboard.${part}` as Key)}
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
                <Dots step={5} total={steps} />
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

/** The small capitals above a page's question. */
function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}

function Title({ children, small }: { children: ReactNode; small?: boolean }) {
  return (
    <h1
      className={cn(
        "font-display font-bold leading-[1.05] tracking-[-0.02em]",
        small ? "text-[2.25rem] sm:text-[2.75rem]" : "text-[2.5rem] sm:text-[3.25rem]",
      )}
    >
      {children}
    </h1>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return <p className="text-[1.0625rem] text-white/90 leading-relaxed">{children}</p>;
}

/** A field to type or speak into: the studio's “Sprechen” at its bottom right. */
function Spoken({
  value,
  onChange,
  rows,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  rows: number;
  label: string;
  placeholder: string;
}) {
  const [prefs] = useDictationSettings();
  const speech = useDictation(value, onChange, { deviceId: prefs.deviceId });
  return (
    <div className="flex flex-col gap-2 rounded-[18px] border border-white/30 bg-white/15 px-4 pt-3 pb-3 focus-within:border-white/60">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={speech.listening ? t("editor.listening") : placeholder}
        rows={rows}
        maxLength={4000}
        aria-label={label}
        className="w-full resize-none bg-transparent text-[1.0625rem] text-white leading-relaxed outline-none placeholder:text-white/55"
      />
      {speech.supported ? (
        <div
          className="self-end"
          style={{ "--ink": "white", "--border": "rgb(255 255 255 / 0.55)" } as CSSProperties}
        >
          <DictationButton speech={speech} labelled />
        </div>
      ) : null}
    </div>
  );
}

/** A found address to tick: what it is, where it points, where it came from. */
function Address({
  address,
  picked,
  onToggle,
}: {
  address: FoundAddress;
  picked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onToggle}
      className={cn(
        "flex cursor-pointer items-center gap-3.5 rounded-[14px] border px-4 py-2.5 text-left transition",
        picked ? "border-white bg-white/22" : "border-white/30 bg-white/8 hover:bg-white/12",
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-md border-2",
          picked ? "border-white bg-white" : "border-white/60",
        )}
        style={picked ? { color: GROUND_INK } : undefined}
      >
        {picked ? <Check className="size-3.5" strokeWidth={3} /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold text-[0.6875rem] text-white/70 uppercase tracking-[0.1em]">
          {ADDRESS_NAMES[address.kind]}
        </span>
        <span className="truncate font-mono text-[0.9375rem]">
          {address.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
        </span>
        <span className="truncate text-[0.8125rem] text-white/80">{address.title}</span>
      </span>
      <span className="shrink-0 text-[0.75rem] text-white/70 max-sm:hidden">
        {t(address.source === "email" ? "onboard.fromEmail" : "onboard.fromWeb")}
      </span>
    </button>
  );
}

/** A name as an address, the way the Manage-App makes one: `Müller & Söhne` → `mueller-soehne`. */
function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 35)
    .replace(/-+$/, "");
}

interface Members {
  members: { userId: string; name: string; role: "owner" | "admin" | "member" }[];
}

/**
 * The first visit of an organization set up already, or of a member: one page that says where
 * they are, who brought them, the spaces with their wizards and what their role may do.
 */
function Welcome() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const projects = useProjects();
  const tenant = me.data?.tenant;
  const members = useQuery({
    queryKey: ["organization", tenant?.id],
    queryFn: () => api.get<Members>("/api/studio/organization"),
    enabled: Boolean(tenant),
  });
  const done = useMutation({
    mutationFn: () => api.post("/api/studio/onboarding/done"),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/", { replace: true });
    },
  });
  if (!(me.data && tenant)) {
    return null;
  }
  const organization = tenant.name ?? "";
  const name = me.data.user.name;
  const firstName = name.includes("@") ? "" : name.split(" ")[0];
  const invitedBy = me.data.organizations.find((o) => o.id === tenant.id)?.invitedBy?.name;
  const owner = members.data?.members.find(
    (m) => m.role === "owner" && m.userId !== me.data?.user.id,
  )?.name;
  const builds = tenant.role !== "member";
  const address = tenant.slug ? `${window.location.host}/studio/${tenant.slug}` : null;
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
        </div>
        <div className="flex min-w-0 max-w-2xl animate-rise flex-col gap-5">
          <p className="font-medium text-[0.75rem] text-white/85 uppercase tracking-[0.14em]">
            {firstName ? t("onboard.kicker1", { name: firstName }) : t("onboard.kicker1Anon")}
          </p>
          <h1 className="font-display font-bold text-[2.5rem] leading-[1.05] tracking-[-0.02em] sm:text-[3.25rem]">
            {t("welcome.title", { organization })}
          </h1>
          <p className="text-[1.0625rem] text-white/90 leading-relaxed">
            {invitedBy
              ? t("welcome.invited", { name: invitedBy })
              : owner
                ? t("welcome.setUp", { name: owner, organization })
                : t("welcome.plain")}
          </p>
          <div className="overflow-hidden rounded-[18px] bg-white/12 ring-1 ring-white/20">
            <div className="flex items-center gap-3.5 px-4.5 py-3.5">
              <span
                className="flex size-11 shrink-0 items-center justify-center rounded-xl font-bold font-display"
                style={{ background: CREAM, color: GROUND_INK }}
              >
                {initialsOf(organization)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold text-[1.0625rem]">{organization}</span>
                {address ? (
                  <span className="truncate font-mono text-[0.8125rem] text-white/75">
                    {address}
                  </span>
                ) : null}
              </span>
              <span className="rounded-full bg-white/20 px-2.5 py-1 font-semibold text-[0.75rem]">
                {t(`organization.role.${tenant.role}` as Key)}
              </span>
            </div>
            {projects.data?.some((p) => p.wizardCount > 0) ? (
              projects.data.map((p) => (
                <div
                  key={p.id}
                  className="flex justify-between gap-3 border-white/15 border-t px-4.5 py-2.5 text-[0.9375rem]"
                >
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 text-white/75">
                    {t("welcome.wizards", { n: p.wizardCount })}
                  </span>
                </div>
              ))
            ) : (
              <p className="border-white/15 border-t px-4.5 py-3 text-[0.9375rem] text-white/80">
                {t("welcome.noWizards")}
              </p>
            )}
          </div>
          <p className="text-[0.9375rem] text-white/80">
            {t(builds ? "welcome.canBuild" : "welcome.canMember")}
          </p>
          <div className="flex flex-wrap items-center gap-5">
            <Next busy={done.isPending} onClick={() => done.mutate()}>
              {t("welcome.go")}
            </Next>
          </div>
        </div>
      </main>
    </div>
  );
}
