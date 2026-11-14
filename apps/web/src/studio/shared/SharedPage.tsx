import { PAGE_SLUG, pageSlugOf, type SpacePage } from "@engenty/wizards-shared/spaces";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Copy, QrCode as QrIcon } from "lucide-react";
import { useState } from "react";
import { Mascot } from "../../brand";
import { api } from "../../lib/api";
import { lang as studioLang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { type Space, useCurrentSpace, useMe, type WizardSummary } from "../../lib/session";
import { Button, Card, cn, Dialog, IconButton, Input, Label, Switch } from "../../ui";
import { useCrumbs } from "../AppFrame";
import { Pills } from "../editor/PreviewPane";
import { QrCode } from "../editor/WizardQr";
import { PageFrame, SlugField, useCopied, WordsFields } from "../space/PublicPage";
import { langOfVoice, pageUrl } from "../space/page-address";
import { ownLink } from "../where";

/*
 * Shared (docs/plans/org-page.md): what leaves the team, for the organization's admins. Off,
 * it says what the page is for and sets it up; wizards already shared by their own link are
 * listed all the same. On, the page itself stands beside a panel with what is on it and its
 * settings. The page is the space's whose page is on, else the organization's own space; its
 * order and layout are fixed for now.
 */

type Tab = "content" | "settings";

const hint = "text-[0.8125rem] text-ink-3 leading-snug";

/** The space the page belongs to: the one with its page on, else the organization's own. */
function usePageSpace(): { space: Space | null; spaces: Space[] } {
  const { space, spaces } = useCurrentSpace();
  const on = spaces.find((s) => s.page?.on);
  return { space: on ?? spaces.find((s) => s.root) ?? space, spaces };
}

/** The wizards of the organization's spaces, by space; client spaces stay out. */
function useAllWizards(spaces: Space[]) {
  const shown = spaces.filter((s) => s.kind !== "client");
  const results = useQueries({
    queries: shown.map((s) => ({
      queryKey: keys.spaceWizards(s.id),
      queryFn: () => api.get<WizardSummary[]>(`/api/studio/spaces/${s.id}/wizards`),
    })),
  });
  return results.flatMap((r) => r.data ?? []);
}

export function SharedPage() {
  useCrumbs([{ label: t("mode.shared") }]);
  const me = useMe().data;
  const { space, spaces } = usePageSpace();
  const wizards = useAllWizards(spaces);
  const linked = wizards.filter((w) => w.published && w.shareEnabled);
  const [setup, setSetup] = useState(false);
  const host = me?.tenant.pagesHost ?? null;
  if (!space) {
    return null;
  }
  if (!host) {
    return <p className="py-24 text-center text-[0.9375rem] text-ink-3">{t("page.cloudOnly")}</p>;
  }
  const page = space.page;
  if (page?.on) {
    return <PageOn space={space} page={page} host={host} wizards={wizards} linked={linked} />;
  }
  const dialog = (
    <SetupDialog
      open={setup}
      onClose={() => setSetup(false)}
      space={space}
      host={host}
      wizards={wizards.filter((w) => w.spaceId === space.id)}
    />
  );
  // Nothing out yet: one message, one button. Wizards out by link: the same, compact, above them.
  if (!linked.length) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-6 py-16">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <Mascot kind="round" size={72} interactive={false} />
          <h1 className="font-display font-semibold text-[1.375rem] leading-tight">
            {t("shared.emptyTitle")}
          </h1>
          <p className="text-[0.9375rem] text-ink-2">{t("shared.emptyText")}</p>
          <Button className="mt-1" onClick={() => setSetup(true)}>
            {t("shared.setUp")}
          </Button>
        </div>
        {dialog}
      </div>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <Mascot kind="round" size={44} interactive={false} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display font-semibold text-[1.0625rem] leading-tight">
            {t("shared.emptyTitle")}
          </h1>
          <p className="mt-1 text-[0.875rem] text-ink-2">{t("shared.emptyText")}</p>
        </div>
        <Button onClick={() => setSetup(true)}>{t("shared.setUp")}</Button>
      </Card>
      <section className="flex flex-col gap-2">
        <h2 className="px-1 font-medium text-[0.8125rem] text-ink-3">{t("shared.byLink")}</h2>
        <Card className="divide-y divide-border-soft px-4">
          {linked.map((w) => (
            <LinkRow key={w.id} wizard={w} />
          ))}
        </Card>
      </section>
      {dialog}
    </div>
  );
}

