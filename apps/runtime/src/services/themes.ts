import { runTheme } from "@engenty/wizards-shared/projects";
import {
  freeThemeId,
  MAX_SPACE_THEMES,
  type Theme,
  themeContentKey,
  themeIdProblem,
  themeSchema,
} from "@engenty/wizards-shared/theme";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { spaceChanged } from "../plugins/events.js";
import { requireBuild, requireWritable } from "./access.js";
import { ServiceError } from "./errors.js";
import { ownedProject } from "./projects.js";

/**
 * The space's themes, which of its wizards name each, the brand's fonts for headings and text
 * (what `brand` means in a theme of this space) and the brand's named colours.
 */
export async function listThemes(userId: string, projectId: string) {
  const p = await ownedProject(userId, projectId);
  const wizards = await db.query.wizard.findMany({
    columns: { id: true, title: true, draft: true },
    where: eq(schema.wizard.projectId, p.id),
  });
  const { display, body, faces } = runTheme(p.brand);
  return {
    themes: p.themes,
    brandFonts: { heading: display, text: body, faces },
    /** The brand's named colours: a theme's colour picker offers them first. */
    brandColors: (p.brand.colors ?? [])
      .filter((c) => !c.section)
      .map(({ name, value }) => ({ name, value })),
    usedBy: Object.fromEntries(
      p.themes.map((t) => [
        t.id,
        wizards
          .filter((w) => w.draft.themes?.includes(t.id))
          .map((w) => ({ id: w.id, title: w.title })),
      ]),
    ),
  };
}

function checkedTheme(raw: unknown, origin: "studio" | "import"): Theme {
  const parsed = themeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError("invalid", parsed.error.issues[0]?.message ?? "This is no theme.");
  }
  const problem = themeIdProblem(parsed.data.id);
  if (problem) {
    throw new ServiceError("invalid", problem);
  }
  // A scope says where a theme comes from: the catalog. The studio makes themes of the space.
  if (origin === "studio" && parsed.data.id.startsWith("@")) {
    throw new ServiceError("invalid", "A theme of the space has an id without a scope.");
  }
  return parsed.data;
}

async function writeThemes(projectId: string, themes: Theme[]) {
  if (themes.length > MAX_SPACE_THEMES) {
    throw new ServiceError("invalid", `A space keeps at most ${MAX_SPACE_THEMES} themes.`);
  }
  await db
    .update(schema.project)
    .set({ themes, updatedAt: new Date() })
    .where(eq(schema.project.id, projectId));
  spaceChanged("space.updated", projectId);
}

/** Adds the theme to the space, or replaces the one with its id. */
export async function saveTheme(userId: string, projectId: string, raw: unknown): Promise<Theme> {
  const p = await ownedProject(userId, projectId);
  await requireWritable(p);
  await requireBuild();
  const theme = checkedTheme(raw, "studio");
  const others = p.themes.filter((t) => t.id !== theme.id);
  await writeThemes(p.id, [...others, theme]);
  return theme;
}

/** Removes the theme. Wizards that name it show the next theme of their chain, or the brand. */
export async function deleteTheme(userId: string, projectId: string, themeId: string) {
  const p = await ownedProject(userId, projectId);
  await requireWritable(p);
  await requireBuild();
  await writeThemes(
    p.id,
    p.themes.filter((t) => t.id !== themeId),
  );
}

/**
 * Themes that come with a wizard file or a sync, put into the space: a theme with a known id and
 * the same content is the space's own; one with a known id and other content comes in under a
 * free id. Answers how ids were renamed, for the wizard's `themes`.
 */
export async function importThemes(
  projectId: string,
  incoming: readonly unknown[],
): Promise<Record<string, string>> {
  if (!incoming.length) {
    return {};
  }
  const p = await db.query.project.findFirst({ where: eq(schema.project.id, projectId) });
  if (!p) {
    return {};
  }
  const themes = [...p.themes];
  const renamed: Record<string, string> = {};
  for (const raw of incoming) {
    const theme = checkedTheme(raw, "import");
    const same = themes.find((t) => t.id === theme.id);
    if (same && themeContentKey(same) === themeContentKey(theme)) {
      continue;
    }
    const id = same ? freeThemeId(theme.id, new Set(themes.map((t) => t.id))) : theme.id;
    if (id !== theme.id) {
      renamed[theme.id] = id;
    }
    themes.push({ ...theme, id });
  }
  await writeThemes(p.id, themes);
  return renamed;
}

/** The space's themes a wizard names, for a wizard file or a sync. */
export function themesOf(chain: readonly string[] | undefined, themes: readonly Theme[]): Theme[] {
  return (chain ?? []).flatMap((id) => themes.filter((t) => t.id === id));
}
