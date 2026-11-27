import { RunnerBody } from "@engenty/wizards-runner";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type ItemKind, type PartName, pathOf, placeOf } from "../server/paths";
import {
  type Brand,
  CallError,
  type ClientSpace,
  call,
  type Face,
  type FileInfo,
  type ForYou,
  fileUrl,
  keepTabSpace,
  keepTicket,
  openRun,
  type Result,
  type SessionInfo,
  type SpaceFile,
  session,
  signInUrl,
  signOut,
  tabSpace,
  type Wizard,
} from "./api";
import { Engenty } from "./engenty";
import { hasText, lang, switchLang, t } from "./i18n";
import { runnerLook, wearBrand } from "./look";
import { useRun } from "./useRun";

/*
 * The client portal (docs/plans/client-portal.md): the firm's wizards, opened to its clients.
 * Before sign-in the firm's own page with one button; then three places in the firm's frame: the
 * home, Wizards and Results. No address names a space (server/paths.ts): Wizards and Results
 * have a word each, a deep link names its item, the tab keeps its space.
 */

type Part = "home" | PartName;

/** The part an item belongs to, for the side bar and the tabs. */
const PART_OF: Record<ItemKind, Part> = {
  run: "results",
  file: "results",
  wizard: "wizards",
};

type Go = (to: string) => void;

function usePath(): [string, Go] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const back = () => setPath(location.pathname);
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  const go = useCallback((to: string) => {
    history.pushState(null, "", to);
    setPath(to);
    scrollTo(0, 0);
  }, []);
  return [path, go];
}

/** A link inside the portal: a click moves without loading the page again. */
function Go({
  to,
  go,
  className,
  children,
  onClick,
}: {
  to: string;
  go: Go;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) {
          e.preventDefault();
          onClick?.();
          go(to);
        }
      }}
    >
      {children}
    </a>
  );
}

/** Loads once per `key`, and again on `reload`. */
function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what the load depends on
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => setState({ data, loading: false }),
      (err: Error) => setState({ error: err.message, loading: false }),
    );
  }, [key]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

const Loading = () => <p className="quiet">{t("loading")}</p>;
const Failed = ({ error }: { error: string }) => <p className="quiet">{t("error", { error })}</p>;

/** The firm as its brand names it, else the organization's name. */
const firmName = (space: ClientSpace) => space.firm.brand.name || space.firm.name;

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short" });

const statusOf = (status: string) => {
  const key = `status.${status}`;
  return hasText(key) ? t(key) : status;
};

const stepsOf = (n: number) => (n === 1 ? t("wizards.steps.one") : t("wizards.steps", { n }));

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

// --- small parts -------------------------------------------------------------------------------

const ICONS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  grid: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z",
  layers: "M12 3 2 8l10 5 10-5-10-5zM2 16l10 5 10-5M2 12l10 5 10-5",
  down: "M6 9l6 6 6-6",
  left: "M15 18l-6-6 6-6",
  menu: "M4 7h16M4 12h16M4 17h10",
  close: "M6 6l12 12M18 6 6 18",
  dl: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  check: "M20 6 9 17l-5-5",
} as const;

