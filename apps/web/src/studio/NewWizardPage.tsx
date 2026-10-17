import { scoreCatalogEntry } from "@engenty-wizards/shared/engenty/search-index/catalog-lexical";
import type { MarketplaceEntry } from "@engenty-wizards/shared/marketplace";
import { isSentence, searchTerms } from "@engenty-wizards/shared/marketplace-search";
import type { RunnerInfo } from "@engenty-wizards/shared/runners";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Mascot } from "../brand";
import { api } from "../lib/api";
import { withBase } from "../lib/base";
import { lang, t } from "../lib/i18n";
import {
  dropWish,
  pendingWish,
  useCurrentProject,
  useMayCreate,
  type WizardSummary,
} from "../lib/session";
import { useDictation, useDictationSettings } from "../lib/speech";
import {
  Button,
  Chip,
  cn,
  DictationButton,
  pastedName,
  Textarea,
  Thumb,
  workspaceFile,
} from "../ui";
import { ImportWizard } from "./ImportWizard";
import {
  EntryDialog,
  MarketplaceBrowser,
  ProChip,
  type SearchPage,
  useSettled,
} from "./Marketplace";
import {
  type ChannelId,
  ChannelPicker,
  channelLine,
  isDefaultChoice,
  runnerSettingsOf,
} from "./NewWizardChannels";

/** How many of the similar wizards are listed under the wish; the rest are a line to the gallery. */
const SIMILAR = 10;
/** Of the space's own wizards, at most this many, before the templates. */
const OWN = 3;

/** Puts a file into a wizard's workspace, as the editor's chat does with what is attached. */
async function putFile(wizardId: string, file: File) {
  const res = await fetch(
    withBase(`/api/studio/wizards/${wizardId}/files/${encodeURIComponent(file.name)}`),
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": file.type || "application/octet-stream", "accept-language": lang },
      body: file,
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? res.statusText);
  }
}

/** Takes a file off again: in a picture's corner, or at the end of a file's chip. */
function Detach({ over, onClick }: { over: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={t("editor.detach")}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        over
          ? "-top-1.5 -right-1.5 absolute size-5 bg-ink text-paper shadow-soft coarse:size-7"
          : "size-5 text-ink-3 hover:bg-paper-3 hover:text-ink coarse:size-7",
      )}
    >
      <X className="size-3" />
    </button>
  );
}

