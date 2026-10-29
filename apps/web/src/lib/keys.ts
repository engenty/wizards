/**
 * The studio's query keys for what changes live (docs/plans/live-changes.md): one factory per
 * area, used by the queries, by the invalidations after a save and by the live patchers, so a
 * key named once can't be missed in one of them.
 */
export const keys = {
  spaces: () => ["spaces"] as const,
  /** A space's wizards, the cards; the lists add their own parts after the space. */
  wizards: (spaceId: string | undefined) => ["wizards", spaceId] as const,
  /** A space's wizards, as the public page lists them. */
  spaceWizards: (spaceId: string) => ["space-wizards", spaceId] as const,
  wizard: (id: string | undefined) => ["wizard", id] as const,
  translations: (wizardId: string) => ["wizard-translations", wizardId] as const,
  page: (id: string) => ["space-page", id] as const,
  table: (id: string) => ["space-table", id] as const,
  spaceData: (spaceId: string | undefined) => ["space-data", spaceId] as const,
  knowledge: (spaceId: string | undefined) => ["knowledge", spaceId] as const,
  knowledgeValues: () => ["knowledge-value"] as const,
  skills: (spaceId: string | undefined) => ["skills", spaceId] as const,
  skill: (id: string) => ["skill", id] as const,
  files: (spaceId: string) => ["space-files", spaceId] as const,
  fileText: (fileId: string) => ["space-file-text", fileId] as const,
  connectors: (spaceId: string) => ["connectors", spaceId] as const,
  themes: (spaceId: string) => ["themes", spaceId] as const,
  cloudSync: () => ["cloud-sync"] as const,
  /** Who is in a wizard, page or table. */
  presence: (kind: string, item: string) => ["presence", kind, item] as const,
  /** Who is in each item of a kind, for the lists. */
  presentItems: (kind: string) => ["presence-all", kind] as const,
};
