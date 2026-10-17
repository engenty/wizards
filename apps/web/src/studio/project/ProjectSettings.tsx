import type {
  AssetSection,
  BrandColor,
  BrandFont,
  BrandGradient,
  BrandPattern,
  BrandRule,
  ColorSection,
  LogoSection,
  ProjectFact,
  TextStyle,
} from "@engenty-wizards/shared/projects";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { t } from "../../lib/i18n";
import { type Project, useIsAdmin, useManyProjects } from "../../lib/session";
import { Button, Dialog, Input, Label, Textarea } from "../../ui";
import { useAssistantPage } from "../assistant/page";
import { projectReadOnlyText, ReadOnlyNote } from "../ReadOnly";
import { Assets } from "./Assets";
import { Colors } from "./Colors";
import { useAutosave, useProjectFiles } from "./data";
import { Facts } from "./Facts";
import { Logos } from "./Logos";
import { Anchor, Section } from "./Section";
import { Typography } from "./Typography";

type Patch = {
  name?: string;
  brand?: {
    name?: string;
    about?: string;
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
  facts?: ProjectFact[];
};

function Base({ project, save }: { project: Project; save: (patch: Patch) => Promise<unknown> }) {
  const [title, setTitle] = useState(project.brand.name ?? "");
  const [about, setAbout] = useState(project.brand.about ?? "");
  const status = useAutosave({ name: title.trim(), about: about.trim() }, (brand) =>
    save({ brand }),
  );
  return (
    <Section
      title={t("project.base")}
      hint={t("project.baseHint")}
      save={status}
      locked={project.readOnly}
    >
      <div className="flex flex-col gap-5">
        <div>
          <Label>{t("project.title")}</Label>
          <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          <p className="mt-1.5 text-[0.8125rem] text-ink-3">{t("project.titleHint")}</p>
        </div>
        <div>
          <Label>{t("project.about")}</Label>
          <Textarea minRows={4} value={about} onChange={(e) => setAbout(e.target.value)} />
          <p className="mt-1.5 text-[0.8125rem] text-ink-3">{t("project.aboutHint")}</p>
        </div>
      </div>
    </Section>
  );
}

/**
 * What a project gives all its wizards, in two parts of the space page: `info` — who it is, its
 * logos and colours, assets and facts — and `knowledge` — Knowledge, drawn by the caller as
 * `children`. Every section saves by itself; the studio's assistant fills them in from a
 * description, a website or files, and this tells it what to say here. A read-only project (a
 * local install's, or on a server where nothing is built) shows the same sections with a note.
 * `children`: the sections plugins add to the part, after its own.
 */
export function ProjectSettings({
  project,
  group,
  children,
}: {
  project: Project;
  group: "info" | "knowledge";
  children?: ReactNode;
}) {
  const qc = useQueryClient();
  const files = useProjectFiles(project.id);
  const [rev, setRev] = useState(0);
  const [asking, setAsking] = useState(false);
  const save = async (patch: Patch) => {
    await api.patch(`/api/studio/projects/${project.id}`, patch);
    await qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const remove = useMutation({
    mutationFn: () => api.del(`/api/studio/projects/${project.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  // With one project there is nothing to switch, to name apart or to delete; a member deletes none.
  const many = useManyProjects();
  const admin = useIsAdmin();
  const data = files.data ?? { files: [], embeddings: true };
  const key = `${project.id}:${rev}`;
  const readOnly = project.readOnly;
  const knowledge = group === "knowledge";
  // Parts of the brand that wait behind their switches.
  const sectioned = useFeature("brandSections");
  const ruled = useFeature("brandRules");
  const typography = useFeature("typography");
  useAssistantPage(
    readOnly
      ? {}
      : {
          title: knowledge ? t("project.assistantTitleKnowledge") : t("project.assistantTitle"),
          hello: knowledge ? t("project.assistantHelloKnowledge") : t("project.assistantHello"),
          placeholder: knowledge
            ? t("project.assistantComposerKnowledge")
            : t("project.assistantComposer"),
          suggestions: knowledge
            ? [
                { label: t("assistant.suggest.knowledgeHow") },
                { label: t("assistant.suggest.knowledgeSite"), fill: true },
                { label: t("assistant.suggest.knowledgeCategories") },
              ]
            : [
                { label: t("assistant.suggest.readSite"), fill: true },
                { label: t("assistant.suggest.missing") },
                { label: t("assistant.suggest.facts") },
              ],
          summary: knowledge
            ? undefined
            : [
                project.brand.name ? `title "${project.brand.name}"` : "no title",
                `${project.facts.length} facts`,
                `${project.brand.colors?.length ?? 0} colours`,
                `${data.files.filter((f) => f.kind === "logo").length} logos`,
              ].join(" · "),
          // What the assistant wrote is shown by mounting the sections again with the new project.
          onChanged: () => setRev((n) => n + 1),
        },
  );
  return (
    <div className="flex flex-col gap-9">
      {readOnly ? <ReadOnlyNote>{projectReadOnlyText(project)}</ReadOnlyNote> : null}
      {group === "info" ? (
        <>
          <Anchor id="base">
            <Base key={`base:${key}`} project={project} save={save} />
          </Anchor>
          <Anchor id="facts">
            <Facts
              key={`facts:${key}`}
              facts={project.facts}
              save={(facts) => save({ facts })}
              readOnly={readOnly}
            />
          </Anchor>
          <Anchor id="logos">
            <Logos
              key={`logos:${key}`}
              projectId={project.id}
              data={data}
              readOnly={readOnly}
              sections={project.brand.logoSections ?? []}
              rules={project.brand.logoRules ?? []}
              sectioned={sectioned}
              ruled={ruled}
              save={(brand) => save({ brand })}
            />
          </Anchor>
          <Anchor id="colors">
            <Colors
              key={`colors:${key}`}
              projectId={project.id}
              data={data}
              colors={project.brand.colors ?? []}
              sections={project.brand.colorSections ?? []}
              gradients={project.brand.gradients ?? []}
              patterns={project.brand.patterns ?? []}
              rules={project.brand.colorRules ?? []}
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
                projectId={project.id}
                fonts={project.brand.fonts ?? []}
                styles={project.brand.textStyles ?? []}
                rules={project.brand.typeRules ?? []}
                ruled={ruled}
                sample={project.brand.name || t("project.typeSample")}
                save={(brand) => save({ brand })}
                readOnly={readOnly}
              />
            </Anchor>
          ) : null}
          <Anchor id="assets">
            <Assets
              key={`assets:${key}`}
              projectId={project.id}
              data={data}
              readOnly={readOnly}
              sections={project.brand.assetSections ?? []}
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
            title={t("settings.deleteTitle", { name: project.name })}
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
