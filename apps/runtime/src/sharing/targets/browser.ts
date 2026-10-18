import { existsSync } from "node:fs";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { StepContext } from "../../engine/types.js";
import { env } from "../../env.js";
import { browserTools } from "../../tools/browser.js";
import { runShareAgent } from "../agent.js";
import { line, type ShareTarget } from "../types.js";

const RULES = [
  "You work in a browser the person watches. Open the address first, then find the place the request names.",
  "Sign-ins are the person's: on a login form call browser_request_credentials, for anything else in the way (a captcha, 'continue with Google', a cookie wall) browser_request_user. Never type a password or a code yourself. When the person skips a sign-in, stop and report it.",
  "Attach files with browser_upload.",
  "Right before the step that makes it public or sends it (Post, Publish, Send, Submit), call confirm_publish with where and exactly what goes out. Go on only when it answers allowed. If the person asked for a draft, save the draft and publish nothing.",
  "Afterwards look for the address of what you published and report it.",
].join("\n");

/** Leave to publish: the person sees where and what, and says yes or no. */
function confirmTool(step: StepContext, site: string) {
  return createTool({
    id: "confirm_publish",
    description:
      "Ask the person for leave right before the step that makes the result public or sends it. They see where and what. WAITS for the person.",
    inputSchema: z.object({
      where: z
        .string()
        .min(1)
        .max(200)
        .describe("One sentence in the person's language: the site and the place it goes to."),
      what: z.string().min(1).describe("The exact text and the files that will go out."),
    }),
    execute: async ({ where, what }) => {
      const answer = await step.ask({
        kind: "confirm",
        reason: where,
        service: site,
        action: { id: "publish", summary: where, destructive: false },
        input: what.slice(0, 4000),
        once: true,
      });
      if (!answer) {
        return {
          allowed: false,
          note: "Nobody is there to allow it. Publish nothing and report it.",
        };
      }
      return answer.type === "done"
        ? { allowed: true }
        : {
            allowed: false,
            note: "The person did not allow it. Publish nothing; report that it was not published.",
          };
    },
  });
}

const POST = line("sharePostInstructions");

/**
 * Free style: the wizard opens a website in its browser, the person signs in themselves, and an
 * agent posts the result there the way the person describes it. For every place that has no
 * connector.
 */
export const browserTarget: ShareTarget = {
  id: "browser",
  name: "Website",
  description: line("shareWebsiteDescription"),
  icon: "globe",
  takes: "files",
  agent: true,
  available: () => Boolean(env.browserCdpUrl) || existsSync(env.chromePath),
  fields: [
    {
      id: "url",
      kind: "url",
      required: true,
      label: line("shareWebsiteAddress"),
      placeholder: "https://…",
    },
    {
      id: "instructions",
      kind: "textarea",
      required: true,
      label: line("shareWhatThere"),
      placeholder: line("shareWhatTherePlaceholder"),
    },
  ],
  presets: [
    {
      label: "LinkedIn",
      values: {
        url: "https://www.linkedin.com/feed/",
        instructions: POST,
      },
    },
    {
      label: "X",
      values: {
        url: "https://x.com/compose/post",
        instructions: POST,
      },
    },
    {
      label: "Facebook",
      values: {
        url: "https://www.facebook.com/",
        instructions: POST,
      },
    },
    {
      label: "Instagram",
      values: {
        url: "https://www.instagram.com/",
        instructions: POST,
      },
    },
    {
      label: "Meta Ads",
      values: {
        url: "https://adsmanager.facebook.com/",
        instructions: line("shareAdInstructions"),
      },
    },
  ],
  send(input, ctx) {
    const url = input.values.url.trim();
    return runShareAgent(ctx, input, {
      task: `On ${url}: ${input.values.instructions}`,
      rules: RULES,
      maxSteps: 60,
      tools: (step, files) => ({
        ...browserTools(step, [], files),
        confirm_publish: confirmTool(step, new URL(url).hostname),
      }),
    });
  },
};
