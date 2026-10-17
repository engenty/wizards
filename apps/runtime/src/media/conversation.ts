import { langNameEn } from "@engenty-wizards/shared/definition";
import type { RunView } from "@engenty-wizards/shared/run";
import { NotedError } from "../model-errors.js";
import { conversationAccess } from "../models.js";

/**
 * A live conversation with a wizard: the browser talks to a realtime speech model directly
 * (audio both ways over WebRTC); this runtime only mints the short-lived secret the browser
 * connects with, and writes the instructions and the tools the model drives the run with. The
 * tools run in the browser against the run's own routes, so audio never touches the runtime.
 */

const SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** How long a minted secret opens a session; the session itself goes on until it ends. */
const SECRET_TTL_SECONDS = 600;

/** The voice the wizard speaks with: one that speaks every language engenty does. */
const VOICE = "marin";

export interface ConversationSession {
  clientSecret: string;
  expiresAt: string;
  model: string;
  /** Where the browser sends its offer, with the secret as bearer. */
  endpoint: string;
}

/** What the model may do: one tool per command of the run page, run by the browser. */
export const CONVERSATION_TOOLS = [
  {
    type: "function",
    name: "get_state",
    description:
      "What the run waits for right now: the page with its fields (which are answered, which are still open, which need the screen), the review, or what the wizard is working on. Call it when unsure, and after the state changed.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "set_field",
    description:
      "Keeps the person's answer to one field of the current page. Call it once per field as soon as the person answered; for a choice give one of the options exactly.",
    parameters: {
      type: "object",
      properties: {
        field: { type: "string", description: "The field's id from the state." },
        value: {
          description:
            "The answer: a string, a number, true/false for a toggle, or an array of options for a multiple choice.",
        },
      },
      required: ["field", "value"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "submit_page",
    description:
      "Sends the current page once every required field that can be answered by voice has a value. Fields that need the screen are filled there by the person; say so and wait.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "accept_review",
    description: "Accepts what the wizard made, when the person is happy with it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "regenerate",
    description: "Asks the wizard to make one of the shown outputs again, with what should change.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "The step id of the output, from the state." },
        note: { type: "string", description: "What should change, in the person's words." },
      },
      required: ["target", "note"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "answer_ask",
    description:
      "Answers the question a running step asks before it changes something in a connected account: allow it, or skip it.",
    parameters: {
      type: "object",
      properties: { allow: { type: "boolean" } },
      required: ["allow"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "look",
    description:
      "Takes a look through the person's camera right now: a picture of what they are showing arrives as the next message. Only while the camera is on; otherwise ask them to switch it on.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "take_photo",
    description:
      "Takes a photo with the person's camera and puts it into a photo field of the current page. Say 'hold it still' first. Only while the camera is on.",
    parameters: {
      type: "object",
      properties: { field: { type: "string", description: "The id of the image field." } },
      required: ["field"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "go_back",
    description: "Goes back to the page before, when the person wants to change an earlier answer.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

/** The rules the model speaks by: written in English, it speaks the wizard's language. */
export function conversationInstructions(view: RunView): string {
  const about = [`You are ${view.wizard.title}.`, view.wizard.description, view.wizard.intro]
    .filter(Boolean)
    .join(" ");
  const rules = [
    "You hold a conversation that fills in a wizard step by step. The person also sees the wizard on the screen.",
    `Speak ${langNameEn(view.lang)} (${view.lang}), short and friendly, as on the phone. One sentence, then the next question.`,
    "Ask one field at a time, in the order of the state. After each answer call set_field. When every field you can fill by voice is answered, call submit_page.",
    "For a choice, name the options (at most four at a time) and pass exactly one of them on.",
    "Read e-mail addresses, links and numbers back before passing them on.",
    "A field that needs the screen (a photo, a file, a signature, a connection) is filled there by the person: say so in one sentence and wait for the next state.",
    "While the wizard works, say in one sentence what it is doing and wait. Never make anything up.",
    "At a review, sum the text up in a few words and ask whether it fits. Then accept_review, or regenerate with what the person wants changed.",
    "At the end, say what was made and that it is on the screen.",
    "With the camera on you can see what the person shows with look, and put a photo into a photo field with take_photo; ask for a photo field like this: 'Hold it to the camera, I will take the picture.' With the camera off, ask the person to switch it on, or leave the field to the screen.",
  ];
  return `${about}\n\n${rules.join("\n")}`;
}

/** Mints the secret a browser opens a session with; a failure carries a note for the run's language. */
export async function mintConversation(view: RunView): Promise<ConversationSession> {
  const { apiKey, model } = await conversationAccess();
  const res = await fetch(SECRETS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: SECRET_TTL_SECONDS },
      session: {
        type: "realtime",
        model,
        instructions: conversationInstructions(view),
        tools: CONVERSATION_TOOLS,
        tool_choice: "auto",
        audio: {
          // What the person said, written down: the call screen shows it as captions.
          input: {
            transcription: { model: "gpt-4o-mini-transcribe" },
            // Phones and laptops play the wizard's voice through their own speakers, which the mic
            // picks up: far-field filtering and a higher bar for speech keep it from interrupting itself.
            noise_reduction: { type: "far_field" },
            turn_detection: { type: "server_vad", threshold: 0.7, silence_duration_ms: 600 },
          },
          output: { voice: VOICE },
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // The provider's answer goes to the log; the page hears only that it did not work, and why in a word.
    const detail = (await res.text()).slice(0, 500);
    console.error(`[talk] the provider refused the session (${res.status}):`, detail);
    throw new NotedError(
      res.status === 401 || res.status === 403
        ? { code: "talkKeyRefused" }
        : { code: "talkFailed", params: { status: res.status } },
    );
  }
  const body = (await res.json()) as { value?: string; expires_at?: number };
  if (!body.value) {
    throw new NotedError({ code: "talkNoSecret" });
  }
  return {
    clientSecret: body.value,
    expiresAt: new Date(
      (body.expires_at ?? Date.now() / 1000 + SECRET_TTL_SECONDS) * 1000,
    ).toISOString(),
    model,
    endpoint: `${CALLS_URL}?model=${encodeURIComponent(model)}`,
  };
}
