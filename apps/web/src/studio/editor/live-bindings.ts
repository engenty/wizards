import { keys } from "../../lib/keys";
import type { WizardDetail, WizardSummary } from "../../lib/session";
import {
  isNewer,
  type LiveBinding,
  liveEditor,
  patchLists,
  putDetail,
  upsert,
  without,
} from "../live/patch";

/** What a wizard's change carries: its card, and what its editor opens. */
interface WizardView {
  summary: WizardSummary;
  detail: WizardDetail;
}

/** A query someone looks at right now. */
const shown = (qc: Parameters<LiveBinding["patch"]>[1]["qc"], key: readonly unknown[]) =>
  (qc.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount() ?? 0) > 0;

/** Wizards, live: the cards of a space, the editor, translations and the build chat. */
export const wizardLive: LiveBinding[] = [
  {
    id: "wizards",
    kinds: ["wizard"],
    patch: async (c, { qc, flash }) => {
      const lists = [keys.wizards(c.spaceId ?? undefined), keys.spaceWizards(c.spaceId ?? "")];
      if (c.op === "del") {
        for (const key of lists) {
          patchLists<WizardSummary>(qc, key, (list) => without(list, c.item));
        }
        return;
      }
      const view = c.view as WizardView;
      for (const key of lists) {
        // The cards list the newest first: a new wizard goes on top.
        patchLists<WizardSummary>(qc, key, (list) =>
          upsert(list, { ...list.find((w) => w.id === c.item), ...view.summary }, "first"),
        );
      }
      flash(c.item);
      const editor = liveEditor("wizard", c.item);
      if (editor) {
        editor(c);
      } else if (!shown(qc, keys.wizard(c.item))) {
        // An open editor keeps its own draft (useLiveDraft) until it takes live changes.
        await putDetail<WizardDetail>(qc, keys.wizard(c.item), (old) =>
          isNewer(old, view.detail) ? view.detail : old,
        );
      }
    },
    fallback: (c) => [keys.wizards(c.spaceId ?? undefined), keys.spaceWizards(c.spaceId ?? "")],
  },
  {
    id: "translations",
    kinds: ["translation"],
    patch: (c, { qc }) => {
      if (c.parent && c.view) {
        qc.setQueryData(keys.translations(c.parent), c.view);
      }
    },
    fallback: (c) => (c.parent ? [keys.translations(c.parent)] : []),
  },
  {
    id: "messages",
    kinds: ["message"],
    patch: () => undefined,
    // The build chat is part of the editor's wizard; an open editor has the chat's own stream.
    fallback: () => [],
  },
];