/** The space's own wizards the wish reads like, best first: the gallery's scoring on title and description. */
function ownMatches(wizards: WizardSummary[], wish: string): WizardSummary[] {
  const terms = searchTerms(wish);
  if (!terms.length) {
    return [];
  }
  const rows = wizards
    .map((w) => ({
      w,
      score: scoreCatalogEntry({ title: w.title, summary: w.description }, terms.join(" "), [
        ["title", 10],
        ["summary", 6],
      ]),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  // A sentence shares some word with nearly every wizard: only what comes close to the best counts.
  const least = isSentence(wish) ? (rows[0]?.score ?? 0) * 0.4 : 0;
  return rows
    .filter((row) => row.score >= least)
    .slice(0, OWN)
    .map((row) => row.w);
}

/**
 * While the wish is written: the space's own wizards and the templates that come close, so
 * nobody builds again what is there. Up to ten; the rest are one line to the gallery.
 */
function Similar({
  wish,
  projectId,
  busy,
  onTake,
  onMore,
}: {
  wish: string;
  projectId: string;
  busy: boolean;
  onTake: (entry: MarketplaceEntry) => void;
  onMore: (words: string) => void;
}) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<string | null>(null);
  const q = useSettled(wish.trim(), 300);
  const wizards = useQuery({
    queryKey: ["wizards", projectId, "similar"],
    queryFn: () => api.get<WizardSummary[]>(`/api/studio/projects/${projectId}/wizards`),
  });
  const templates = useQuery({
    queryKey: ["marketplace", lang, q, "similar"],
    queryFn: () =>
      api.get<SearchPage>(
        `/api/studio/marketplace?${new URLSearchParams({ lang, limit: String(SIMILAR), offset: "0", q })}`,
      ),
    enabled: q.length >= 3,
    placeholderData: keepPreviousData,
  });
  if (q.length < 3) {
    return null;
  }
  const own = ownMatches(wizards.data ?? [], q);
  const entries = (templates.data?.entries ?? []).slice(0, SIMILAR - own.length);
  const more = (templates.data?.total ?? 0) - entries.length;
  if (!(own.length || entries.length)) {
    return null;
  }
  const row = "flex items-center gap-3 rounded-xl bg-card py-2 pr-2 pl-3.5 ring-1 ring-border-soft";
  return (
    <section className="mt-5">
      <h2 className="mb-2 px-1 text-[0.8125rem] text-ink-3">{t("new.similar")}</h2>
      <ul className="flex flex-col gap-1.5">
        {own.map((w) => (
          <li key={w.id} className={row}>
            <Chip>{t("new.yours")}</Chip>
            <button
              type="button"
              onClick={() => navigate(`/edit/${w.id}`)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block truncate font-medium text-[0.9375rem]">{w.title}</span>
              <span className="block truncate text-[0.8125rem] text-ink-3">{w.description}</span>
            </button>
            <Button variant="secondary" size="sm" onClick={() => navigate(`/edit/${w.id}`)}>
              {t("new.open")}
            </Button>
          </li>
        ))}
        {entries.map((e) => (
          <li key={e.id} className={row}>
            <Chip>{t("new.template")}</Chip>
            <button
              type="button"
              onClick={() => setPicked(e.id)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-[0.9375rem]">{e.title}</span>
                {e.plan === "pro" ? <ProChip /> : null}
              </span>
              <span className="block truncate text-[0.8125rem] text-ink-3">{e.pitch}</span>
            </button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onTake(e)}>
              {t("new.take")}
            </Button>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          onClick={() => onMore(q)}
          className="mt-2 px-1 text-[0.875rem] text-ink-2 hover:text-ink coarse:min-h-11"
        >
          {t("new.more", { n: more })}
        </button>
      ) : null}
      <EntryDialog
        id={picked}
        fallback={entries.find((e) => e.id === picked) ?? null}
        onClose={() => setPicked(null)}
        onUse={onTake}
        busy={busy}
      />
    </section>
  );
}

export function NewWizardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { project } = useCurrentProject();
  const build = useMayCreate();
  // A link from the gallery names the template to open; one from the home's search brings the wish.
  const [params] = useSearchParams();
  // A wish a guest typed before signing in (GuestStartPage) is here too, and is built at once.
  const [prompt, setPrompt] = useState(() => params.get("wish") ?? pendingWish() ?? "");
  const guestWish = useRef(pendingWish() !== null);
  const [channels, setChannels] = useState<ChannelId[]>(["steps"]);
  const [files, setFiles] = useState<File[]>([]);
  const [dropping, setDropping] = useState(false);
  const [gallerySearch, setGallerySearch] = useState<{ text: string } | null>(null);
  const gallery = useRef<HTMLElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** A wizard made by a try whose files did not all arrive: the next try finishes it. */
  const made = useRef<string | null>(null);
  const [prefs] = useDictationSettings();
  const speech = useDictation(prompt, setPrompt, { deviceId: prefs.deviceId });
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerInfo[]>("/api/studio/runners"),
  });

  // Named as the workspace keeps them, so the chip shows the name the file is stored under.
  const add = (raw: File[]) => {
    const picked = raw.map(workspaceFile);
    setFiles((all) => [...all.filter((f) => !picked.some((p) => p.name === f.name)), ...picked]);
  };
  const [thumbs, setThumbs] = useState<Map<File, string>>(new Map());
  useEffect(() => {
    const next = new Map(
      files.filter((f) => f.type.startsWith("image/")).map((f) => [f, URL.createObjectURL(f)]),
    );
    setThumbs(next);
    return () => {
      for (const url of next.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [files]);

  const fromStarter = useMutation({
    mutationFn: (starterId: string) =>
      api.post<{ id: string }>("/api/studio/wizards", { projectId: project!.id, starterId, lang }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      await qc.invalidateQueries({ queryKey: ["wizards"] });
      navigate(`/edit/${id}`);
    },
  });

  // The wish becomes the first message: what it should do, how it runs where that is not the
  // usual, and the files, which go into the workspace first and are named on the last line.
  const create = useMutation({
    mutationFn: async () => {
      const id =
        made.current ??
        (await api.post<{ id: string }>("/api/studio/wizards", { projectId: project!.id, lang }))
          .id;
      made.current = id;
      if (!isDefaultChoice(channels)) {
        await api.patch(`/api/studio/wizards/${id}`, { runners: runnerSettingsOf(channels) });
      }
      for (const file of files) {
        await putFile(id, file);
      }
      return id;
    },
    onSuccess: async (id) => {
      dropWish();
      await qc.invalidateQueries({ queryKey: ["projects"] });
      await qc.invalidateQueries({ queryKey: ["wizards"] });
      let message = prompt.trim();
      if (!isDefaultChoice(channels)) {
        message += `\n\n${channelLine(channels)}`;
      }
      if (files.length) {
        message += `\n\n${t("editor.attached")}: ${files.map((f) => f.name).join(", ")}`;
      }
      navigate(`/edit/${id}?prompt=${encodeURIComponent(message)}`);
    },
  });

  const submit = () => {
    if (prompt.trim() && project && !create.isPending) {
      if (speech.listening) {
        speech.stop();
      }
      create.mutate();
    }
  };

  useEffect(() => {
    if (guestWish.current && project && build && !project.readOnly && prompt.trim()) {
      guestWish.current = false;
      create.mutate();
    }
  }, [project, build, prompt, create]);

  // Nothing is made here, or not in this project (a local install's): back to what there is.
  if (!build || project?.readOnly) {
    return <Navigate to="/" replace />;
  }
  const error = create.error ?? fromStarter.error;

  return (
    <div className="animate-rise md:pt-4">
      <div className="mx-auto max-w-2xl">
        <div className="flex flex-col items-center text-center">
          {/* On a phone the same engenty at a little over half its size: scaled, so it stays
            the fluffy one (Mascot draws a flat one below 120). */}
          <div className="size-[84px] md:size-auto">
            <div className="origin-top-left scale-[0.56] md:scale-100">
              <Mascot kind="sprout" size={150} fluffy />
            </div>
          </div>
          <h1 className="mt-1 font-display font-semibold text-[1.5rem] leading-tight tracking-tight md:mt-2 md:text-[2.375rem]">
            {t("new.title")}
          </h1>
        </div>

        <ChannelPicker
          value={channels}
          onChange={setChannels}
          runners={runners.data}
          className="mt-4 px-1 md:mt-8"
        />
        <div
          className={cn(
            "relative mt-3 rounded-2xl bg-card p-2 shadow-elevated ring-1 ring-border-soft focus-within:ring-focus",
            dropping && "ring-2 ring-focus",
          )}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDropping(true);
            }
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDropping(false);
            add(Array.from(e.dataTransfer.files).map(pastedName));
          }}
        >
          {files.length ? (
            <div className="flex flex-wrap items-center gap-2 px-2 pt-2 pb-1">
              {files.map((f, i) => {
                const url = thumbs.get(f);
                const drop = () => setFiles((all) => all.filter((_, j) => j !== i));
                return url ? (
                  <Thumb key={`${f.name}-${i}`} url={url} label={f.name}>
                    <Detach over={Boolean(url)} onClick={drop} />
                  </Thumb>
                ) : (
                  <span
                    key={`${f.name}-${i}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-paper-2 py-1 pr-1 pl-2.5 text-[0.8125rem] text-ink-2"
                  >
                    <Paperclip className="size-3.5 shrink-0 text-ink-4" />
                    <span className="truncate">{f.name}</span>
                    <Detach over={Boolean(url)} onClick={drop} />
                  </span>
                );
              })}
            </div>
          ) : null}
          <Textarea
            autoFocus
            minRows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length) {
                e.preventDefault();
                add(pasted.map(pastedName));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                submit();
              }
            }}
            placeholder={speech.listening ? t("editor.listening") : t("new.placeholder")}
            className="border-0 bg-transparent text-[1rem] shadow-none focus:ring-0"
          />
          <div className="flex items-center gap-2 px-1 pb-1">
            <button
              type="button"
              aria-label={t("editor.attach")}
              title={t("editor.attach")}
              onClick={() => picker.current?.click()}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-ink transition hover:bg-paper-2 coarse:size-11"
            >
              <Plus className="size-4" />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                add(picked);
              }}
            />
            {speech.supported ? <DictationButton speech={speech} labelled /> : null}
            <span className="min-w-0 flex-1 truncate text-[0.75rem] text-ink-4">
              {dropping ? t("new.dropHint") : null}
            </span>
            <Button
              size="md"
              onClick={submit}
              busy={create.isPending}
              disabled={!prompt.trim() || fromStarter.isPending}
            >
              {t("new.build")} <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
        <p className="mt-3 text-center text-[0.875rem] text-ink-3">{t("new.hint")}</p>
        {speech.error ? (
          <p className="mt-2 px-3 text-[0.75rem] text-rose">
            {speech.error === "denied" ? t("editor.micDenied") : speech.error}
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 text-center text-[0.875rem] text-rose">{(error as Error).message}</p>
        ) : null}
        {project ? (
          <Similar
            wish={prompt}
            projectId={project.id}
            busy={fromStarter.isPending || create.isPending}
            onTake={(entry) => !fromStarter.isPending && fromStarter.mutate(entry.id)}
            onMore={(words) => {
              setGallerySearch({ text: words });
              gallery.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
        ) : null}
      </div>

      <section ref={gallery} className="mx-auto max-w-5xl scroll-mt-6">
        <h2 className="mt-16 mb-5 text-center font-medium text-[0.8125rem] text-ink-3 uppercase tracking-[0.08em]">
          {t("new.orStarter")}
        </h2>
        <MarketplaceBrowser
          open={params.get("starter")}
          search={gallerySearch}
          busy={fromStarter.isPending}
          onUse={(entry) => project && !fromStarter.isPending && fromStarter.mutate(entry.id)}
        />
      </section>
      <div className="mt-8 flex justify-center">
        <ImportWizard variant="ghost" label={t("new.import")} />
      </div>
    </div>
  );
}
