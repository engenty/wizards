import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Globe, Puzzle, Wand2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { type Me, useMe, type WizardSummary } from "../../lib/session";
import type { EffortChoice, PlusItem } from "../../ui/composer";
import { openExternal } from "../LocalRuntime";
import { ownLink, sharedLink, whereItRuns } from "../where";
import { useTurnModels } from "./chats";

/**
 * What a person chooses in Work's composer for the questions they ask the space's AI, on Work's
 * start page and in a chat: the model (everyday or extra effort), web search, and the plugins
 * whose tools the AI may use. The + menu also leads to the space's files and to its wizards.
 */

export interface TurnChoice {
  extra: boolean;
  web: boolean;
  /** Plugins whose tools stay out of the turn. */
  pluginsOff: string[];
}

export const EVERYDAY: TurnChoice = { extra: false, web: true, pluginsOff: [] };

/** What a question sends of the choice: only what differs from everyday work. */
export type ChoiceBody = { extra?: true; web?: false; pluginsOff?: string[] };

export function choiceBody(choice: TurnChoice): ChoiceBody {
  return {
    ...(choice.extra ? { extra: true } : {}),
    ...(choice.web ? {} : { web: false }),
    ...(choice.pluginsOff.length ? { pluginsOff: choice.pluginsOff } : {}),
  };
}

/** Where a published wizard opens: in its own chat (the chat runner), where it runs. */
export function wizardChatLink(w: WizardSummary, me: Me): string {
  return `${sharedLink(whereItRuns(w, me, w.cloud)) ?? ownLink(w)}/chat`;
}

/** The space's published wizards, the ones changed last first: the same list as the start page's. */
export function usePublishedWizards(spaceId: string | undefined) {
  const me = useMe().data;
  return (
    useQuery({
      queryKey: ["wizards", spaceId, Boolean(me?.account)],
      queryFn: () => api.get<WizardSummary[]>(`/api/studio/spaces/${spaceId}/wizards`),
      enabled: Boolean(spaceId),
    }).data ?? []
  )
    .filter((w) => w.published)
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
}

/**
 * The composer's choices for a space: the model chooser, the + menu's groups, and the body a
 * question sends. `start`: the choice handed over from Work's start page with a new chat.
 */
export function useTurnChoices(
  spaceId: string | undefined,
  openSpaceFiles: () => void,
  start: TurnChoice = EVERYDAY,
): { body: ChoiceBody; choice: TurnChoice; chooser: EffortChoice; plus: PlusItem[][] } {
  const me = useMe().data;
  const [choice, setChoice] = useState(start);
  const models = useTurnModels();
  const offered = useQuery({
    queryKey: ["work-composer"],
    queryFn: () =>
      api.get<{ web: boolean; plugins: { id: string; name: string }[] }>(
        "/api/studio/work/composer",
      ),
  }).data;
  const wizards = usePublishedWizards(spaceId);
  const plugins = offered?.plugins ?? [];
  const change = (patch: Partial<TurnChoice>) => setChoice((c) => ({ ...c, ...patch }));
  const plus: PlusItem[][] = [
    [{ icon: <FolderOpen />, label: t("work.files.fromSpace"), onSelect: openSpaceFiles }],
    [
      ...(plugins.length
        ? [
            {
              kind: "menu" as const,
              icon: <Puzzle />,
              label: t("work.composer.plugins"),
              choices: plugins.map((p) => ({
                id: p.id,
                label: p.name,
                on: !choice.pluginsOff.includes(p.id),
                onSelect: () =>
                  change({
                    pluginsOff: choice.pluginsOff.includes(p.id)
                      ? choice.pluginsOff.filter((id) => id !== p.id)
                      : [...choice.pluginsOff, p.id],
                  }),
              })),
            },
          ]
        : []),
      ...(wizards.length && me
        ? [
            {
              kind: "menu" as const,
              icon: <Wand2 />,
              label: t("work.home.wizards"),
              choices: wizards.map((w) => ({
                id: w.id,
                label: w.title,
                hint: t("work.home.wizardOpen"),
                onSelect: () => openExternal(wizardChatLink(w, me)),
              })),
            },
          ]
        : []),
    ],
    offered?.web
      ? [
          {
            kind: "toggle" as const,
            icon: <Globe />,
            label: t("work.composer.web"),
            on: choice.web,
            onChange: (web: boolean) => change({ web }),
          },
        ]
      : [],
  ];
  return {
    body: choiceBody({ ...choice, web: choice.web || !offered?.web }),
    choice,
    chooser: { on: choice.extra, onChange: (extra) => change({ extra }), ...models },
    plus,
  };
}