/** A wizard out by its own link: its link, to copy, show as a QR code or open. */
function LinkRow({ wizard, compact }: { wizard: WizardSummary; compact?: boolean }) {
  const link = ownLink(wizard);
  const { copied, copy } = useCopied();
  const [qr, setQr] = useState(false);
  return (
    <div className="flex items-center gap-3 py-3">
      {compact ? null : (
        <Mascot kind={wizard.avatar} costume={wizard.costume} size={32} interactive={false} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[0.875rem]">{wizard.title}</div>
        <div className="truncate font-mono text-[0.75rem] text-ink-3">
          {link.replace(/^https?:\/\//, "")}
        </div>
      </div>
      <IconButton label={t("shared.copyLink")} onClick={() => copy(link)}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </IconButton>
      <IconButton label={t("shared.qr")} onClick={() => setQr(true)}>
        <QrIcon className="size-4" />
      </IconButton>
      <Dialog open={qr} onClose={() => setQr(false)} title={wizard.title}>
        <div className="flex flex-col items-center gap-3">
          <QrCode
            text={link}
            label={t("shared.qrFor", { name: wizard.title })}
            className="size-56"
          />
          <p className={cn(hint, "break-all text-center font-mono")}>{link}</p>
        </div>
      </Dialog>
    </div>
  );
}

/** Name and address, then the page goes on with the space's shared wizards on it. */
function SetupDialog({
  open,
  onClose,
  space,
  host,
  wizards,
}: {
  open: boolean;
  onClose: () => void;
  space: Space;
  host: string;
  wizards: WizardSummary[];
}) {
  const qc = useQueryClient();
  const organization = useMe().data?.tenant.name ?? "";
  // The organization's own space is named after the organization, not by its stored name.
  const name0 =
    space.page?.title ||
    space.brand.name?.trim() ||
    (space.root && organization ? organization : space.name);
  const [title, setTitle] = useState(name0);
  const [slug, setSlug] = useState(space.page?.slug || pageSlugOf(name0) || "page");
  const turnOn = useMutation({
    mutationFn: () => {
      const page: SpacePage = space.page
        ? { ...space.page, on: true, title: title.trim(), slug }
        : {
            on: true,
            slug,
            title: title.trim(),
            ...langOfVoice(studioLang === "de" ? "de-du" : "en"),
            wizards: wizards.filter((w) => w.published && w.shareEnabled).map((w) => w.id),
            examples: {},
          };
      return api.patch(`/api/studio/spaces/${space.id}`, { page });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.spaces() });
      onClose();
    },
  });
  const ok = Boolean(title.trim()) && PAGE_SLUG.test(slug);
  return (
    <Dialog open={open} onClose={onClose} title={t("shared.setUp")}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) {
            turnOn.mutate();
          }
        }}
      >
        <div>
          <Label>{t("page.title")}</Label>
          <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label>{t("page.address")}</Label>
          <SlugField host={host} value={slug} onChange={setSlug} />
        </div>
        {turnOn.error ? (
          <p className="text-[0.8125rem] text-rose">{(turnOn.error as Error).message}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={turnOn.isPending} disabled={!ok}>
            {t("shared.turnOn")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The page is on: the panel with what is on it and its settings, the page itself beside it. */
function PageOn({
  space,
  page,
  host,
  wizards,
  linked,
}: {
  space: Space;
  page: SpacePage;
  host: string;
  wizards: WizardSummary[];
  linked: WizardSummary[];
}) {
  const qc = useQueryClient();
  const manageUrl = useMe().data?.manageUrl ?? null;
  const [tab, setTab] = useState<Tab>("content");
  const [version, setVersion] = useState(1);
  const save = async (next: SpacePage) => {
    await api.patch(`/api/studio/spaces/${space.id}`, { page: next });
    await qc.invalidateQueries({ queryKey: keys.spaces() });
    setVersion((v) => v + 1);
  };
  const change = useMutation({
    mutationFn: (patch: Partial<SpacePage>) => save({ ...page, ...patch }),
  });
  const own = wizards.filter((w) => w.spaceId === space.id);
  const url = pageUrl(host, page.slug, manageUrl);
  const toggle = (id: string, show: boolean) =>
    change.mutate({
      wizards: show ? [...page.wizards, id] : page.wizards.filter((x) => x !== id),
    });
  const shown = own.filter((w) => w.published && w.shareEnabled);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 md:grid-cols-[17rem_minmax(0,1fr)]">
      <Card className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3">
        <Pills
          named
          label={t("mode.shared")}
          value={tab}
          onChange={setTab}
          options={[
            { id: "content", label: t("shared.content") },
            { id: "settings", label: t("shared.settings") },
          ]}
        />
        {tab === "content" ? (
          <>
            <section className="flex flex-col">
              <h2 className="px-1 pb-1 font-medium text-[0.75rem] text-ink-3">
                {t("shared.onPage")}
              </h2>
              {shown.length ? (
                shown.map((w) => (
                  <div
                    key={w.id}
                    className="flex items-center gap-2 border-border-soft border-b px-1 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-[0.875rem]">{w.title}</span>
                    <Switch
                      checked={page.wizards.includes(w.id)}
                      disabled={change.isPending}
                      label={w.title}
                      onChange={(on) => toggle(w.id, on)}
                    />
                  </div>
                ))
              ) : (
                <p className={cn(hint, "px-1")}>{t("shared.noneToShow")}</p>
              )}
              {page.wizards.length === 0 && shown.length ? (
                <p className={cn(hint, "px-1 pt-2")}>{t("shared.pickOne")}</p>
              ) : null}
            </section>
            {linked.length ? (
              <section className="flex flex-col">
                <h2 className="px-1 font-medium text-[0.75rem] text-ink-3">{t("shared.byLink")}</h2>
                <div className="divide-y divide-border-soft px-1">
                  {linked.map((w) => (
                    <LinkRow key={w.id} wizard={w} compact />
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : (
          <div className="flex flex-1 flex-col gap-5">
            <WordsFields host={host} page={page} disabled={false} save={save} onState={() => {}} />
            <Button
              variant="ghost"
              className="mt-auto self-start text-rose"
              busy={change.isPending}
              onClick={() => change.mutate({ on: false })}
            >
              {t("shared.turnOff")}
            </Button>
          </div>
        )}
      </Card>
      <Card className="flex min-h-[60vh] min-w-0 flex-col gap-2 p-3">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 self-end font-mono text-[0.75rem] text-ink-3 hover:text-ink"
        >
          {url.replace(/^https?:\/\//, "")}
          <ArrowUpRight className="size-3.5" />
        </a>
        <PageFrame url={url} version={version} device="desktop" />
      </Card>
    </div>
  );
}
