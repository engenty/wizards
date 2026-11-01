import { RunnerBody } from "@engenty/wizards-runner";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type Brand,
  CallError,
  type Chat,
  type ChatMessages,
  type ClientSpace,
  call,
  type Face,
  type ForYou,
  fileUrl,
  keepTicket,
  openRun,
  type Result,
  type SessionInfo,
  type SpaceFile,
  session,
  signInUrl,
  signOut,
  type Wizard,
} from "./api";
import { switchLang, type TextKey, t } from "./i18n";
import { runnerLook, wearBrand } from "./look";
import { useRun } from "./useRun";

/*
 * The client portal (docs/plans/client-portal.md): the firm's public face before sign-in, then
 * the client's client spaces. Addresses: /portal, /portal/<space>, …/chats, …/files, …/results,
 * …/runs/<run>, …/<wizard>.
 */

type Part = "forYou" | "chats" | "files" | "results";
const PARTS: { id: Part; path: string; label: TextKey }[] = [
  { id: "forYou", path: "", label: "nav.forYou" },
  { id: "chats", path: "chats", label: "nav.chats" },
  { id: "files", path: "files", label: "nav.files" },
  { id: "results", path: "results", label: "nav.results" },
];

/** Where the address points, below /portal. */
function placeOf(pathname: string) {
  const [slug = "", part = "", id = ""] = pathname
    .replace(/^\/portal\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  return { slug, part, id };
}

function usePath(): [string, (to: string) => void] {
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
}: {
  to: string;
  go: (to: string) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) {
          e.preventDefault();
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
  new Date(iso).toLocaleDateString(document.documentElement.lang, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function Logo({ brand, name }: { brand: { logoUrl: string | null } | null; name: string }) {
  if (brand?.logoUrl) {
    const src = brand.logoUrl.startsWith("/") ? `/portal${brand.logoUrl}` : brand.logoUrl;
    return <img className="logo" src={src} alt={name} />;
  }
  return <span className="wordmark">{name}</span>;
}

function LangSwitch() {
  return (
    <button type="button" className="link" onClick={switchLang}>
      {t("language")}
    </button>
  );
}

// --- before sign-in ----------------------------------------------------------------------------

/** The firm's public face: its page's words and wizards, and the sign-in where clients have one. */
function PublicFace({ face, failed }: { face: Face | null; failed: boolean }) {
  const page = face?.page ?? null;
  const firm = page?.brand.name || face?.team.name || "";
  useEffect(() => wearBrand(page?.brand.theme ?? null), [page]);
  return (
    <div className="public">
      <header className="band">
        <div className="wrap band-inner">
          <Logo brand={page?.brand ?? null} name={firm} />
          <LangSwitch />
        </div>
      </header>
      <main className="wrap stack">
        {page ? (
          <section className="stack-sm">
            <h1>{page.headline || page.title}</h1>
            {page.intro ? <p className="lead">{page.intro}</p> : null}
          </section>
        ) : null}
        {face?.portal ? (
          <section className="card signin">
            <h2>{t("signIn.clients", { firm })}</h2>
            <p>{t("signIn.lead", { firm })}</p>
            {failed ? <p className="warn">{t("signIn.failed")}</p> : null}
            <a className="button" href={signInUrl("/portal")}>
              {t("signIn")}
            </a>
          </section>
        ) : null}
        {page?.wizards.length ? (
          <section className="stack-sm">
            <h2>{t("public.wizards")}</h2>
            <ul className="rows">
              {page.wizards.map((w) => (
                <li key={w.slug} className="row">
                  <div className="row-main">
                    <strong>{w.title}</strong>
                    <span className="quiet">{w.description}</span>
                  </div>
                  <a className="button ghost" href={w.runUrl}>
                    {t("public.start")}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {!page && !face?.portal ? <p className="quiet">{t("public.nothing")}</p> : null}
      </main>
    </div>
  );
}

// --- signed in ---------------------------------------------------------------------------------

function Shell({
  space,
  part,
  go,
  person,
  children,
}: {
  space: ClientSpace;
  part: Part | null;
  go: (to: string) => void;
  person: { name: string };
  children: ReactNode;
}) {
  const base = `/portal/${encodeURIComponent(space.slug)}`;
  return (
    <div className="app">
      <header className="band">
        <div className="wrap band-inner">
          <div className="who">
            <Logo brand={space.firm.brand} name={firmName(space)} />
            <span className="space-name">{space.name}</span>
          </div>
          <div className="me">
            <span className="quiet person">{person.name}</span>
            <LangSwitch />
            <button
              type="button"
              className="link"
              onClick={() => void signOut().then(() => location.assign("/portal"))}
            >
              {t("signOut")}
            </button>
          </div>
        </div>
      </header>
      <div className="wrap body">
        <nav className="parts" aria-label={space.name}>
          {PARTS.map((p) => (
            <Go
              key={p.id}
              to={p.path ? `${base}/${p.path}` : base}
              go={go}
              className={`part${p.id === part ? " on" : ""}`}
            >
              {t(p.label)}
            </Go>
          ))}
        </nav>
        <main className="content">
          <p className="space-line">{space.name}</p>
          {children}
        </main>
      </div>
    </div>
  );
}

function ResultRows({
  results,
  base,
  go,
}: {
  results: Result[];
  base: string;
  go: (to: string) => void;
}) {
  return (
    <ul className="rows">
      {results.map((r) => (
        <li key={r.runId}>
          <Go to={`${base}/runs/${r.runId}`} go={go} className="row">
            <div className="row-main">
              <strong>{r.title}</strong>
              <span className="quiet">{dateOf(r.updatedAt)}</span>
            </div>
            <span className="chip">{r.mine ? t("results.mine") : t("results.shared")}</span>
          </Go>
        </li>
      ))}
    </ul>
  );
}

function ForYouPart({ space, go }: { space: ClientSpace; go: (to: string) => void }) {
  const firm = firmName(space);
  const base = `/portal/${encodeURIComponent(space.slug)}`;
  const { data, error, loading } = useLoad(() => call<ForYou>("for_you", space.id), space.id);
  if (loading && !data) {
    return <Loading />;
  }
  if (error || !data) {
    return <Failed error={error ?? ""} />;
  }
  return (
    <div className="stack">
      <section className="stack-sm">
        <h2>{t("forYou.waiting")}</h2>
        {data.waiting.length ? (
          <ul className="rows">
            {data.waiting.map((r) => (
              <li key={r.runId}>
                <Go to={`${base}/runs/${r.runId}`} go={go} className="row">
                  <div className="row-main">
                    <strong>{r.title}</strong>
                    <span className="quiet">{dateOf(r.updatedAt)}</span>
                  </div>
                  <span className="button small">{t("forYou.continue")}</span>
                </Go>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">{t("forYou.waiting.empty")}</p>
        )}
      </section>
      <section className="stack-sm">
        <h2>{t("forYou.shared", { firm })}</h2>
        {data.shared.length ? (
          <ResultRows results={data.shared} base={base} go={go} />
        ) : (
          <p className="quiet">{t("forYou.shared.empty")}</p>
        )}
      </section>
      <section className="stack-sm">
        <h2>{t("forYou.wizards")}</h2>
        {data.wizards.length ? (
          <ul className="tiles">
            {data.wizards.map((w) => (
              <li key={w.id}>
                <Go to={`${base}/${w.slug}`} go={go} className="tile">
                  <strong>{w.title}</strong>
                  <span className="quiet">{w.description}</span>
                </Go>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">{t("forYou.wizards.empty", { firm })}</p>
        )}
      </section>
    </div>
  );
}

function ResultsPart({ space, go }: { space: ClientSpace; go: (to: string) => void }) {
  const { data, error, loading } = useLoad(() => call<Result[]>("results", space.id), space.id);
  const base = `/portal/${encodeURIComponent(space.slug)}`;
  return (
    <section className="stack-sm">
      <h2>{t("results.title")}</h2>
      {loading && !data ? (
        <Loading />
      ) : error || !data ? (
        <Failed error={error ?? ""} />
      ) : data.length ? (
        <ResultRows results={data} base={base} go={go} />
      ) : (
        <p className="quiet">{t("results.empty", { firm: firmName(space) })}</p>
      )}
    </section>
  );
}

const sizeOf = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function FilesPart({ space }: { space: ClientSpace }) {
  const { data, error, loading } = useLoad(() => call<SpaceFile[]>("files", space.id), space.id);
  return (
    <section className="stack-sm">
      <h2>{t("files.title")}</h2>
      {loading && !data ? (
        <Loading />
      ) : error || !data ? (
        <Failed error={error ?? ""} />
      ) : data.length ? (
        <ul className="rows">
          {data.map((f) => (
            <li key={f.id} className="row">
              <div className="row-main">
                <strong>{f.name}</strong>
                <span className="quiet">
                  {dateOf(f.createdAt)} · {sizeOf(f.size)}
                </span>
              </div>
              <a className="button ghost small" href={fileUrl(space.id, f.id)} download={f.name}>
                {t("files.download")}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet">{t("files.empty")}</p>
      )}
    </section>
  );
}

function Composer({
  space,
  chatId,
  onSent,
}: {
  space: ClientSpace;
  chatId: string | null;
  onSent: (chatId: string) => void;
}) {
  const [text, setText] = useState("");
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firm = firmName(space);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sent = await call<{ chatId: string }>("chat_post", space.id, {
        ...(chatId ? { chatId } : {}),
        text: text.trim(),
        ask,
      });
      setText("");
      onSent(sent.chatId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="composer" onSubmit={send}>
      <textarea
        id="chat-text"
        value={text}
        rows={3}
        placeholder={t("chats.placeholder", { firm })}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            void send(e);
          }
        }}
      />
      <div className="composer-bar">
        <label className="check" title={t("chats.ask.hint", { firm })}>
          <input
            id="chat-ask"
            type="checkbox"
            checked={ask}
            onChange={(e) => setAsk(e.target.checked)}
          />
          {t("chats.ask")}
        </label>
        <button className="button" type="submit" disabled={busy || !text.trim()}>
          {t("chats.send")}
        </button>
      </div>
      {error ? <p className="warn">{t("error", { error })}</p> : null}
    </form>
  );
}

function Conversation({ space, chatId }: { space: ClientSpace; chatId: string }) {
  const [data, setData] = useState<ChatMessages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      call<ChatMessages>("chat_messages", space.id, { chatId }).then(
        (read) => {
          setData(read);
          setError(null);
        },
        (err: Error) => setError(err.message),
      ),
    [space.id, chatId],
  );
  useEffect(() => {
    void load();
    // The firm's people and the AI write here too: a look every few seconds while it is open.
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);
  // A look that fails while messages are shown leaves them; the next one may answer again.
  if (!data) {
    return error ? <Failed error={error} /> : <Loading />;
  }
  return (
    <div className="conversation">
      <ol className="messages">
        {data.messages.map((m) => (
          <li key={m.id} className={`message${m.author.me ? " mine" : ""}`}>
            <span className="author">
              {m.author.me
                ? t("chats.you")
                : m.author.kind === "ai"
                  ? t("chats.ai")
                  : m.author.name}
            </span>
            <p>{m.text}</p>
          </li>
        ))}
      </ol>
      {data.chat.answering ? <p className="quiet">{t("chats.answering")}</p> : null}
      <Composer space={space} chatId={chatId} onSent={() => void load()} />
    </div>
  );
}

function ChatsPart({
  space,
  chatId,
  go,
}: {
  space: ClientSpace;
  chatId: string;
  go: (to: string) => void;
}) {
  const base = `/portal/${encodeURIComponent(space.slug)}/chats`;
  const { data, error, loading, reload } = useLoad(
    () => call<Chat[]>("chats", space.id),
    `${space.id}:${chatId}`,
  );
  const firm = firmName(space);
  const list = (
    <div className="chat-list stack-sm">
      <div className="split">
        <h2>{t("chats.title")}</h2>
        <Go to={`${base}/new`} go={go} className="button ghost small">
          {t("chats.new")}
        </Go>
      </div>
      {loading && !data ? (
        <Loading />
      ) : error || !data ? (
        <Failed error={error ?? ""} />
      ) : data.length ? (
        <ul className="rows">
          {data.map((c) => (
            <li key={c.id}>
              <Go to={`${base}/${c.id}`} go={go} className={`row${c.id === chatId ? " on" : ""}`}>
                <div className="row-main">
                  <strong>{c.title || t("chats.untitled")}</strong>
                  {c.last ? (
                    <span className="quiet clip">
                      {c.last.name}: {c.last.text}
                    </span>
                  ) : null}
                </div>
              </Go>
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet">{t("chats.empty", { firm })}</p>
      )}
    </div>
  );
  const open = chatId ? (
    <div className="chat-open stack-sm">
      <Go to={base} go={go} className="link back">
        {t("chats.back")}
      </Go>
      {chatId === "new" ? (
        <Composer
          space={space}
          chatId={null}
          onSent={(id) => {
            reload();
            go(`${base}/${id}`);
          }}
        />
      ) : (
        <Conversation space={space} chatId={chatId} />
      )}
    </div>
  ) : null;
  return (
    <div className={`chats${chatId ? " has-open" : ""}`}>
      {list}
      {open}
    </div>
  );
}

function RunPart({
  space,
  runId,
  go,
}: {
  space: ClientSpace;
  runId: string;
  go: (to: string) => void;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReady(false);
    openRun(space.id, runId).then(
      () => setReady(true),
      (err: Error) =>
        setError(err instanceof CallError && err.status === 404 ? t("notFound") : err.message),
    );
  }, [space.id, runId]);
  const run = useRun(ready ? runId : null);
  const base = `/portal/${encodeURIComponent(space.slug)}`;
  if (error) {
    return <Failed error={error} />;
  }
  return (
    <div className="stack-sm">
      <Go to={base} go={go} className="link back">
        {t("run.back")}
      </Go>
      <div className="engenty-runner run" {...runnerLook(space.firm.brand.theme)}>
        {run.view ? <RunnerBody run={run} /> : <Loading />}
      </div>
    </div>
  );
}

function WizardPart({
  space,
  slug,
  go,
}: {
  space: ClientSpace;
  slug: string;
  go: (to: string) => void;
}) {
  const { data, error, loading } = useLoad(() => call<Wizard[]>("wizards", space.id), space.id);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (loading && !data) {
    return <Loading />;
  }
  const wizard = data?.find((w) => w.slug === slug);
  if (error || !wizard) {
    return <Failed error={error ?? t("notFound")} />;
  }
  const start = async () => {
    setStarting(true);
    setFailed(null);
    try {
      const { runId, ticket } = await call<{ runId: string; ticket: string }>(
        "wizard_start",
        space.id,
        { wizardId: wizard.id },
      );
      keepTicket(runId, ticket);
      go(`/portal/${encodeURIComponent(space.slug)}/runs/${runId}`);
    } catch (err) {
      setFailed((err as Error).message);
      setStarting(false);
    }
  };
  return (
    <section className="card stack-sm">
      <h1>{wizard.title}</h1>
      {wizard.description ? <p className="lead">{wizard.description}</p> : null}
      {failed ? <p className="warn">{t("error", { error: failed })}</p> : null}
      <div>
        <button className="button" type="button" disabled={starting} onClick={() => void start()}>
          {starting ? t("wizard.starting") : t("wizard.start")}
        </button>
      </div>
    </section>
  );
}

function SpacesList({ spaces, go }: { spaces: ClientSpace[]; go: (to: string) => void }) {
  return (
    <main className="wrap stack">
      <h1>{t("spaces.title")}</h1>
      <ul className="tiles">
        {spaces.map((s) => (
          <li key={s.id}>
            <Go to={`/portal/${encodeURIComponent(s.slug)}`} go={go} className="tile">
              <strong>{s.name}</strong>
              <span className="quiet">{firmName(s)}</span>
            </Go>
          </li>
        ))}
      </ul>
    </main>
  );
}

function Notice({ face, title, hint }: { face: Face | null; title: string; hint: string }) {
  return (
    <div className="public">
      <header className="band">
        <div className="wrap band-inner">
          <Logo brand={face?.page?.brand ?? null} name={face?.team.name ?? ""} />
          <button
            type="button"
            className="link"
            onClick={() => void signOut().then(() => location.assign("/portal"))}
          >
            {t("signOut")}
          </button>
        </div>
      </header>
      <main className="wrap stack-sm">
        <h1>{title}</h1>
        <p className="lead">{hint}</p>
      </main>
    </div>
  );
}

function SignedIn({
  info,
  go,
  path,
}: {
  info: SessionInfo;
  go: (to: string) => void;
  path: string;
}) {
  const firm = info.face?.page?.brand.name || info.face?.team.name || "";
  const spaces = useLoad(() => call<ClientSpace[]>("spaces"), "spaces");
  const { slug, part, id } = placeOf(path);
  const list = spaces.data ?? [];
  const space = list.find((s) => s.slug === slug) ?? null;
  const brand: Brand | null = space?.firm.brand ?? null;
  useEffect(() => wearBrand(brand?.theme ?? null, brand?.accent), [brand]);
  // One client space: straight in.
  useEffect(() => {
    if (!slug && list.length === 1) {
      history.replaceState(null, "", `/portal/${encodeURIComponent(list[0].slug)}`);
      go(`/portal/${encodeURIComponent(list[0].slug)}`);
    }
  }, [slug, list, go]);
  if (spaces.loading && !spaces.data) {
    return <Loading />;
  }
  if (spaces.error) {
    return <Notice face={info.face} title={t("error", { error: spaces.error })} hint="" />;
  }
  if (!list.length) {
    return <Notice face={info.face} title={t("noSpaces")} hint={t("noSpaces.hint", { firm })} />;
  }
  if (!space) {
    return slug ? (
      <Notice face={info.face} title={t("notFound")} hint="" />
    ) : (
      <SpacesList spaces={list} go={go} />
    );
  }
  const person = { name: info.person?.name || info.person?.email || "" };
  const known = PARTS.find((p) => p.path === part && p.path);
  const shown: Part | null = !part ? "forYou" : known ? known.id : null;
  let body: ReactNode;
  if (!part) {
    body = <ForYouPart space={space} go={go} />;
  } else if (part === "chats") {
    body = <ChatsPart space={space} chatId={id} go={go} />;
  } else if (part === "files") {
    body = <FilesPart space={space} />;
  } else if (part === "results") {
    body = <ResultsPart space={space} go={go} />;
  } else if (part === "runs" && id) {
    body = <RunPart space={space} runId={id} go={go} />;
  } else {
    body = <WizardPart space={space} slug={part} go={go} />;
  }
  return (
    <Shell space={space} part={shown} go={go} person={person}>
      {body}
    </Shell>
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
      <main className="wrap">
        <Failed error={error} />
      </main>
    );
  }
  if (!info) {
    return (
      <main className="wrap">
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
