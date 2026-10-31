import {
  type AssetSection,
  type BrandColor,
  type BrandFont,
  type BrandGradient,
  type BrandLink,
  type BrandPattern,
  type BrandRule,
  type ColorSection,
  type LogoSection,
  mainLogo,
  type SpaceFact,
  type SpaceFileView,
  type TextStyle,
  type VoiceBlock,
} from "@engenty/wizards-shared/spaces";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImagePlus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { type Space, useIsAdmin, useManySpaces, useMe } from "../../lib/session";
import { Button, cn, Dialog, Input, Label, Switch, Textarea } from "../../ui";
import { useAssistantPage } from "../assistant/page";
import { AssistantSlot } from "../assistant/StudioAssistant";
import { ReadOnlyNote, spaceReadOnlyText } from "../ReadOnly";
import { Assets } from "./Assets";
import { Colors } from "./Colors";
import { useAutosave, useSpaceFiles } from "./data";
import { Facts } from "./Facts";
import { Preview } from "./Files";
import { Links } from "./Links";
import { Logos } from "./Logos";
import { Anchor, Section } from "./Section";
import { Typography } from "./Typography";
import { Voice } from "./Voice";

type Patch = {
  name?: string;
  brand?: {
    name?: string;
    about?: string;
    brandName?: string;
    tagline?: string;
    voice?: VoiceBlock[];
    voiceRules?: BrandRule[];
    links?: BrandLink[];
    colors?: BrandColor[];
    colorSections?: ColorSection[];
    gradients?: BrandGradient[];
    patterns?: BrandPattern[];
    colorRules?: BrandRule[];
    logoSections?: LogoSection[];
    assetSections?: AssetSection[];
    fonts?: BrandFont[];
    textStyles?: TextStyle[];
    typeRules?: BrandRule[];
    logoRules?: BrandRule[];
  };
  facts?: SpaceFact[];
  membersStudio?: boolean;
};

/**
 * The main logo beside the title, to see who the space is: it is changed in Brand, where a click
 * on it leads. Without one, the way there to add it.
 */
function LogoPeek({ spaceId, logo }: { spaceId: string; logo: SpaceFileView | undefined }) {
  const label = logo ? t("space.logoPeek") : t("space.logoPeekAdd");
  return (
    <div className="shrink-0">
      <Label>{t("space.logo")}</Label>
      <Link
        to={{ pathname: "/space/brand", hash: "logos" }}
        title={label}
        aria-label={label}
        className={cn(
          "grid size-[4.5rem] place-items-center overflow-hidden rounded-xl transition",
          logo
            ? "bg-card ring-1 ring-border-soft hover:ring-border"
            : "text-ink-4 ring-1 ring-border ring-dashed hover:text-ink-2",
        )}
      >
        {logo ? <Preview spaceId={spaceId} file={logo} small /> : <ImagePlus className="size-5" />}
      </Link>
    </div>
  );
}

/**
 * „Mitglieder dürfen ins Studio“: one rule for all the organization's members, set by its admins.
 * Behind `capabilities`; only admins of an organization see it.
 */
function MembersStudioRow({
  space,
  save,
}: {
  space: Space;
  save: (patch: Patch) => Promise<unknown>;
}) {
  const me = useMe().data;
  const admin = useIsAdmin();
  const shown = useFeature("capabilities") && admin && me?.mode === "managed";
  const [open, setOpen] = useState(space.membersStudio);
  if (!shown) {
    return null;
  }
  return (
    <div className="flex items-start gap-3 border-border-soft border-t pt-5">
      <div className="min-w-0 flex-1">
        <span className="font-medium text-[0.875rem]">{t("space.membersStudio")}</span>
        <p className="mt-0.5 text-[0.8125rem] text-ink-3">{t("space.membersStudioHint")}</p>
      </div>
      <Switch
        checked={open}
        disabled={space.readOnly}
        label={t("space.membersStudio")}
        onChange={(on) => {
          setOpen(on);
          save({ membersStudio: on }).catch(() => setOpen(!on));
        }}
      />
    </div>
  );
}

