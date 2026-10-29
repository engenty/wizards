import type { ProjectFileView } from "@engenty/wizards-shared/projects";
import type { SpacePage, SpaceTable, SpaceTableRow } from "@engenty/wizards-shared/space-data";
import { keys } from "../../lib/keys";
import { isNewer, type LiveBinding, liveEditor, putDetail, upsert, without } from "../live/patch";
import type { ProjectFiles } from "./data";

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
      invalidate(keys.knowledge(c.projectId ?? undefined));
      invalidate(keys.spaceData(c.projectId ?? undefined));
    },
    fallback: (c) => [
      keys.page(c.item),
      keys.knowledge(c.projectId ?? undefined),
      keys.spaceData(c.projectId ?? undefined),
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
      invalidate(keys.knowledge(c.projectId ?? undefined));
      invalidate(keys.spaceData(c.projectId ?? undefined));
    },
    fallback: (c) => [
      keys.table(c.item),
      keys.knowledge(c.projectId ?? undefined),
      keys.spaceData(c.projectId ?? undefined),
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
      invalidate(keys.spaceData(c.projectId ?? undefined));
    },
    fallback: (c) => [
      ...(c.parent ? [keys.table(c.parent)] : []),
      keys.spaceData(c.projectId ?? undefined),
    ],
  },
  {
    id: "categories",
    kinds: ["category"],
    // A category's values show in computed views only: those are fetched again.
    patch: (c, { invalidate }) => {
      invalidate(keys.knowledge(c.projectId ?? undefined));
      invalidate(keys.knowledgeValues());
    },
    fallback: (c) => [keys.knowledge(c.projectId ?? undefined), keys.knowledgeValues()],
  },
  {
    id: "files",
    kinds: ["file"],
    patch: (c, { qc, invalidate, flash }) => {
      if (!c.projectId) {
        return;
      }
      const key = keys.files(c.projectId);
      const cached = qc.getQueryData<ProjectFiles>(key);
      if (cached) {
        const files =
          c.op === "del"
            ? without(cached.files, c.item)
            : upsert(cached.files, c.view as ProjectFileView, "first");
        if (files) {
          qc.setQueryData<ProjectFiles>(key, { ...cached, files });
        }
      }
      if (c.op === "put") {
        flash(c.item);
      }
      invalidate(keys.fileText(c.item));
      invalidate(keys.knowledge(c.projectId));
    },
    fallback: (c) => [
      ...(c.projectId ? [keys.files(c.projectId), keys.knowledge(c.projectId)] : []),
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
      invalidate(keys.skills(c.projectId ?? undefined));
      invalidate(keys.skill(c.item));
    },
    fallback: (c) => [keys.skills(c.projectId ?? undefined), keys.skill(c.item)],
  },
];