function Icon({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const logoSrc = (url: string) => (url.startsWith("/") ? `/portal${url}` : url);

function Logo({ brand, name }: { brand: { logoUrl: string | null } | null; name: string }) {
  if (brand?.logoUrl) {
    return <img className="logo" src={logoSrc(brand.logoUrl)} alt={name} />;
  }
  return <span className="wordmark">{name}</span>;
}

function MadeWith() {
  return (
    <a className="made-with" href="https://engenty.ai" target="_blank" rel="noreferrer">
      <Engenty kind="drop" size={16} />
      {t("madeWith")}
    </a>
  );
}

// --- before sign-in ----------------------------------------------------------------------------

/** The firm's own page with one button where clients sign in; its public wizards where not. */
function PublicFace({ face, failed }: { face: Face | null; failed: boolean }) {
  const page = face?.page ?? null;
  const firm = page?.brand.name || face?.team.name || "";
  useEffect(() => wearBrand(page?.brand.theme ?? null), [page]);
  return (
    <div className="public">
      <header className="public-top">
        <Logo brand={page?.brand ?? null} name={firm} />
        <button type="button" className="link" onClick={switchLang}>
          {t("language")}
        </button>
      </header>
      {face?.portal ? (
        <main className="signin">
          <section className="pitch">
            <span className="eyebrow">{t("signIn.clients", { firm })}</span>
            <h1>{page?.headline || t("signIn.title", { firm })}</h1>
            <p className="lead">{page?.intro || t("signIn.lead", { firm })}</p>
            {failed ? <p className="warn">{t("signIn.failed")}</p> : null}
            <a className="button big" href={signInUrl(pathOf.home())}>
              {t("signIn")}
            </a>
          </section>
          <ul className="what">
            <li>
              <span className="what-icon">
                <Engenty kind="drop" size={30} />
              </span>
              <div>
                <strong>{t("signIn.wizards")}</strong>
                <span>{t("signIn.wizards.hint")}</span>
              </div>
            </li>
            <li>
              <span className="what-icon">
                <Icon name="layers" />
              </span>
              <div>
                <strong>{t("signIn.results")}</strong>
                <span>{t("signIn.results.hint")}</span>
              </div>
            </li>
          </ul>
        </main>
      ) : (
        <main className="public-page">
          {page ? <h1>{page.headline || page.title}</h1> : null}
          {page?.intro ? <p className="lead">{page.intro}</p> : null}
          {page?.wizards.length ? (
            <ul className="file-rows">
              {page.wizards.map((w) => (
                <li key={w.slug} className="file-row">
                  <div className="file-main">
                    <strong>{w.title}</strong>
                    <span className="quiet">{w.description}</span>
                  </div>
                  <a className="button ghost small" href={w.runUrl}>
                    {t("public.start")}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet">{t("public.nothing")}</p>
          )}
        </main>
      )}
      <footer className="public-foot">
        <MadeWith />
      </footer>
    </div>
  );
}

function Notice({ face, title, hint }: { face: Face | null; title: string; hint: string }) {
  return (
    <div className="public">
      <header className="public-top">
        <Logo brand={face?.page?.brand ?? null} name={face?.team.name ?? ""} />
        <button
          type="button"
          className="link"
          onClick={() => void signOut().then(() => location.assign(pathOf.home()))}
        >
          {t("signOut")}
        </button>
      </header>
      <main className="public-page">
        <h1>{title}</h1>
        <p className="lead">{hint}</p>
      </main>
    </div>
  );
}

// --- the frame ---------------------------------------------------------------------------------

function SpaceSwitch({
  spaces,
  space,
  onSwitch,
}: {
  spaces: ClientSpace[];
  space: ClientSpace;
  onSwitch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const several = spaces.length > 1;
  const body = (
    <>
      <span className="space-text">
        <small>{firmName(space)}</small>
        <strong>{space.name}</strong>
      </span>
      {several ? <Icon name="down" size={16} /> : null}
    </>
  );
  if (!several) {
    return <div className="space-switch">{body}</div>;
  }
  return (
    <div className="space-menu">
      <button
        type="button"
        className="space-switch"
        aria-expanded={open}
        aria-label={t("spaces.switch")}
        onClick={() => setOpen(!open)}
      >
        {body}
      </button>
      {open ? (
        <ul className="menu">
          {spaces.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={s.id === space.id ? "on" : ""}
                onClick={() => {
                  setOpen(false);
                  onSwitch(s.id);
                }}
              >
                {s.name}
                {s.id === space.id ? <Icon name="check" size={16} /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Side({
  spaces,
  space,
  part,
  go,
  person,
  onSwitch,
  onClose,
}: {
  spaces: ClientSpace[];
  space: ClientSpace;
  part: Part | null;
  go: Go;
  person: { name: string; email: string };
  onSwitch: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="side">
      <div className="side-top">
        <Logo brand={space.firm.brand} name={firmName(space)} />
        <button
          type="button"
          className="icon-button only-phone"
          aria-label={t("nav.close")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <SpaceSwitch spaces={spaces} space={space} onSwitch={onSwitch} />
      <nav className="side-nav" aria-label={t("nav.label")}>
        <Go
          to={pathOf.home()}
          go={go}
          onClick={onClose}
          className={`side-row${part === "home" ? " on" : ""}`}
        >
          <Icon name="home" />
          {t("nav.home")}
        </Go>
        <Go
          to={pathOf.part("wizards")}
          go={go}
          onClick={onClose}
          className={`side-row${part === "wizards" ? " on" : ""}`}
        >
          <Icon name="grid" />
          {t("nav.wizards")}
        </Go>
        <Go
          to={pathOf.part("results")}
          go={go}
          onClick={onClose}
          className={`side-row${part === "results" ? " on" : ""}`}
        >
          <Icon name="layers" />
          {t("nav.results")}
        </Go>
      </nav>
      <div className="side-me">
        <span className="avatar">{initials(person.name || person.email)}</span>
        <div className="me-text">
          <strong className="clip">{person.name || person.email}</strong>
          <span className="me-links">
            <button type="button" className="link" onClick={switchLang}>
              {t("language")}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => void signOut().then(() => location.assign(pathOf.home()))}
            >
              {t("signOut")}
            </button>
          </span>
        </div>
      </div>
      <MadeWith />
    </aside>
  );
}

const TABS: {
  id: Part;
  to: string;
  icon: keyof typeof ICONS;
  label: "nav.home" | "nav.wizards" | "nav.results";
}[] = [
  { id: "home", to: pathOf.home(), icon: "home", label: "nav.home" },
  { id: "wizards", to: pathOf.part("wizards"), icon: "grid", label: "nav.wizards" },
  { id: "results", to: pathOf.part("results"), icon: "layers", label: "nav.results" },
];

/** The phone's frame: the space as the title, three tabs at the bottom; an item has a back arrow. */
function PhoneTop({
  space,
  title,
  sub,
  back,
  go,
  onMenu,
}: {
  space: ClientSpace;
  title?: string;
  sub?: string;
  back: string | null;
  go: Go;
  onMenu: () => void;
}) {
  return (
    <header className="phone-top">
      {back ? (
        <Go to={back} go={go} className="icon-button">
          <Icon name="left" />
          <span className="sr">{t("run.back")}</span>
        </Go>
      ) : (
        <button type="button" className="icon-button" aria-label={t("nav.menu")} onClick={onMenu}>
          <Icon name="menu" />
        </button>
      )}
      <div className="phone-title">
        <strong className="clip">{title ?? space.name}</strong>
        <small className="clip">{sub ?? firmName(space)}</small>
      </div>
    </header>
  );
}

// --- starting a wizard -------------------------------------------------------------------------

/** Starts one of the firm's wizards in the tab's client space and opens its run. */
async function startWizard(space: ClientSpace, wizardId: string, go: Go) {
  const { runId, ticket } = await call<{ runId: string; ticket: string }>(
    "wizard_start",
    space.id,
    { wizardId },
  );
  keepTicket(runId, ticket);
  go(pathOf.item("run", runId));
}

// --- the home ----------------------------------------------------------------------------------

function greeting(name: string) {
  const hour = new Date().getHours();
  const first = name.split(/\s+/)[0] ?? "";
  return t(hour < 11 ? "hello.morning" : hour < 18 ? "hello.day" : "hello.evening", {
    name: first,
  });
}

function WaitingCard({ run, go }: { run: Result; go: Go }) {
  return (
    <Go to={pathOf.item("run", run.runId)} go={go} className="waiting">
      <Engenty kind={run.avatar} size={40} />
      <span className="waiting-text">
        <strong>{run.title}</strong>
        <small>{t("waiting.since", { date: dateOf(run.updatedAt) })}</small>
      </span>
      <span className="button small">{t("waiting.continue")}</span>
    </Go>
  );
}

function ResultTile({ result, space, go }: { result: Result; space: ClientSpace; go: Go }) {
  return (
    <Go to={pathOf.item("run", result.runId)} go={go} className="mini">
      <span className="mini-preview">
        <Engenty kind={result.avatar} size={44} />
      </span>
      <span className="mini-text">
        <strong className="clip">{result.title}</strong>
        <small>
          {result.mine ? t("results.mine") : t("results.byFirm", { firm: firmName(space) })} ·{" "}
          {dateOf(result.updatedAt)}
        </small>
      </span>
    </Go>
  );
}

/** The start page: what waits for the client, the firm's wizards to start, the latest results. */
function Home({ space, person, go }: { space: ClientSpace; person: { name: string }; go: Go }) {
  const firm = firmName(space);
  const forYou = useLoad(() => call<ForYou>("for_you", space.id), space.id);
  const results = useLoad(() => call<Result[]>("results", space.id), space.id);
  const wizards = forYou.data?.wizards ?? [];
  const waiting = forYou.data?.waiting ?? [];
  const latest = results.data ?? [];
  const loaded = Boolean(forYou.data && results.data);
  // A client space without results yet: the home says what it is for.
  const first = loaded && !latest.length;
  return (
    <div className={`home${first ? " first" : ""}`}>
      <div className="hello">
        <h1>{greeting(person.name)}</h1>
        {first ? <p>{t("home.first", { firm, space: space.name })}</p> : null}
      </div>
      {waiting.length ? (
        <section className="waiting-row" aria-label={t("waiting.title")}>
          {waiting.slice(0, 3).map((r) => (
            <WaitingCard key={r.runId} run={r} go={go} />
          ))}
        </section>
      ) : null}
      {wizards.length ? (
        <section className="starters" aria-label={t("nav.wizards")}>
          {wizards.slice(0, 4).map((w) => (
            <button
              key={w.id}
              type="button"
              className="starter"
              onClick={() => void startWizard(space, w.id, go)}
            >
              <Engenty kind={w.avatar} size={24} />
              {w.title}
            </button>
          ))}
          <Go to={pathOf.part("wizards")} go={go} className="starter more">
            {t("home.allWizards")}
          </Go>
        </section>
      ) : null}
      {latest.length ? (
        <section className="new-row">
          <div className="new-head">
            <h2>{t("home.new")}</h2>
            <Go to={pathOf.part("results")} go={go} className="link">
              {t("home.allResults")}
            </Go>
          </div>
          <div className="mini-grid">
            {latest.slice(0, 4).map((r) => (
              <ResultTile key={r.runId} result={r} space={space} go={go} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// --- Wizards -----------------------------------------------------------------------------------

/** A wizard as the studio's card shows it: its engenty on the card's top edge. */
function WizardCard({ wizard, space, go }: { wizard: Wizard; space: ClientSpace; go: Go }) {
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <li className="wizard-card">
      <span className="wizard-engenty">
        <Engenty kind={wizard.avatar} size={52} />
      </span>
      <div className="wizard-body">
        <Go to={pathOf.item("wizard", wizard.id)} go={go} className="wizard-title">
          {wizard.title}
        </Go>
        <p className="wizard-text">{wizard.description}</p>
        {failed ? <p className="warn">{t("error", { error: failed })}</p> : null}
        <div className="wizard-foot">
          <span>{stepsOf(wizard.steps)}</span>
          <button
            type="button"
            className="button ghost small"
            disabled={starting}
            onClick={() => {
              setStarting(true);
              setFailed(null);
              startWizard(space, wizard.id, go).catch((err: Error) => {
                setFailed(err.message);
                setStarting(false);
              });
            }}
          >
            {starting ? t("wizard.starting") : t("wizard.start")}
          </button>
        </div>
      </div>
    </li>
  );
}

function WizardsPage({ space, go, only }: { space: ClientSpace; go: Go; only?: string }) {
  const firm = firmName(space);
  const { data, error, loading } = useLoad(() => call<ForYou>("for_you", space.id), space.id);
  if (loading && !data) {
    return <Loading />;
  }
  if (error || !data) {
    return <Failed error={error ?? ""} />;
  }
  const shown = only ? data.wizards.filter((w) => w.id === only) : data.wizards;
  if (only && !shown.length) {
    return <Failed error={t("notFound")} />;
  }
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("wizards.title")}</h1>
        <p>{t("wizards.lead", { firm })}</p>
      </div>
      {!only && data.waiting.length ? (
        <div className="waiting-row one">
          <WaitingCard run={data.waiting[0]} go={go} />
        </div>
      ) : null}
      {shown.length ? (
        <ul className="wizard-grid">
          {shown.map((w) => (
            <WizardCard key={w.id} wizard={w} space={space} go={go} />
          ))}
        </ul>
      ) : (
        <p className="quiet">{t("wizards.empty", { firm })}</p>
      )}
      {only ? (
        <Go to={pathOf.part("wizards")} go={go} className="link">
          {t("home.allWizards")}
        </Go>
      ) : null}
    </div>
  );
}

// --- Results -----------------------------------------------------------------------------------

const sizeOf = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function FileRow({ file, go }: { file: SpaceFile; go: Go }) {
  return (
    <li className="file-row">
      <span className="file-icon">
        <Icon name="file" />
      </span>
      <Go to={pathOf.item("file", file.id)} go={go} className="file-main">
        <strong className="clip">{file.name}</strong>
        <span className="quiet">
          {dateOf(file.createdAt)} · {sizeOf(file.size)}
        </span>
      </Go>
      <a className="button ghost small" href={fileUrl(file.id)} download={file.name}>
        <Icon name="dl" size={15} />
        <span className="wide-only">{t("files.download")}</span>
      </a>
    </li>
  );
}

function ResultCard({ result, space, go }: { result: Result; space: ClientSpace; go: Go }) {
  const firm = firmName(space);
  return (
    <li>
      <Go to={pathOf.item("run", result.runId)} go={go} className="result-card">
        <span className="result-preview">
          <Engenty kind={result.avatar} size={64} />
          {result.status === "done" ? null : (
            <span className={`status ${result.status}`}>{statusOf(result.status)}</span>
          )}
        </span>
        <span className="result-text">
          <strong>{result.title}</strong>
          <small>
            {result.mine ? t("results.mine") : t("results.byFirm", { firm })} ·{" "}
            {dateOf(result.updatedAt)}
          </small>
        </span>
      </Go>
    </li>
  );
}

type Filter = "all" | "firm" | "mine";

function ResultsPage({ space, go }: { space: ClientSpace; go: Go }) {
  const firm = firmName(space);
  const [tab, setTab] = useState<"results" | "files">("results");
  const [filter, setFilter] = useState<Filter>("all");
  const results = useLoad(() => call<Result[]>("results", space.id), space.id);
  const forYou = useLoad(() => call<ForYou>("for_you", space.id), space.id);
  const files = useLoad(() => call<SpaceFile[]>("files", space.id), space.id);
  // What waits on the client stands first, with its chip; then everything that came out.
  const all = [...(forYou.data?.waiting ?? []), ...(results.data ?? [])];
  const shown = all.filter((r) => filter === "all" || (filter === "mine") === r.mine);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("results.title")}</h1>
      </div>
      <div className="tabs" role="tablist">
        {(["results", "files"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "on" : ""}
            onClick={() => setTab(id)}
          >
            {id === "results" ? t("results.title") : t("results.files")}
            <small>{id === "results" ? all.length || "" : files.data?.length || ""}</small>
          </button>
        ))}
      </div>
      {tab === "results" ? (
        <>
          <div className="pills">
            {(["all", "firm", "mine"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`pill${filter === f ? " on" : ""}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === "all"
                  ? t("results.all")
                  : f === "firm"
                    ? t("results.byFirm", { firm })
                    : t("results.mine")}
              </button>
            ))}
          </div>
          {results.loading && !results.data ? (
            <Loading />
          ) : results.error ? (
            <Failed error={results.error} />
          ) : shown.length ? (
            <ul className="result-grid">
              {shown.map((r) => (
                <ResultCard key={r.runId} result={r} space={space} go={go} />
              ))}
            </ul>
          ) : (
            <p className="quiet">{all.length ? t("results.none") : t("results.empty", { firm })}</p>
          )}
        </>
      ) : files.loading && !files.data ? (
        <Loading />
      ) : files.error || !files.data ? (
        <Failed error={files.error ?? ""} />
      ) : files.data.length ? (
        <ul className="file-rows">
          {files.data.map((f) => (
            <FileRow key={f.id} file={f} go={go} />
          ))}
        </ul>
      ) : (
        <p className="quiet">{t("files.empty", { firm })}</p>
      )}
    </div>
  );
}

/** One file by its deep link: its client space becomes the tab's. */
function FileItem({
  fileId,
  go,
  onSpace,
}: {
  fileId: string;
  go: Go;
  onSpace: (id: string) => void;
}) {
  const { data, error, loading } = useLoad(
    () => call<FileInfo>("file", undefined, { fileId }),
    fileId,
  );
  useEffect(() => {
    if (data) {
      onSpace(data.spaceId);
    }
  }, [data, onSpace]);
  if (loading && !data) {
    return <Loading />;
  }
  if (error || !data) {
    return <Failed error={t("notFound")} />;
  }
  return (
    <div className="page">
      <Go to={pathOf.part("results")} go={go} className="link back only-wide">
        <Icon name="left" size={16} />
        {t("files.all")}
      </Go>
      <ul className="file-rows">
        <FileRow file={data.file} go={go} />
      </ul>
    </div>
  );
}

/** One run by its deep link: its ticket, and its client space becomes the tab's. */
function RunItem({
  space,
  runId,
  go,
  onSpace,
}: {
  space: ClientSpace;
  runId: string;
  go: Go;
  onSpace: (id: string) => void;
}) {
  const [ready, setReady] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReady(false);
    setError(null);
    openRun(runId).then(
      (opened) => {
        onSpace(opened.spaceId);
        setReadOnly(opened.readOnly);
        setReady(true);
      },
      (err: Error) =>
        setError(err instanceof CallError && err.status === 404 ? t("notFound") : err.message),
    );
  }, [runId, onSpace]);
  const run = useRun(ready ? runId : null, { readOnly });
  if (error) {
    return <Failed error={error} />;
  }
  return (
    <div className="page run-page">
      <Go to={pathOf.part("results")} go={go} className="link back only-wide">
        <Icon name="left" size={16} />
        {t("results.title")}
      </Go>
      <div className="engenty-runner run" {...runnerLook(space.firm.brand.theme)}>
        {run.view ? <RunnerBody run={run} /> : <Loading />}
      </div>
    </div>
  );
}

// --- signed in ---------------------------------------------------------------------------------

/**
 * The client's portal. The client space is the tab's (api.ts `tabSpace`); a deep link moves the
 * tab to its item's client space once the contract has found it.
 */
function SignedIn({ info, go, path }: { info: SessionInfo; go: Go; path: string }) {
  const firm = info.face?.page?.brand.name || info.face?.team.name || "";
  const spaces = useLoad(() => call<ClientSpace[]>("spaces"), "spaces");
  const [current, setCurrent] = useState<string | null>(tabSpace);
  const [menu, setMenu] = useState(false);
  const list = spaces.data ?? [];
  const space = list.find((s) => s.id === current) ?? list[0] ?? null;
  const brand: Brand | null = space?.firm.brand ?? null;
  useEffect(() => wearBrand(brand?.theme ?? null, brand?.accent), [brand]);
  useEffect(() => {
    if (space) {
      keepTabSpace(space.id);
    }
  }, [space]);
  const onSpace = useCallback((id: string) => setCurrent(id), []);
  if (spaces.loading && !spaces.data) {
    return <Loading />;
  }
  if (spaces.error) {
    return <Notice face={info.face} title={t("error", { error: spaces.error })} hint="" />;
  }
  if (!space) {
    return <Notice face={info.face} title={t("noSpaces")} hint={t("noSpaces.hint", { firm })} />;
  }
  const place = placeOf(path);
  const person = { name: info.person?.name ?? "", email: info.person?.email ?? "" };
  let body: ReactNode;
  let part: Part | null = null;
  let back: string | null = null;
  let title: string | undefined;
  let sub: string | undefined;
  switch (place.kind) {
    case "home":
      part = "home";
      body = <Home space={space} person={person} go={go} />;
      break;
    case "part":
      part = place.part;
      title = place.part === "wizards" ? t("wizards.title") : t("results.title");
      sub = space.name;
      body =
        place.part === "wizards" ? (
          <WizardsPage space={space} go={go} />
        ) : (
          <ResultsPage space={space} go={go} />
        );
      break;
    case "run":
      part = PART_OF.run;
      back = pathOf.part("results");
      body = <RunItem space={space} runId={place.id} go={go} onSpace={onSpace} />;
      break;
    case "file":
      part = PART_OF.file;
      back = pathOf.part("results");
      body = <FileItem fileId={place.id} go={go} onSpace={onSpace} />;
      break;
    case "wizard":
      part = PART_OF.wizard;
      back = pathOf.part("wizards");
      body = <WizardsPage space={space} go={go} only={place.id} />;
      break;
    default:
      body = <Failed error={t("notFound")} />;
  }
  return (
    <div className={`app${back ? " has-back" : ""}${menu ? " menu-open" : ""}`}>
      <Side
        spaces={list}
        space={space}
        part={part}
        go={go}
        person={person}
        onSwitch={(id) => {
          setCurrent(id);
          // Another matter: its home, not an item of the one before.
          if (place.kind !== "home" && place.kind !== "part") {
            go(pathOf.home());
          }
        }}
        onClose={() => setMenu(false)}
      />
      {menu ? (
        <button
          type="button"
          className="scrim"
          aria-label={t("nav.close")}
          onClick={() => setMenu(false)}
        />
      ) : null}
      <div className="main">
        <PhoneTop
          space={space}
          title={title}
          sub={sub}
          back={back}
          go={go}
          onMenu={() => setMenu(true)}
        />
        <main className="content">{body}</main>
        <nav className="phone-tabs" aria-label={t("nav.label")}>
          {TABS.map((tab) => (
            <Go
              key={tab.id}
              to={tab.to}
              go={go}
              className={`phone-tab${tab.id === part ? " on" : ""}`}
            >
              <Icon name={tab.icon} size={22} />
              {t(tab.label)}
            </Go>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function App() {
  const [path, go] = usePath();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    session().then(setInfo, (err: Error) => setError(err.message));
  }, []);
  if (error) {
    return (
      <main className="public-page">
        <Failed error={error} />
      </main>
    );
  }
  if (!info) {
    return (
      <main className="public-page">
        <Loading />
      </main>
    );
  }
  const failed = new URLSearchParams(location.search).get("signin") === "failed";
  if (!info.person) {
    return <PublicFace face={info.face} failed={failed} />;
  }
  if (!info.person.here || info.person.role !== "client") {
    const firm = info.face?.page?.brand.name || info.face?.team.name || "";
    return (
      <Notice
        face={info.face}
        title={t("otherOrganization")}
        hint={t("otherOrganization.hint", { firm })}
      />
    );
  }
  return <SignedIn info={info} go={go} path={path} />;
}
