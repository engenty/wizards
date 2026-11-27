import type { BundleFormat } from "./bundles.js";
import type { RegistryHit } from "./connectors.js";
import type { SkillHit } from "./skills.js";

/**
 * Fähigkeiten › Entdecken (docs/plans/capabilities.md): one search over the two public
 * directories, skills.sh for skills and integrations.sh for connectors, and Composio's catalog
 * where its switch is on. A repository that holds
 * a plugin with a server and skills is one hit, not two (`bundles.ts`).
 */

/** A service of integrations.sh, marked where the space has it already. */
export interface DiscoverConnector extends RegistryHit {
  /** The space imported it, or has a connection to it. */
  setUp: boolean;
}

/**
 * A repository on GitHub that is a plugin for Claude Code or Cursor with an MCP server over http
 * and skills: a Connector that brings its Skills. It stands for the hits it covers, which a list
 * leaves out.
 */
export interface DiscoverBundle {
  /** `owner/name`. */
  repo: string;
  name: string;
  description: string | null;
  format: BundleFormat;
  /** The hosts of its servers over http. */
  hosts: string[];
  /** Its owner is one skills.sh lists as official. */
  official: boolean;
  /** The space has it already. */
  added: boolean;
  /** The hits it stands for: skills by their address on skills.sh, connectors by their domain. */
  covers: { skills: string[]; connectors: string[] };
}

/**
 * A service of Composio's catalog (docs/plans/composio.md): set up as a connection on the
 * connector `composio-<slug>`; Composio keeps the account's tokens.
 */
export interface DiscoverComposio {
  connectorId: string;
  slug: string;
  name: string;
  description: string;
  /** The space has a connection on it. */
  setUp: boolean;
}

/** What one search found. A directory that failed leaves its list empty and says why. */
export interface DiscoverAnswer {
  skills: SkillHit[];
  connectors: DiscoverConnector[];
  /** Composio's services, where its switch is on and this runtime reaches Composio; else empty. */
  composio: DiscoverComposio[];
  /** Repositories that hold a server and skills; the lists above still name what each covers. */
  bundles: DiscoverBundle[];
  /** In plain words, in the asker's language. */
  errors: { skills?: string; connectors?: string; composio?: string };
}
