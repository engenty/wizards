import type { DiscoverAnswer, DiscoverConnector } from "@engenty/wizards-shared/discover";
import type { SkillHit } from "@engenty/wizards-shared/skills";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Check, type LucideIcon, Plug, ScrollText, Search } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { type Key, lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { useCurrentSpace, useIsAdmin } from "../../lib/session";
import { Button, Card, Chip, Dialog, Spinner } from "../../ui";
import { RegistrySkillPreview } from "../space/Skills";

/*
 * Entdecken, the overview's second tab (docs/plans/capabilities.md, part B6): one search over
 * skills.sh and integrations.sh, the words in the address (`?q=`) so a search can be shared. A
 * skill is looked at or added here; a connector is set up on Connectors, by an admin. What the
 * space has already is marked „Im Space“.
 */

const EXAMPLES: Key[] = ["discover.example1", "discover.example2", "discover.example3"];
const queryKey = (spaceId: string, q?: string) =>
  q === undefined ? ["discover", spaceId] : ["discover", spaceId, q];

/** What the search box holds goes into the address once the typing pauses. */
export function useAskedWords(): [string, (next: string) => void, string] {
  const [params, setParams] = useSearchParams();
  const asked = params.get("q") ?? "";
  const [text, setText] = useState(asked);
  // Another address (back, a shared link) brings its own words.
  // Its own words, once in the address, stay as typed (a space at the end included).
  useEffect(() => setText((typed) => (typed.trim() === asked.trim() ? typed : asked)), [asked]);
  useEffect(() => {
    const words = text.trim();
    if (words === asked.trim()) {
      return;
    }
    const timer = setTimeout(
      () =>
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (words) {
              next.set("q", words);
            } else {
              next.delete("q");
            }
            return next;
          },
          { replace: true },
        ),
      350,
    );
    return () => clearTimeout(timer);
  }, [text, asked, setParams]);
  return [text, setText, asked.trim()];
}

/**
 * The directories' answer for `asked` (two letters at least): skills from skills.sh, connectors
 * from integrations.sh, what the space has already marked „Im Space“. Before a search, examples
 * that fill the search box (`onExample`).
 */
