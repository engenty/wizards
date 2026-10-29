import type { SpacePage, SpaceTable, SpaceTableRow } from "@engenty/wizards-shared/space-data";
import type { SpaceFileView } from "@engenty/wizards-shared/spaces";
import { keys } from "../../lib/keys";
import { isNewer, type LiveBinding, liveEditor, putDetail, upsert, without } from "../live/patch";
import type { SpaceFiles } from "./data";

/** Knowledge and data of a space, live: pages, tables and their rows, categories, files. */
export const knowledgeLive: LiveBinding[] = [
  {
    id: "pages",
    kinds: ["page"],
    patch: async (c, { qc, invalidate, flash }) => {
      const key = keys.page(c.item);
      const cached = qc.getQueryData<SpacePage>(key);
      if (c.op === "del") {
        qc.removeQueries({ queryKey: key, exact: true });
      } else {
        const view = c.view as SpacePage;
        const editor = liveEditor("page", c.item);
        if (editor) {
          editor(c);
        } else {
          await putDetail<SpacePage>(qc, key, (old) => (isNewer(old, view) ? view : old));
        }
        // The tree shows titles and places, not the text.
        if (cached && cached.title === view.title) {
          return;
        }
      }
      flash(c.item);
      invalidate(keys.knowledge(c.spaceId ?? undefined));
      invalidate(keys.spaceData(c.spaceId ?? undefined));
    },
    fallback: (c) => [
      keys.page(c.item),
      keys.knowledge(c.spaceId ?? undefined),
      keys.spaceData(c.spaceId ?? undefined),
    ],
  },
  {
    id: "tables",
    kinds: ["table"],
    patch: async (c, { qc, invalidate }) => {
      const key = keys.table(c.item);
      const cached = qc.getQueryData<SpaceTable>(key);
      if (c.op === "del") {
        qc.removeQueries({ queryKey: key, exact: true });
      } else {
        const header = c.view as Omit<SpaceTable, "rows">;
        await putDetail<SpaceTable>(qc, key, (old) => (old ? { ...header, rows: old.rows } : old));
        if (cached && cached.title === header.title) {
          return;
        }
      }
      invalidate(keys.knowledge(c.spaceId ?? undefined));
      invalidate(keys.spaceData(c.spaceId ?? undefined));
    },
    fallback: (c) => [
      keys.table(c.item),
      keys.knowledge(c.spaceId ?? undefined),
      keys.spaceData(c.spaceId ?? undefined),
    ],
  },
  {
    id: "rows",
    kinds: ["row"],
    patch: async (c, { qc, invalidate, flash }) => {
      if (!c.parent) {
        return;
      }
      const key = keys.table(c.parent);
      const row = c.view as (SpaceTableRow & { tableId: string }) | undefined;
      await putDetail<SpaceTable>(qc, key, (old) => {
        if (!old) {
          return old;
        }
        if (c.op === "del" || !row) {
          const rows = without(old.rows, c.item);
          return rows ? { ...old, rows } : old;
        }
        const { tableId: _, ...cells } = row;
        const rows = upsert(old.rows, cells, "last");
        return rows ? { ...old, rows } : old;
      });
      if (c.op === "put") {
        flash(c.item);
      }
      // Row counts.
      invalidate(keys.spaceData(c.spaceId ?? undefined));
    },
    fallback: (c) => [
      ...(c.parent ? [keys.table(c.parent)] : []),
      keys.spaceData(c.spaceId ?? undefined),
    ],
  },
  {
    id: "categories",
    kinds: ["category"],
    // A category's values show in computed views only: those are fetched again.
    patch: (c, { invalidate }) => {
      invalidate(keys.knowledge(c.spaceId ?? undefined));
      invalidate(keys.knowledgeValues());
    },
    fallback: (c) => [keys.knowledge(c.spaceId ?? undefined), keys.knowledgeValues()],
  },
  {
    id: "files",
    kinds: ["file"],
    patch: (c, { qc, invalidate, flash }) => {
      if (!c.spaceId) {
        return;
      }
      const key = keys.files(c.spaceId);
      const cached = qc.getQueryData<SpaceFiles>(key);
      if (cached) {
        const files =
          c.op === "del"
            ? without(cached.files, c.item)
            : upsert(cached.files, c.view as SpaceFileView, "first");
        if (files) {
          qc.setQueryData<SpaceFiles>(key, { ...cached, files });
        }
      }
      if (c.op === "put") {
        flash(c.item);
      }
      invalidate(keys.fileText(c.item));
      invalidate(keys.knowledge(c.spaceId));
    },
    fallback: (c) => [
      ...(c.spaceId ? [keys.files(c.spaceId), keys.knowledge(c.spaceId)] : []),
      keys.fileText(c.item),
    ],
  },
];

/** Skills: the list and an opened skill are fetched again; a skill has no view of its own. */
export const skillsLive: LiveBinding[] = [
  {
    id: "skills",
    kinds: ["skill"],
    patch: (c, { invalidate, flash }) => {
      flash(c.item);
      invalidate(keys.skills(c.spaceId ?? undefined));
      invalidate(keys.skill(c.item));
    },
    fallback: (c) => [keys.skills(c.spaceId ?? undefined), keys.skill(c.item)],
  },
];
