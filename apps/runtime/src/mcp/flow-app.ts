import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WizardDefinition } from "@engenty-wizards/shared/definition";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { env } from "../env.js";
import { runTicket } from "../secrets/signing.js";
import type { RunReport } from "../services/runs.js";
import { draftIssues, ownedWizard, publishedVersion } from "../services/wizards.js";

/**
 * The flow widget (MCP Apps): a wizard as its diagram, and a run on it — where it stands, what
 * it made, the page it waits for. Hosts that render MCP Apps (Claude Desktop, Cursor, VS Code,
 * Goose, ChatGPT) show it in the chat; the others get the same tools as text.
 */

/** Built by the web app (`vite.mcp-app.config.ts`) into one HTML file with everything inline. */
const FLOW_APP_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../web/dist/mcp/flow.html",
);

const MISSING = `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:16px">
The flow widget is not built: run <code>pnpm --filter @engenty-wizards/web build</code>.</body>`;

function readWidget(): string {
  try {
    return readFileSync(FLOW_APP_FILE, "utf8");
  } catch {
    return MISSING;
  }
}

const FLOW_APP_HTML = readWidget();

/**
 * Hosts keep a widget by its URI, so the URI names the build: a new widget gets a new address
 * instead of the cached old one.
 */
export const FLOW_APP_URI = `ui://engenty-wizards/flow-${createHash("sha256").update(FLOW_APP_HTML).digest("hex").slice(0, 10)}.html`;

/** What the widget gets as a tool's structuredContent. */
export interface FlowView {
  wizard: {
    id: string;
    title: string;
    description?: string;
    avatar?: string;
    /** Which definition the diagram shows. */
    shows: "draft" | "published";
    published: boolean;
    issues?: number;
  };
  definition: WizardDefinition;
  run?: RunReport;
  /** Where the widget reaches the run itself, to show it as the wizard does: this runtime and the run's ticket. */
  runtime?: { base: string; ticket: string };
}

export function registerFlowApp(server: McpServer) {
  // The widget reaches the run on the doors: their origin.
  const origin = new URL(env.publicUrl).origin;
  registerAppResource(
    server,
    "Wizard flow",
    FLOW_APP_URI,
    {
      description: "A wizard as a diagram, and a run on it.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: FLOW_APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: FLOW_APP_HTML,
          _meta: {
            ui: {
              // The run and its files are served by this runtime; the fonts by Google.
              csp: {
                connectDomains: [origin],
                resourceDomains: [
                  origin,
                  "https://fonts.googleapis.com",
                  "https://fonts.gstatic.com",
                ],
              },
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );
}

/**
 * The widget's data for a wizard: the published version when there is one (that is what runs),
 * else the draft. A run brings the definition it started on.
 */
export async function flowView(
  userId: string,
  wizardId: string,
  options: { shows?: "draft" | "published"; run?: RunReport; definition?: WizardDefinition } = {},
): Promise<FlowView> {
  const w = await ownedWizard(userId, wizardId);
  const published = options.shows === "draft" ? null : await publishedVersion(w);
  const shows = published ? "published" : "draft";
  const definition = options.definition ?? published?.definition ?? w.draft;
  return {
    wizard: {
      id: w.id,
      title: definition.title,
      description: definition.description,
      avatar: definition.avatar,
      shows,
      published: w.publishedVersion !== null,
      issues: shows === "draft" ? (await draftIssues(w)).length : undefined,
    },
    definition,
    run: options.run,
    runtime: options.run
      ? { base: env.publicUrl, ticket: runTicket(options.run.runId) }
      : undefined,
  };
}

/** A tool's `_meta` that opens the widget with the tool's result. */
export const flowAppMeta = {
  ui: { resourceUri: FLOW_APP_URI },
  "openai/outputTemplate": FLOW_APP_URI,
};

/**
 * Where a result carries the widget's data. The definition stays out of `structuredContent`,
 * which hosts hand to the model as well; `_meta` only reaches the widget.
 */
export const FLOW_VIEW_KEY = "engenty/flow";
