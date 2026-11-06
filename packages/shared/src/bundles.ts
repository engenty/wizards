import type { ActionKindChoice, ConnectorView, SignInChoice, SourcePreview } from "./connectors.js";
import type { SkillMode } from "./skills.js";

/**
 * A Connector that brings skills (docs/plans/capabilities-next.md, piece 4): a plugin for Claude
 * Code or Cursor, taken into a space from a public repository on GitHub or an uploaded zip. Its
 * MCP servers over http become Connectors, its skills become Skills that name them. A `bundle`
 * is the record of what came together; the studio has no word for it and shows a Connector with
 * its Skills.
 */

/** Whose manifest was read: Claude Code's, Cursor's, or the open one Cursor reads at the root. */
export const BUNDLE_FORMATS = ["claude", "cursor", "agent"] as const;
export type BundleFormat = (typeof BUNDLE_FORMATS)[number];

/** Where it came from: a repository on GitHub (`owner/name`, a branch or tag, a folder), or a file. */
export type BundleOrigin =
  | { kind: "github"; repo: string; ref: string | null; path: string }
  | { kind: "upload"; file: string; path: string };

/** What a plugin holds that a space does not take. */
export const BUNDLE_LEFT_OUT_KINDS = [
  "command",
  "agent",
  "hook",
  "rule",
  "server",
  "skill",
  "other",
] as const;
export type BundleLeftOutKind = (typeof BUNDLE_LEFT_OUT_KINDS)[number];

/**
 * Why a server or a skill was left out. A server: started on the command line (`stdio`), over a
 * socket, without an address, an address with a value nobody gave (`variable`), a bundled file,
 * no http address, refused when it was read (`refused`, with the words in `detail`), or more
 * than a plugin may bring (`count`). A skill: its `SKILL.md` or its size (`invalid`), or `count`.
 */
export type BundleLeftOutReason =
  | "stdio"
  | "socket"
  | "noAddress"
  | "variable"
  | "file"
  | "address"
  | "refused"
  | "invalid"
  | "count";

export interface BundleLeftOut {
  kind: BundleLeftOutKind;
  /** A command's, an agent's or a server's name, a hook's event, a skill's folder. */
  name: string;
  reason?: BundleLeftOutReason;
  /** A refusal in the reader's words; only in a preview, never kept. */
  detail?: string;
}

/** An MCP server over http a plugin names, read as „Per Adresse“ reads an address. */
export interface BundleServerPreview {
  /** Its name in the plugin. */
  key: string;
  url: string;
  transport: "http" | "sse";
  /** Headers the plugin sets on every request, by name. */
  headers: string[];
  /** A key in a header the plugin asks for, where the server describes no sign-in itself. */
  keyHeader: { name: string; scheme?: string } | null;
  /** What answered at the address: its actions with what each was read as, how it signs in. */
  source: SourcePreview;
}

/** A skill a plugin brings, before it is taken. */
export interface BundleSkillPreview {
  /** Its folder in the plugin: `skills/call-prep`. */
  path: string;
  name: string;
  description: string;
  /** Characters of its instructions. */
  chars: number;
  /** Its files beside the `SKILL.md`. */
  files: number;
  /** It brings scripts: they stay off until someone switches them on for the skill. */
  scripts: boolean;
  /** Files left out: not text and too large, or too many. */
  skipped: number;
}

/** A plugin read whole, before anything is taken. */
export interface BundlePreview {
  name: string;
  version: string | null;
  description: string | null;
  format: BundleFormat;
  origin: BundleOrigin;
  /** Of what would be taken: the import takes it only as it was shown. */
  hash: string;
  servers: BundleServerPreview[];
  skills: BundleSkillPreview[];
  leftOut: BundleLeftOut[];
  /** How many more skills the space holds. */
  skillsFree: number;
  /** The space has it from this origin already: its record's id. */
  added: string | null;
}

/** One plugin of a repository that holds several. */
export interface BundleChoice {
  name: string;
  description: string | null;
  /** Its folder in this repository; null where it lives in another one. */
  path: string | null;
  /** Its own address on GitHub, where it lives in another repository. */
  address: string | null;
}

/** What reading an address or a zip found: one plugin, or the plugins to choose from. */
export interface BundlePreviewAnswer {
  preview: BundlePreview | null;
  plugins: BundleChoice[];
}

/** What an admin says about one server of the plugin; left out: taken as it was read. */
export interface BundleServerChoice {
  /** `false`: this server stays out. */
  take?: boolean;
  id?: string;
  toolPrefix?: string;
  name?: string;
  signIn?: SignInChoice;
  actionKinds?: Record<string, ActionKindChoice>;
  oauthClientId?: string;
  oauthClientSecret?: string;
}

export interface BundleImportRequest {
  /** The preview's hash: a plugin that changed since is shown again first. */
  hash?: string;
  /** By the server's name in the plugin. */
  servers?: Record<string, BundleServerChoice>;
  /** The skills to take, by their folder; left out: all of them. */
  skills?: string[];
}

/** A skill of the space that came with a bundle. */
export interface BundleSkill {
  id: string;
  name: string;
  description: string;
  mode: SkillMode;
}

/** What came together, as the Connector's page shows it. */
export interface BundleView {
  id: string;
  spaceId: string;
  name: string;
  version: string | null;
  description: string | null;
  format: BundleFormat;
  origin: BundleOrigin;
  hash: string;
  /** What the plugin holds and the space did not take; no words, the studio has them. */
  leftOut: BundleLeftOut[];
  connectors: { id: string; name: string }[];
  connections: { id: string; name: string; connectorId: string }[];
  skills: BundleSkill[];
  addedAt: string;
  updatedAt: string;
}

/** What an import made. */
export interface BundleImported {
  bundle: BundleView;
  connectors: ConnectorView[];
  warnings: string[];
}

/** What the origin has now that the space has not: null where nothing changed. */
export interface BundleUpdate {
  version: string | null;
  hash: string;
  /** Skills by name: new at the origin, changed there, gone from it. */
  skills: { added: string[]; changed: string[]; removed: string[] };
  /** Servers: new at the origin, and the space's connectors the origin no longer names. */
  servers: {
    added: { key: string; url: string }[];
    removed: { connectorId: string; name: string }[];
  };
  leftOut: BundleLeftOut[];
}

export interface BundleUpdateAnswer {
  update: BundleUpdate | null;
  /** It came from a file: the origin cannot be asked, a new file is uploaded. */
  upload: boolean;
}

/** What taking an update did. */
export interface BundleUpdated {
  bundle: BundleView;
  /** New servers that were not imported, each with why, in the reader's words. */
  notTaken: { key: string; detail: string }[];
}

/** What removing takes with it, said before it is removed. */
export interface BundleRemoval {
  connectors: { id: string; name: string }[];
  connections: { id: string; name: string }[];
  skills: { id: string; name: string }[];
  /** The wizards whose draft or published version uses one of the connections. */
  wizards: { id: string; title: string; connections: string[] }[];
}
