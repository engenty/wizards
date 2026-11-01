import { Markdown, RunnerBody, type SurfaceChat, SurfaceView } from "@engenty/wizards-runner";
import type { SurfaceComponent } from "@engenty/wizards-shared/surface";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type ItemKind, type PartName, pathOf, placeOf } from "../server/paths";
import {
  type Brand,
  CallError,
  type Card,
  type Chat,
  type ChatMessages,
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
 * The client portal (docs/plans/client-portal.md): the firm's AI, opened to its clients. Before
 * sign-in the firm's own page with one button; then three places in the firm's frame: the chat
 * (the home), Wizards and Results. No address names a client space (server/paths.ts): Wizards
 * and Results have a word each, a deep link names its item, the tab keeps its client space.
 */

type Part = "chat" | PartName;

/** The part an item belongs to, for the side bar and the tabs. */
const PART_OF: Record<ItemKind, Part> = {
  run: "results",
  chat: "chat",
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

/** The firm as its brand names it, else its space's name. */
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
  new: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  grid: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z",
  layers: "M12 3 2 8l10 5 10-5-10-5zM2 16l10 5 10-5M2 12l10 5 10-5",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  up: "M12 19V5M5 12l7-7 7 7",
  down: "M6 9l6 6 6-6",
  left: "M15 18l-6-6 6-6",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
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

/** The firm's mark beside its AI's name: its logo, else its initial. */
function FirmMark({ space }: { space: ClientSpace }) {
  const brand = space.firm.brand;
  return brand.logoUrl ? (
    <span className="firm-mark logo-mark">
      <img src={logoSrc(brand.logoUrl)} alt="" />
    </span>
  ) : (
    <span className="firm-mark" aria-hidden="true">
      {initials(firmName(space)).slice(0, 1)}
    </span>
  );
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
                <Icon name="chat" />
              </span>
              <div>
                <strong>{t("signIn.ask")}</strong>
                <span>{t("signIn.ask.hint", { firm })}</span>
              </div>
            </li>
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

/** The chats by when they were last written in: today, this week, then by month. */
function chatGroups(chats: Chat[]): { label: string; chats: Chat[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: { label: string; chats: Chat[] }[] = [];
  for (const chat of chats) {
    const at = new Date(chat.updatedAt);
    const label =
      at.getTime() >= today
        ? t("chats.today")
        : at.getTime() >= today - 6 * 86_400_000
          ? t("chats.week")
          : at.toLocaleDateString(lang, {
              month: "long",
              ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
            });
    const last = groups.at(-1);
    if (last?.label === label) {
      last.chats.push(chat);
    } else {
      groups.push({ label, chats: [chat] });
    }
  }
  return groups;
}

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
  chatId,
  chats,
  go,
  person,
  onSwitch,
  onClose,
}: {
  spaces: ClientSpace[];
  space: ClientSpace;
  part: Part | null;
  chatId: string | null;
  chats: Chat[];
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
          className={`side-row${part === "chat" && !chatId ? " on" : ""}`}
        >
          <Icon name="new" />
          {t("nav.newChat")}
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
      <div className="side-chats">
        {chats.length ? (
          chatGroups(chats).map((g) => (
            <section key={g.label}>
              <h2 className="side-label">{g.label}</h2>
              {g.chats.map((c) => (
                <Go
                  key={c.id}
                  to={pathOf.item("chat", c.id)}
                  go={go}
                  onClick={onClose}
                  className={`side-chat${c.id === chatId ? " on" : ""}`}
                >
                  <span className="clip">{c.title || t("chats.untitled")}</span>
                  {c.answering ? <span className="dot" /> : null}
                </Go>
              ))}
            </section>
          ))
        ) : (
          <p className="side-label quiet">{t("chats.none")}</p>
        )}
      </div>
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
  label: "nav.chat" | "nav.wizards" | "nav.results";
}[] = [
  { id: "chat", to: pathOf.home(), icon: "chat", label: "nav.chat" },
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
      <Go to={pathOf.home()} go={go} className="icon-button">
        <Icon name="new" />
        <span className="sr">{t("nav.newChat")}</span>
      </Go>
    </header>
  );
}

// --- the composer ------------------------------------------------------------------------------

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

function WizardMenu({ space, go }: { space: ClientSpace; go: Go }) {
  const [open, setOpen] = useState(false);
  const { data } = useLoad(() => call<Wizard[]>("wizards", space.id), space.id);
  const firm = firmName(space);
  return (
    <div className="wizard-menu">
      <button
        type="button"
        className="chip-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="grid" size={16} />
        {t("composer.wizard")}
      </button>
      {open ? (
        <div className="menu up">
          <p className="menu-title">{t("composer.wizards")}</p>
          {data?.length ? (
            <ul>
              {data.map((w) => (
                <li key={w.id}>
                  <button type="button" onClick={() => void startWizard(space, w.id, go)}>
                    <Engenty kind={w.avatar} size={24} />
                    <span className="clip">{w.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet menu-note">{t("composer.wizards.none", { firm })}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** One box, as in a chat with an AI: every message goes to the firm's AI. */
function Composer({
  space,
  chatId,
  go,
  big = false,
  onSent,
  prefill,
}: {
  space: ClientSpace;
  chatId: string | null;
  go: Go;
  big?: boolean;
  onSent: (chatId: string) => void;
  prefill?: { text: string; at: number } | null;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const firm = firmName(space);
  // The box grows with what is written, up to a few lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again as the text changes
  useLayoutEffect(() => {
    const el = box.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    }
  }, [text]);
  const send = async (words = text) => {
    if (!words.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sent = await call<{ chatId: string }>("chat_post", space.id, {
        ...(chatId ? { chatId } : {}),
        text: words.trim(),
      });
      setText("");
      onSent(sent.chatId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // An example the home offers is sent as it is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sends once per example chosen
  useEffect(() => {
    if (prefill) {
      void send(prefill.text);
    }
  }, [prefill?.at]);
  return (
    <form
      className={`composer${big ? " big" : ""}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={box}
        id="composer-text"
        aria-label={t("composer.label")}
        value={text}
        rows={1}
        placeholder={big ? t("composer.home", { firm }) : t("composer.reply", { firm })}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bar">
        <WizardMenu space={space} go={go} />
        <button
          className="send"
          type="submit"
          disabled={busy || !text.trim()}
          aria-label={t("composer.send")}
        >
          <Icon name="up" />
        </button>
      </div>
      {error ? <p className="warn">{t("error", { error })}</p> : null}
    </form>
  );
}

function Reach({ space }: { space: ClientSpace }) {
  return (
    <p className="reach">
      <Icon name="lock" size={14} />
      {t("reach", { firm: firmName(space) })}
    </p>
  );
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

function Home({
  space,
  person,
  hasChats,
  go,
  onSent,
}: {
  space: ClientSpace;
  person: { name: string };
  hasChats: boolean;
  go: Go;
  onSent: (chatId: string) => void;
}) {
  const firm = firmName(space);
  const forYou = useLoad(() => call<ForYou>("for_you", space.id), space.id);
  const results = useLoad(() => call<Result[]>("results", space.id), space.id);
  const [example, setExample] = useState<{ text: string; at: number } | null>(null);
  const wizards = forYou.data?.wizards ?? [];
  const waiting = forYou.data?.waiting ?? [];
  const latest = results.data ?? [];
  const loaded = Boolean(forYou.data && results.data);
  const first = loaded && !hasChats && !latest.length;
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
      <div className="home-box">
        <Composer space={space} chatId={null} go={go} big onSent={onSent} prefill={example} />
        <Reach space={space} />
      </div>
      {first ? (
        <section className="tries">
          <h2 className="tries-label">{t("home.examples")}</h2>
          {[t("home.example.know"), t("home.example.sum")].map((text) => (
            <button
              key={text}
              type="button"
              className="try"
              onClick={() => setExample({ text, at: Date.now() })}
            >
              <Icon name="chat" size={16} />
              {text}
            </button>
          ))}
          {wizards.slice(0, 1).map((w) => (
            <button
              key={w.id}
              type="button"
              className="try"
              onClick={() => void startWizard(space, w.id, go)}
            >
              <Engenty kind={w.avatar} size={22} />
              {w.title}
              <small>{t("home.example.wizard")}</small>
            </button>
          ))}
        </section>
      ) : wizards.length ? (
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

// --- a chat ------------------------------------------------------------------------------------

/** A view the AI showed: the runner's surface, the same components as a wizard's views. */
function ViewCard({
  card,
  space,
  chatId,
  go,
  onAsk,
}: {
  card: Extract<Card, { kind: "view" }>;
  space: ClientSpace;
  chatId: string;
  go: Go;
  onAsk: (text: string) => Promise<void>;
}) {
  const components = card.components.filter(
    (c): c is SurfaceComponent =>
      Boolean(c) &&
      typeof (c as SurfaceComponent).id === "string" &&
      typeof (c as SurfaceComponent).component === "string",
  );
  if (!components.some((c) => c.id === "root")) {
    return null;
  }
  // A Form's answers go back as the client's next message. A Ref to a wizard or a file opens it
  // in the portal; the firm's other items have no address here.
  const chat: SurfaceChat = {
    href: (open) => {
      const [kind, ...rest] = open.split(":");
      const id = rest.join(":");
      return !id
        ? null
        : kind === "wizard"
          ? pathOf.item("wizard", id)
          : kind === "f"
            ? pathOf.item("file", id)
            : null;
    },
    follow: go,
    fieldBase: `/portal/api/client/chats/${chatId}`,
    submit: (answer) => onAsk(card.title ? `${card.title}\n${answer.text}` : answer.text),
    answered: null,
  };
  return (
    <div className="view-card engenty-runner" {...runnerLook(space.firm.brand.theme)}>
      {card.title ? <strong className="view-title">{card.title}</strong> : null}
      <SurfaceView
        surface={{ components, data: card.data }}
        assetUrl={(id) => fileUrl(id.replace(/^f:/, ""))}
        onAction={(a) => {
          if (a.action === "ask" && typeof a.target === "string" && a.target) {
            void onAsk(a.target);
          }
        }}
        chat={chat}
      />
    </div>
  );
}

/** A run the AI started: the wizard's engenty, its state, and its own view a click away. */
function RunCard({
  card,
  space,
  go,
}: {
  card: Extract<Card, { kind: "run" }>;
  space: ClientSpace;
  go: Go;
}) {
  return (
    <div className="run-card">
      <Engenty kind={card.avatar} size={40} />
      <span className="run-card-text">
        <strong>{card.title}</strong>
        <small>{t("card.wizard", { firm: firmName(space) })}</small>
      </span>
      <span className={`status ${card.status}`}>{statusOf(card.status)}</span>
      <Go to={pathOf.item("run", card.runId)} go={go} className="button ghost small">
        {t("card.open")}
      </Go>
    </div>
  );
}

/** How long after a client's message its turn may take to start: then the chat's state says. */
const ANSWER_MS = 30_000;

/** One chat by its deep link: its client space becomes the tab's. */
function Conversation({
  space,
  chatId,
  go,
  onSpace,
  onChanged,
}: {
  space: ClientSpace;
  chatId: string;
  go: Go;
  onSpace: (id: string) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ChatMessages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(
    () =>
      call<ChatMessages>("chat_messages", undefined, { chatId }).then(
        (read) => {
          setData(read);
          setError(null);
        },
        (err: Error) =>
          setError(err instanceof CallError && err.status === 404 ? t("notFound") : err.message),
      ),
    [chatId],
  );
  const last = data?.messages.at(-1);
  // The AI answers every message: until it has, the chat says it is writing.
  const writing = Boolean(
    data &&
      (data.chat.answering ||
        (last?.author.me && Date.now() - new Date(last.createdAt).getTime() < ANSWER_MS)),
  );
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  // While the AI writes, a look every second and a half; else every few seconds.
  useEffect(() => {
    const timer = setInterval(() => void load(), writing ? 1500 : 5000);
    return () => clearInterval(timer);
  }, [load, writing]);
  useEffect(() => {
    if (data) {
      onSpace(data.spaceId);
    }
  }, [data, onSpace]);
  // Once the answer is in, the side bar's chats are read again: their dot goes.
  const wasWriting = useRef(false);
  useEffect(() => {
    if (wasWriting.current && !writing) {
      onChanged();
    }
    wasWriting.current = writing;
  }, [writing, onChanged]);
  const count = data?.messages.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls down as messages come in
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count, writing]);
  const ask = async (text: string) => {
    await call("chat_post", space.id, { chatId, text });
    await load();
    onChanged();
  };
  if (!data) {
    return <div className="thread">{error ? <Failed error={error} /> : <Loading />}</div>;
  }
  const firm = firmName(space);
  return (
    <div className="chat">
      <header className="chat-head only-wide">
        <strong className="clip">{data.chat.title || t("chats.untitled")}</strong>
      </header>
      <div className="thread">
        <ol className="messages">
          {data.messages.length ? null : <li className="quiet">{t("chat.empty")}</li>}
          {data.messages.map((m) =>
            m.author.me ? (
              <li key={m.id} className="message mine">
                <p>{m.text}</p>
              </li>
            ) : m.author.kind === "ai" ? (
              <li key={m.id} className="message ai">
                <span className="ai-name">
                  <FirmMark space={space} />
                  {t("chat.ai", { firm })}
                </span>
                {m.parts.map((p, i) =>
                  p.kind === "text" ? (
                    <Markdown key={i} className="answer" text={p.text} />
                  ) : p.kind === "view" ? (
                    <ViewCard
                      key={p.id}
                      card={p}
                      space={space}
                      chatId={chatId}
                      go={go}
                      onAsk={ask}
                    />
                  ) : (
                    <RunCard key={p.runId} card={p} space={space} go={go} />
                  ),
                )}
              </li>
            ) : (
              <li key={m.id} className="message person">
                <span className="avatar firm">{initials(m.author.name)}</span>
                <div>
                  <span className="ai-name">{m.author.name}</span>
                  <p>{m.text}</p>
                </div>
              </li>
            ),
          )}
          {writing ? (
            <li className="message ai">
              <span className="ai-name">
                <FirmMark space={space} />
                <span className="writing">{t("chat.writing", { firm })}</span>
              </span>
            </li>
          ) : null}
        </ol>
        <div ref={end} className="thread-end" />
      </div>
      {data.spaceId === space.id ? (
        <div className="dock">
          <Composer
            space={space}
            chatId={chatId}
            go={go}
            onSent={() => {
              void load();
              onChanged();
            }}
          />
          <Reach space={space} />
        </div>
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
  const chats = useLoad(
    () => (space ? call<Chat[]>("chats", space.id) : Promise.resolve([])),
    `chats:${space?.id}`,
  );
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
  const chatList = chats.data ?? [];
  const sent = (chatId: string) => {
    chats.reload();
    if (place.kind !== "chat" || place.id !== chatId) {
      go(pathOf.item("chat", chatId));
    }
  };
  let body: ReactNode;
  let part: Part | null = null;
  let back: string | null = null;
  let title: string | undefined;
  let sub: string | undefined;
  switch (place.kind) {
    case "home":
      part = "chat";
      body = (
        <Home space={space} person={person} hasChats={chatList.length > 0} go={go} onSent={sent} />
      );
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
    case "chat":
      part = PART_OF.chat;
      back = pathOf.home();
      title = chatList.find((c) => c.id === place.id)?.title || t("chats.untitled");
      sub = t("reach", { firm: firmName(space) });
      body = (
        <Conversation
          space={space}
          chatId={place.id}
          go={go}
          onSpace={onSpace}
          onChanged={chats.reload}
        />
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
  const chatId = place.kind === "chat" ? place.id : null;
  return (
    <div className={`app${back ? " has-back" : ""}${menu ? " menu-open" : ""}`}>
      <Side
        spaces={list}
        space={space}
        part={part}
        chatId={chatId}
        chats={chatList}
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