export function DiscoverResults({
  asked,
  onExample,
}: {
  asked: string;
  onExample: (words: string) => void;
}) {
  const { space } = useCurrentSpace();
  const admin = useIsAdmin();
  const skillsOn = useFeature("skills");
  const qc = useQueryClient();
  const [looking, setLooking] = useState<string | null>(null);
  const spaceId = space?.id ?? "";

  const found = useQuery({
    queryKey: queryKey(spaceId, asked),
    queryFn: () =>
      api.get<DiscoverAnswer>(
        `/api/studio/spaces/${spaceId}/discover?q=${encodeURIComponent(asked)}`,
      ),
    enabled: Boolean(spaceId) && asked.length >= 2,
    staleTime: 60_000,
  });

  // A skill added: marked „Im Space“ wherever a search shows it, without asking skills.sh again.
  const marked = (ref: string) => {
    qc.setQueriesData<DiscoverAnswer>({ queryKey: queryKey(spaceId) }, (d) =>
      d ? { ...d, skills: d.skills.map((s) => (s.ref === ref ? { ...s, added: true } : s)) } : d,
    );
    void qc.invalidateQueries({ queryKey: keys.skills(spaceId) });
  };
  const add = useMutation({
    mutationFn: (ref: string) =>
      api.post<{ id: string }>(`/api/studio/spaces/${spaceId}/skills/registry`, {
        ref,
        mode: "demand",
      }),
    onSuccess: (_, ref) => marked(ref),
  });

  const data = found.data;
  const nothing =
    data &&
    !data.skills.length &&
    !data.connectors.length &&
    !data.errors.skills &&
    !data.errors.connectors;

  if (!space) {
    return null;
  }
  return (
    <>
      {asked.length < 2 ? (
        <div className="flex flex-col gap-3 px-1 text-[0.875rem] text-ink-3">
          <p>{t("discover.start")}</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((key) => (
              <Button key={key} variant="secondary" size="sm" onClick={() => onExample(t(key))}>
                <Search className="size-3.5" /> {t(key)}
              </Button>
            ))}
          </div>
        </div>
      ) : found.error ? (
        <p className="px-1 text-[0.875rem] text-rose">{(found.error as Error).message}</p>
      ) : !data ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-5" />
        </div>
      ) : nothing ? (
        <p className="px-1 text-[0.875rem] text-ink-3">{t("discover.none", { q: asked })}</p>
      ) : (
        <>
          {skillsOn ? (
            <Group
              title={t("space.skills")}
              count={data.skills.length}
              error={data.errors.skills}
              empty={t("discover.groupNone", { directory: "skills.sh" })}
            >
              {data.skills.map((hit) => (
                <SkillResult
                  key={hit.ref}
                  hit={hit}
                  adding={add.isPending && add.variables === hit.ref}
                  failed={add.isError && add.variables === hit.ref ? add.error : null}
                  onLook={() => setLooking(hit.ref)}
                  onAdd={() => add.mutate(hit.ref)}
                />
              ))}
            </Group>
          ) : null}
          <Group
            title={t("capabilities.connectors")}
            count={data.connectors.length}
            error={data.errors.connectors}
            empty={t("discover.groupNone", { directory: "integrations.sh" })}
          >
            {data.connectors.map((hit) => (
              <ConnectorResult key={hit.domain} hit={hit} admin={admin} />
            ))}
          </Group>
        </>
      )}

      <Dialog
        open={looking !== null}
        onClose={() => setLooking(null)}
        wide
        height="tall"
        title={t("skills.registryTitle")}
      >
        {looking ? (
          <RegistrySkillPreview
            key={looking}
            spaceId={spaceId}
            skillRef={looking}
            onAdded={() => {
              marked(looking);
              setLooking(null);
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/** One directory's results: a heading with how many, then the rows, or why there are none. */
function Group({
  title,
  count,
  error,
  empty,
  children,
}: {
  title: string;
  count: number;
  error?: string;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="font-display font-semibold text-lg leading-tight">{title}</h2>
        {count ? <span className="text-[0.8125rem] text-ink-3">{count}</span> : null}
      </div>
      {error ? (
        <p className="px-1 text-[0.875rem] text-rose">{error}</p>
      ) : count ? (
        <Card className="divide-y divide-border-soft">{children}</Card>
      ) : (
        <p className="px-1 text-[0.875rem] text-ink-3">{empty}</p>
      )}
    </section>
  );
}

/** A result's row: what it is, where it comes from, and what can be done with it. */
function Row({
  icon: Icon,
  name,
  mono,
  chip,
  line,
  source,
  error,
  children,
}: {
  icon: LucideIcon;
  name: string;
  mono?: boolean;
  chip?: ReactNode;
  line?: string;
  source: string;
  /** What went wrong with its action. */
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 sm:flex-nowrap">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-paper-2 text-ink-3">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 max-sm:basis-[calc(100%-3.25rem)]">
        <span className="flex flex-wrap items-center gap-2">
          <span className={mono ? "font-medium font-mono text-[0.8125rem]" : "font-medium"}>
            {name}
          </span>
          {chip}
        </span>
        {line ? (
          <span className="mt-0.5 block truncate text-[0.8125rem] text-ink-2">{line}</span>
        ) : null}
        <span className="mt-0.5 block truncate text-[0.75rem] text-ink-3">{source}</span>
        {error ? <span className="mt-1 block text-[0.8125rem] text-rose">{error}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 max-sm:ml-[3.25rem]">{children}</span>
    </div>
  );
}

function InSpace() {
  return (
    <span className="inline-flex items-center gap-1 text-[0.8125rem] text-moss">
      <Check className="size-4" /> {t("capabilities.inSpace")}
    </span>
  );
}

function SkillResult({
  hit,
  adding,
  failed,
  onLook,
  onAdd,
}: {
  hit: SkillHit;
  adding: boolean;
  failed: Error | null;
  onLook: () => void;
  onAdd: () => void;
}) {
  return (
    <Row
      icon={ScrollText}
      name={hit.name}
      mono
      chip={
        hit.official ? (
          <Chip tone="live" icon={<BadgeCheck className="size-3" />}>
            {t("skills.official")}
          </Chip>
        ) : (
          <Chip tone="warn">{t("skills.unchecked")}</Chip>
        )
      }
      error={failed?.message}
      source={[
        "skills.sh",
        hit.source,
        t("skills.installs", { n: hit.installs.toLocaleString(lang) }),
      ].join(" · ")}
    >
      <Button variant="ghost" size="sm" onClick={onLook}>
        {t("skills.open")}
      </Button>
      {hit.added ? (
        <InSpace />
      ) : (
        <Button variant="secondary" size="sm" busy={adding} onClick={onAdd}>
          {t("skills.add")}
        </Button>
      )}
    </Row>
  );
}

function ConnectorResult({ hit, admin }: { hit: DiscoverConnector; admin: boolean }) {
  const navigate = useNavigate();
  const kinds = hit.kinds.map((k) => (k === "mcp" ? "MCP" : "OpenAPI"));
  return (
    <Row
      icon={Plug}
      name={hit.name}
      line={hit.description || undefined}
      source={["integrations.sh", hit.domain, ...kinds].join(" · ")}
    >
      {hit.setUp ? (
        <InSpace />
      ) : admin ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            navigate(`/capabilities/connectors?setup=${encodeURIComponent(hit.domain)}`)
          }
        >
          {t("discover.setUp")}
        </Button>
      ) : null}
    </Row>
  );
}
