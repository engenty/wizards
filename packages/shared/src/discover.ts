import type { RegistryHit } from "./connectors.js";
import type { SkillHit } from "./skills.js";

/**
 * Fähigkeiten › Entdecken (docs/plans/capabilities.md): one search over the two public
 * directories, skills.sh for skills and integrations.sh for connectors.
 */

/** A service of integrations.sh, marked where the space has it already. */
export interface DiscoverConnector extends RegistryHit {
  /** The space imported it, or has a connection to it. */
  setUp: boolean;
}

/** What one search found. A directory that failed leaves its list empty and says why. */
export interface DiscoverAnswer {
  skills: SkillHit[];
  connectors: DiscoverConnector[];
  /** In plain words, in the asker's language. */
  errors: { skills?: string; connectors?: string };
}
