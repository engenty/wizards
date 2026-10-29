/**
 * The studio's query keys for what changes live (docs/plans/live-changes.md): one factory per
 * area, used by the queries, by the invalidations after a save and by the live patchers, so a
 * key named once can't be missed in one of them.
 */
export const keys = {
  spaces: () => ["projects"] as const,
  /** A space's wizards, the cards; the lists add their own parts after the space. */
  wizards: (projectId: string | undefined) => ["wizards", projectId] as const,
  /** A space's wizards, as the public page lists them. */
  projectWizards: (projectId: string) => ["project-wizards", projectId] as const,
  wizard: (id: string | undefined) => ["wizard", id] as const,
  translations: (wizardId: string) => ["wizard-translations", wizardId] as const,
  page: (id: string) => ["space-page", id] as const,
  table: (id: string) => ["space-table", id] as const,
  spaceData: (projectId: string | undefined) => ["space-data", projectId] as const,
  knowledge: (projectId: string | undefined) => ["knowledge", projectId] as const,
  knowledgeValues: () => ["knowledge-value"] as const,
  skills: (projectId: string | undefined) => ["skills", projectId] as const,
  skill: (id: string) => ["skill", id] as const,
  files: (projectId: string) => ["project-files", projectId] as const,
  fileText: (fileId: string) => ["project-file-text", fileId] as const,
  connectors: (projectId: string) => ["connectors", projectId] as const,
  themes: (projectId: string) => ["themes", projectId] as const,
  cloudSync: () => ["cloud-sync"] as const,
  /** Who is in a wizard, page or table. */
  presence: (kind: string, item: string) => ["presence", kind, item] as const,
  /** Who is in each item of a kind, for the lists. */
  presentItems: (kind: string) => ["presence-all", kind] as const,
};