/** Marke › Name und Claim: the brand's name as it is written and its tagline, saved as typed. */
function Identity({ space, save }: { space: Space; save: (patch: Patch) => Promise<unknown> }) {
  const [brandName, setBrandName] = useState(space.brand.brandName ?? "");
  const [tagline, setTagline] = useState(space.brand.tagline ?? "");
  const status = useAutosave({ brandName: brandName.trim(), tagline: tagline.trim() }, (brand) =>
    save({ brand }),
  );
  return (
    <Section
      title={t("space.identity")}
      hint={t("space.identityHint")}
      save={status}
      locked={space.readOnly}
    >
      {/* One field per row, label beside its value, as the facts stand. */}
      <div className="flex flex-col gap-4">
        {[
          {
            id: "brand-name",
            label: t("space.brandName"),
            hint: t("space.brandNameHint"),
            field: (
              <Input
                id="brand-name"
                value={brandName}
                maxLength={120}
                placeholder={space.brand.name ?? ""}
                onChange={(e) => setBrandName(e.target.value)}
              />
            ),
          },
          {
            id: "brand-tagline",
            label: t("space.tagline"),
            hint: t("space.taglineHint"),
            field: (
              <Input
                id="brand-tagline"
                value={tagline}
                maxLength={200}
                onChange={(e) => setTagline(e.target.value)}
              />
            ),
          },
        ].map((row) => (
          <div
            key={row.id}
            className="grid items-start gap-x-2 gap-y-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          >
            <label
              htmlFor={row.id}
              className="font-medium text-[0.9375rem] sm:flex sm:h-11 sm:items-center"
            >
              {row.label}
            </label>
            <div>
              {row.field}
              <p className="mt-1.5 text-[0.8125rem] text-ink-3">{row.hint}</p>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Base({
  space,
  logo,
  save,
}: {
  space: Space;
  logo: SpaceFileView | undefined;
  save: (patch: Patch) => Promise<unknown>;
}) {
  const [title, setTitle] = useState(space.brand.name ?? "");
  const [about, setAbout] = useState(space.brand.about ?? "");
  const status = useAutosave({ name: title.trim(), about: about.trim() }, (brand) =>
    save({ brand }),
  );
  return (
    <Section
      title={t("space.base")}
      hint={t("space.baseHint")}
      save={status}
      locked={space.readOnly}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <Label>{t("space.title")}</Label>
            <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            <p className="mt-1.5 text-[0.8125rem] text-ink-3">{t("space.titleHint")}</p>
          </div>
          <LogoPeek spaceId={space.id} logo={logo} />
        </div>
        <div>
          <Label>{t("space.about")}</Label>
          <Textarea minRows={4} value={about} onChange={(e) => setAbout(e.target.value)} />
          <p className="mt-1.5 text-[0.8125rem] text-ink-3">{t("space.aboutHint")}</p>
        </div>
        <MembersStudioRow space={space} save={save} />
      </div>
    </Section>
  );
}

/**
 * What a space gives all its wizards, in three parts of the space page: `info` — who it is and
 * its facts, with its main logo to see —, `brand` — its logos, colours, type and assets — and
 * `knowledge` — Knowledge, drawn by the caller as `children`. Every section saves by itself; the studio's assistant fills them in from a
 * description, a website or files, and this tells it what to say here. A read-only space (a
 * local install's, or on a server where nothing is built) shows the same sections with a note.
 * `children`: the sections plugins add to the part, after its own.
 */
export function SpaceSettings({
  space,
  group,
  top = false,
  children,
}: {
  space: Space;
  group: "info" | "brand" | "knowledge";
  /** Goose's chat stands at the top of the part: not on an item of Knowledge, opened on its own. */
  top?: boolean;
  children?: ReactNode;
}) {
  const qc = useQueryClient();
  const files = useSpaceFiles(space.id);
  const [rev, setRev] = useState(0);
  const [asking, setAsking] = useState(false);
  const save = async (patch: Patch) => {
    await api.patch(`/api/studio/spaces/${space.id}`, patch);
    await qc.invalidateQueries({ queryKey: keys.spaces() });
  };
  const remove = useMutation({
    mutationFn: () => api.del(`/api/studio/spaces/${space.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.spaces() }),
  });
  // With one space there is nothing to switch, to name apart or to delete; a member deletes none.
  const many = useManySpaces();
  const admin = useIsAdmin();
  const data = files.data ?? { files: [], embeddings: true };
  const key = `${space.id}:${rev}`;
  const readOnly = space.readOnly;
  const knowledge = group === "knowledge";
  // Parts of the brand that wait behind their switches.
  const sectioned = useFeature("brandSections");
  const ruled = useFeature("brandRules");
  const typography = useFeature("typography");
  useAssistantPage(
    readOnly
      ? {}
      : {
          title: knowledge ? t("space.assistantTitleKnowledge") : t("space.assistantTitle"),
          hello: knowledge ? t("space.assistantHelloKnowledge") : t("space.assistantHello"),
          about: knowledge ? t("space.assistantAboutKnowledge") : t("space.assistantAbout"),
          placeholder: knowledge
            ? t("space.assistantComposerKnowledge")
            : t("space.assistantComposer"),
          suggestions: knowledge
            ? [
                { label: t("assistant.suggest.knowledgeHow") },
                { label: t("assistant.suggest.knowledgeSite"), fill: true },
                { label: t("assistant.suggest.knowledgeCategories") },
              ]
            : [
                { label: t("assistant.suggest.readSite"), fill: true },
                { label: t("assistant.suggest.missing") },
                ...(group === "info" ? [{ label: t("assistant.suggest.facts") }] : []),
              ],
          summary: knowledge
            ? undefined
            : [
                space.brand.name ? `title "${space.brand.name}"` : "no title",
                `${space.facts.length} facts`,
                `${space.brand.colors?.length ?? 0} colours`,
                `${data.files.filter((f) => f.kind === "logo").length} logos`,
              ].join(" · "),
          // What the assistant wrote is shown by mounting the sections again with the new space.
          onChanged: () => setRev((n) => n + 1),
        },
  );
  return (
    <div className="flex flex-col gap-9">
      {readOnly ? (
        <ReadOnlyNote>{spaceReadOnlyText(space)}</ReadOnlyNote>
      ) : top ? (
        <AssistantSlot />
      ) : null}
      {group === "info" ? (
        <>
          <Anchor id="base">
            <Base
              key={`base:${key}`}
              space={space}
              logo={mainLogo(
                data.files.filter((f) => f.kind === "logo"),
                space.brand.logoSections,
              )}
              save={save}
            />
          </Anchor>
          <Anchor id="facts">
            <Facts
              key={`facts:${key}`}
              facts={space.facts}
              save={(facts) => save({ facts })}
              readOnly={readOnly}
            />
          </Anchor>
          <Anchor id="links">
            <Links
              key={`links:${key}`}
              links={space.brand.links ?? []}
              save={(links) => save({ brand: { links } })}
              readOnly={readOnly}
            />
          </Anchor>
        </>
      ) : null}
      {group === "brand" ? (
        <>
          <Anchor id="identity">
            <Identity key={`identity:${key}`} space={space} save={save} />
          </Anchor>
          <Anchor id="voice">
            <Voice
              key={`voice:${key}`}
              blocks={space.brand.voice ?? []}
              rules={space.brand.voiceRules ?? []}
              ruled={ruled}
              save={(brand) => save({ brand })}
              readOnly={readOnly}
            />
          </Anchor>
          <Anchor id="logos">
            <Logos
              key={`logos:${key}`}
              spaceId={space.id}
              data={data}
              readOnly={readOnly}
              sections={space.brand.logoSections ?? []}
              rules={space.brand.logoRules ?? []}
              sectioned={sectioned}
              ruled={ruled}
              save={(brand) => save({ brand })}
            />
          </Anchor>
          <Anchor id="colors">
            <Colors
              key={`colors:${key}`}
              spaceId={space.id}
              data={data}
              colors={space.brand.colors ?? []}
              sections={space.brand.colorSections ?? []}
              gradients={space.brand.gradients ?? []}
              patterns={space.brand.patterns ?? []}
              rules={space.brand.colorRules ?? []}
              sectioned={sectioned}
              ruled={ruled}
              save={(brand) => save({ brand })}
              readOnly={readOnly}
            />
          </Anchor>
          {typography ? (
            <Anchor id="typography">
              <Typography
                key={`typography:${key}`}
                spaceId={space.id}
                fonts={space.brand.fonts ?? []}
                styles={space.brand.textStyles ?? []}
                rules={space.brand.typeRules ?? []}
                ruled={ruled}
                sample={space.brand.name || t("space.typeSample")}
                save={(brand) => save({ brand })}
                readOnly={readOnly}
              />
            </Anchor>
          ) : null}
          <Anchor id="assets">
            <Assets
              key={`assets:${key}`}
              spaceId={space.id}
              data={data}
              readOnly={readOnly}
              sections={space.brand.assetSections ?? []}
              save={(brand) => save({ brand })}
            />
          </Anchor>
        </>
      ) : null}
      {children}
      {group === "info" && many && !readOnly && admin ? (
        <div>
          <Button variant="danger" onClick={() => setAsking(true)}>
            {t("settings.delete")}
          </Button>
          <Dialog
            open={asking}
            onClose={() => setAsking(false)}
            title={t("settings.deleteTitle", { name: space.name })}
          >
            <p className="-mt-2 text-[0.875rem] text-ink-2">{t("settings.deleteBody")}</p>
            {remove.error ? (
              <p className="mt-3 text-[0.8125rem] text-rose">{(remove.error as Error).message}</p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsking(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
                {t("common.delete")}
              </Button>
            </div>
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}
