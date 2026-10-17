import type { PublicField, PublicWizard } from "@engenty-wizards/shared/run";
import { defineComponent, type Library } from "@openuidev/react-lang";
import { z } from "zod";

/**
 * The model's half of the Wizard component: its props, its description and the rules a system
 * prompt gets. Nothing here draws, so a chat server builds its prompt from this file alone.
 */

export const WIZARD_COMPONENT = "Wizard";

export const wizardProps = z.object({
  wizard: z.string().describe("The token of a wizard from the list of available wizards"),
  note: z
    .string()
    .optional()
    .describe("One short sentence shown above the wizard: why it starts now"),
  prefill: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Answers already known from the conversation, by field id; the person still checks them",
    ),
});

export type WizardProps = z.infer<typeof wizardProps>;

export const WIZARD_DESCRIPTION =
  "Runs a predefined wizard inline: its pages, AI steps, review and result, exactly as its author defined them. Use it whenever a listed wizard fits the request; never rebuild a wizard's pages with Form components.";

/** The component as a prompt sees it: the same name and props, nothing to draw. */
export const WizardSpec = defineComponent({
  name: WIZARD_COMPONENT,
  description: WIZARD_DESCRIPTION,
  props: wizardProps,
  component: () => null,
});

/**
 * The library with the Wizard component among a Card's children. A server passes `WizardSpec`
 * for its prompt, the browser the drawing `Wizard`; both make the same prompt.
 */
export function addWizard<L extends Library>(
  library: L,
  component: typeof WizardSpec = WizardSpec,
): Library {
  if (!library.extend) {
    throw new Error("This OpenUI library cannot be extended.");
  }
  return library.extend({ components: { add: [{ component, slots: ["Card"] }] } });
}

/** A wizard as the chat server lists it to the model. */
export interface WizardInfo {
  token: string;
  title: string;
  description: string;
  fields: PublicField[];
}

/** Reads the published wizards behind these tokens from a runtime; ones it cannot read are left out. */
export async function loadWizards(runtimeUrl: string, tokens: string[]): Promise<WizardInfo[]> {
  const base = runtimeUrl.replace(/\/+$/, "");
  const found = await Promise.all(
    tokens.map(async (token) => {
      try {
        const res = await fetch(`${base}/api/public/wizards/${encodeURIComponent(token)}`);
        if (!res.ok) {
          return null;
        }
        const w = (await res.json()) as PublicWizard;
        return w.available
          ? { token: w.token, title: w.title, description: w.description, fields: w.fields ?? [] }
          : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((w): w is WizardInfo => w !== null);
}

function fieldLine(f: PublicField): string {
  const choices = f.options?.length
    ? ` one of ${f.options.map((o) => JSON.stringify(o)).join(" | ")}`
    : "";
  return `${f.id} (${f.kind}${choices}${f.required ? ", required" : ""}): ${f.label}`;
}

/** The rules a system prompt adds for the Wizard component: when to use it and which wizards exist. */
export function wizardRules(wizards: WizardInfo[]): string[] {
  if (!wizards.length) {
    return [];
  }
  const list = wizards
    .map(
      (w) =>
        `- "${w.title}" token: ${w.token} — ${w.description}\n  fields: ${w.fields.map(fieldLine).join("; ") || "none"}`,
    )
    .join("\n");
  return [
    `Wizards are fixed workflows with their own pages, AI steps and results. When the person asks for something a wizard below does, answer with a Card that holds one short TextContent and Wizard("<token>", "<note>", {prefill}). Do not ask the wizard's questions yourself and do not build them as a Form: the wizard asks them.`,
    `Prefill only answers the person has actually given in this conversation, by field id; leave out anything you would have to guess. Dates are YYYY-MM-DD.`,
    `When a message says a wizard finished, its context holds the result: answer in plain words about it, and start a wizard again only when asked.`,
    `Available wizards:\n${list}`,
  ];
}
