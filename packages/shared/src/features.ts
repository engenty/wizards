import { FEATURES, type FeatureDeclaration } from "./feature-flags.js";

/**
 * Feature switches: how a flag of feature-flags.ts (or a plugin's manifest) gets its value.
 * The runtime resolves them from the defaults, what the Manage-App says for the team or the
 * linked account, and this install's `.features` file; the studio and plugins read the result.
 */

export { FEATURES, type FeatureDeclaration };
export type FeatureName = keyof typeof FEATURES;
export type FeatureKind = (typeof FEATURES)[FeatureName]["kind"];

/** A switch by name; a plugin's own switches carry its id: `contacts.leadScoring`. */
export type Features = Record<string, boolean>;

/** `teamPlans`, `contacts.leadScoring`. */
export const FEATURE_NAME = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)?$/;

/** What a manifest declares for one switch; what is left out is a release switch, off, named by its key. */
export interface FeatureDeclarationInput {
  kind?: "release" | "plan";
  default?: boolean;
  label?: string;
  hint?: string;
}

/** A plugin's declarations under its id: `contacts` + `leadScoring` → `contacts.leadScoring`. */
export function declaredByPlugin(
  pluginId: string,
  features: Record<string, FeatureDeclarationInput | boolean> | undefined,
): Record<string, FeatureDeclaration> {
  const out: Record<string, FeatureDeclaration> = {};
  for (const [key, raw] of Object.entries(features ?? {})) {
    const name = `${pluginId}.${key}`;
    if (!FEATURE_NAME.test(name)) {
      continue;
    }
    const d = typeof raw === "boolean" ? { default: raw } : raw;
    out[name] = {
      kind: d.kind ?? "release",
      default: d.default ?? false,
      label: d.label ?? key,
      ...(d.hint ? { hint: d.hint } : {}),
    };
  }
  return out;
}

/**
 * Whether a switch is on in resolved values: a switch they do not carry counts as declared – a
 * core flag with its default (`ownKeys` on, `teamPlans` off), anything else off. Every read of a
 * flag goes through this (`useFeature` in the studio), so a missing value means one thing.
 */
export function featureOn(features: Features | null | undefined, name: string): boolean {
  const value = features?.[name];
  if (typeof value === "boolean") {
    return value;
  }
  return Object.hasOwn(FEATURES, name) ? FEATURES[name as FeatureName].default : false;
}

/** The defaults of these declarations; without any, the core's. */
export function defaultFeatures(declared: Record<string, FeatureDeclaration> = FEATURES): Features {
  const out: Features = {};
  for (const [name, d] of Object.entries(declared)) {
    out[name] = d.default;
  }
  return out;
}

/**
 * Switches in the shape of a `.env` file: one `name=on` or `name=off` per line (`true`/`false`
 * and `1`/`0` count too), `#` starts a comment, anything else is skipped. The `FEATURES`
 * environment variable holds the same, comma-separated. Unknown names are kept: a plugin's
 * switches are not known here.
 */
export function parseFeatures(text: string): Features {
  const out: Features = {};
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    const m = /^([A-Za-z0-9.]+)\s*=\s*(\S+)$/.exec(line);
    if (!m?.[1] || !m[2] || !FEATURE_NAME.test(m[1])) {
      continue;
    }
    const value = m[2].toLowerCase();
    if (["on", "true", "1"].includes(value)) {
      out[m[1]] = true;
    } else if (["off", "false", "0"].includes(value)) {
      out[m[1]] = false;
    }
  }
  return out;
}

/** The text of a `.features` file for these switches, one `name=on|off` per line. */
export function formatFeatures(features: Features): string {
  const lines = Object.entries(features).map(([name, on]) => `${name}=${on ? "on" : "off"}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Layers laid over each other, the last one winning; null layers are skipped. */
export function resolveFeatures(...layers: (Features | null | undefined)[]): Features {
  const out: Features = {};
  for (const layer of layers) {
    if (layer) {
      Object.assign(out, layer);
    }
  }
  return out;
}
