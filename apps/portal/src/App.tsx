import { RunnerBody } from "@engenty/wizards-runner";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { type ItemKind, NEW_CHAT, type PartName, pathOf, placeOf } from "../server/paths";
import {
  type Brand,
  CallError,
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
import { switchLang, type TextKey, t } from "./i18n";
import { runnerLook, wearBrand } from "./look";
import { useRun } from "./useRun";

/*
 * The client portal (docs/plans/client-portal.md): the firm's public face before sign-in, then
 * the client's home in the client space this tab is on. No address names a client space
 * (server/paths.ts): the parts have a word each, a deep link names its item.
 */

type Part = "forYou" | PartName;
const PARTS: { id: Part; to: string; label: TextKey }[] = [
  { id: "forYou", to: pathOf.home(), label: "nav.forYou" },
  { id: "chats", to: pathOf.part("chats"), label: "nav.chats" },
  { id: "files", to: pathOf.part("files"), label: "nav.files" },
  { id: "results", to: pathOf.part("results"), label: "nav.results" },
];

/** The part an item belongs to, for the bar. */
const PART_OF: Record<ItemKind, Part> = {
  run: "results",
  chat: "chats",
  file: "files",
  wizard: "forYou",
};

type Go = (to: string) => void;

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
            <a className="button" href={signInUrl(pathOf.home())}>
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

function SpaceSwitch({
  spaces,
  space,
  onSwitch,
}: {
  spaces: ClientSpace[];
  space: ClientSpace;
  onSwitch: (id: string) => void;
}) {
  if (spaces.length < 2) {
    return <p className="space-line">{space.name}</p>;
  }
  return (
    <label className="space-line switch">
      <span className="sr">{t("spaces.switch")}</span>
      <select id="space-switch" value={space.id} onChange={(e) => onSwitch(e.target.value)}>
        {spaces.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Shell({
  spaces,
  space,
  part,
  go,
  person,
  onSwitch,
  children,
}: {
  spaces: ClientSpace[];
  space: ClientSpace;
  part: Part | null;
  go: Go;
  person: { name: string };
  onSwitch: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <header className="band">
        <div className="wrap band-inner">
          <div className="who">
            <Logo brand={space.firm.brand} name={firmName(space)} />
          </div>
          <div className="me">
            <span className="quiet person">{person.name}</span>
            <LangSwitch />
            <button
              type="button"
              className="link"
              onClick={() => void signOut().then(() => location.assign(pathOf.home()))}
            >
              {t("signOut")}
            </button>
          </div>
        </div>
      </header>
      <div className="wrap body">
        <nav className="parts" aria-label={t("nav.label")}>
          {PARTS.map((p) => (
            <Go key={p.id} to={p.to} go={go} className={`part${p.id === part ? " on" : ""}`}>
              {t(p.label)}
            </Go>
          ))}
        </nav>
        <main className="content">
          <SpaceSwitch spaces={spaces} space={space} onSwitch={onSwitch} />
          {children}
        </main>
      </div>
    </div>
  );
}

function ResultRows({ results, go }: { results: Result[]; go: Go }) {
  return (
    <ul className="rows">
      {results.map((r) => (
        <li key={r.runId}>
          <Go to={pathOf.item("run", r.runId)} go={go} className="row">
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

function ForYouPart({ space, go }: { space: ClientSpace; go: Go }) {
  const firm = firmName(space);
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
                <Go to={pathOf.item("run", r.runId)} go={go} className="row">
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
          <ResultRows results={data.shared} go={go} />
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
                <Go to={pathOf.item("wizard", w.id)} go={go} className="tile">
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

function ResultsPart({ space, go }: { space: ClientSpace; go: Go }) {
  const { data, error, loading } = useLoad(() => call<Result[]>("results", space.id), space.id);
  return (
    <section className="stack-sm">
      <h2>{t("results.title")}</h2>
      {loading && !data ? (
        <Loading />
      ) : error || !data ? (
        <Failed error={error ?? ""} />
      ) : data.length ? (
        <ResultRows results={data} go={go} />
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

function FileRow({ file, go }: { file: SpaceFile; go: Go }) {
  return (
    <li className="row">
      <Go to={pathOf.item("file", file.id)} go={go} className="row-main plain">
        <strong>{file.name}</strong>
        <span className="quiet">
          {dateOf(file.createdAt)} · {sizeOf(file.size)}
        </span>
      </Go>
      <a className="button ghost small" href={fileUrl(file.id)} download={file.name}>
        {t("files.download")}
      </a>
    </li>
  );
}

function FilesPart({ space, go }: { space: ClientSpace; go: Go }) {
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
            <FileRow key={f.id} file={f} go={go} />
          ))}
        </ul>
      ) : (
        <p className="quiet">{t("files.empty")}</p>
      )}
    </section>
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
    <div className="stack-sm">
      <Go to={pathOf.part("files")} go={go} className="link back">
        {t("files.all")}
      </Go>
      <ul className="rows">
        <FileRow file={data.file} go={go} />
      </ul>
    </div>
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

/** One chat by its deep link: its client space becomes the tab's. */
function Conversation({
  space,
  chatId,
  onSpace,
}: {
  space: ClientSpace;
  chatId: string;
  onSpace: (id: string) => void;
}) {
  const [data, setData] = useState<ChatMessages | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  useEffect(() => {
    setData(null);
    void load();
    // The firm's people and the AI write here too: a look every few seconds while it is open.
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (data) {
      onSpace(data.spaceId);
    }
  }, [data, onSpace]);
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
      {data.spaceId === space.id ? (
        <Composer space={space} chatId={chatId} onSent={() => void load()} />
      ) : null}
    </div>
  );
}

function ChatsPart({
  space,
  chatId,
  go,
  onSpace,
}: {
  space: ClientSpace;
  chatId: string | null;
  go: Go;
  onSpace: (id: string) => void;
}) {
  const { data, error, loading, reload } = useLoad(
    () => call<Chat[]>("chats", space.id),
    `${space.id}:${chatId}`,
  );
  const firm = firmName(space);
  const list = (
    <div className="chat-list stack-sm">
      <div className="split">
        <h2>{t("chats.title")}</h2>
        <Go to={pathOf.item("chat", NEW_CHAT)} go={go} className="button ghost small">
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
              <Go
                to={pathOf.item("chat", c.id)}
                go={go}
                className={`row${c.id === chatId ? " on" : ""}`}
              >
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
      <Go to={pathOf.part("chats")} go={go} className="link back">
        {t("chats.back")}
      </Go>
      {chatId === NEW_CHAT ? (
        <Composer
          space={space}
          chatId={null}
          onSent={(id) => {
            reload();
            go(pathOf.item("chat", id));
          }}
        />
      ) : (
        <Conversation space={space} chatId={chatId} onSpace={onSpace} />
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
    <div className="stack-sm">
      <Go to={pathOf.part("results")} go={go} className="link back">
        {t("run.back")}
      </Go>
      <div className="engenty-runner run" {...runnerLook(space.firm.brand.theme)}>
        {run.view ? <RunnerBody run={run} /> : <Loading />}
      </div>
    </div>
  );
}

/** One of the firm's wizards opened to clients: its start, in the tab's client space. */
function WizardItem({ space, wizardId, go }: { space: ClientSpace; wizardId: string; go: Go }) {
  const { data, error, loading } = useLoad(() => call<Wizard[]>("wizards", space.id), space.id);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (loading && !data) {
    return <Loading />;
  }
  const wizard = data?.find((w) => w.id === wizardId);
  if (error || !wizard) {
    return <Failed error={t("notFound")} />;
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
      go(pathOf.item("run", runId));
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

function Notice({ face, title, hint }: { face: Face | null; title: string; hint: string }) {
  return (
    <div className="public">
      <header className="band">
        <div className="wrap band-inner">
          <Logo brand={face?.page?.brand ?? null} name={face?.team.name ?? ""} />
          <button
            type="button"
            className="link"
            onClick={() => void signOut().then(() => location.assign(pathOf.home()))}
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

/**
 * The client's portal. The client space is the tab's (api.ts `tabSpace`); a deep link moves the
 * tab to its item's client space once the contract has found it.
 */
function SignedIn({ info, go, path }: { info: SessionInfo; go: Go; path: string }) {
  const firm = info.face?.page?.brand.name || info.face?.team.name || "";
  const spaces = useLoad(() => call<ClientSpace[]>("spaces"), "spaces");
  const [current, setCurrent] = useState<string | null>(tabSpace);
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
  const person = { name: info.person?.name || info.person?.email || "" };
  let body: ReactNode;
  let part: Part | null = null;
  switch (place.kind) {
    case "home":
      part = "forYou";
      body = <ForYouPart space={space} go={go} />;
      break;
    case "part":
      part = place.part;
      body =
        place.part === "chats" ? (
          <ChatsPart space={space} chatId={null} go={go} onSpace={onSpace} />
        ) : place.part === "files" ? (
          <FilesPart space={space} go={go} />
        ) : (
          <ResultsPart space={space} go={go} />
        );
      break;
    case "run":
      part = PART_OF.run;
      body = <RunItem space={space} runId={place.id} go={go} onSpace={onSpace} />;
      break;
    case "chat":
      part = PART_OF.chat;
      body = <ChatsPart space={space} chatId={place.id} go={go} onSpace={onSpace} />;
      break;
    case "file":
      part = PART_OF.file;
      body = <FileItem fileId={place.id} go={go} onSpace={onSpace} />;
      break;
    case "wizard":
      part = PART_OF.wizard;
      body = <WizardItem space={space} wizardId={place.id} go={go} />;
      break;
    default:
      body = <Failed error={t("notFound")} />;
  }
  return (
    <Shell
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
    >
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
