import { z } from "zod";
import { DEFINITION_VERSION } from "./definition.js";

/**
 * A wizard as a file, `<title>.wizard`: a zip with `wizard.json` — the definition and what it
 * needs from its project — and the workspace under `files/`. What belongs to people (runs, lists, connected
 * accounts) and to the project (brand, credentials) stays where it is.
 */

export const PACKAGE_FORMAT = "engenty-wizard";
export const PACKAGE_MANIFEST = "wizard.json";
export const PACKAGE_FILES = "files/";
export const PACKAGE_EXTENSION = ".wizard";
/** A type of its own: under `application/zip` a browser may save the file as `.zip`. */
export const PACKAGE_MIME = "application/vnd.engenty.wizard+zip";
/** The workspace's 25 MB, with room for the manifest and the zip's own overhead. */
export const PACKAGE_MAX_BYTES = 30_000_000;

/**
 * Where the JSON Schemas of both are published (the docs site's public folder, written by
 * `pnpm schema`, answered at engenty.ai/schema/…). One folder per definition version: a breaking
 * change adds the next and keeps the old. The package's schema holds the definition's, so it sits
 * beside it.
 */
export const SCHEMA_BASE_URL = `https://engenty.ai/schema/v${DEFINITION_VERSION}`;
export const WIZARD_SCHEMA_URL = `${SCHEMA_BASE_URL}/wizard.json`;
export const PACKAGE_SCHEMA_URL = `${SCHEMA_BASE_URL}/wizard-package.json`;

export const manifestSchema = z.object({
  /** The JSON Schema an editor checks the file against; the app does not read it. */
  $schema: z.string().optional(),
  format: z.literal(PACKAGE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().optional(),
  definition: z.unknown(),
  /** Imported connectors the wizard's connections name. No address: one pasted by hand can hold a secret. */
  connectors: z
    .array(
      z.object({
        id: z.string().max(60),
        name: z.string().max(120),
        domain: z.string().max(253).optional(),
        sourceKind: z.enum(["openapi", "mcp"]).optional(),
      }),
    )
    .max(50)
    .default([]),
  /** Project MCP servers the wizard's steps name — by name only, their address and headers are credentials. */
  mcpServers: z
    .array(z.object({ id: z.string().max(31), name: z.string().max(60) }))
    .max(10)
    .default([]),
  /** The project's pages under `files/knowledge/`, when they were asked for: how many, and whether the cap cut some. */
  knowledge: z.object({ pages: z.number().int(), truncated: z.boolean() }).optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;
