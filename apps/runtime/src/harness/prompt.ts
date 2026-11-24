import type { PromptWords } from "@engenty/local-models/clients";
import { prompt } from "../prompts.js";

/** The sentences an installed client reads besides a call's messages, from prompts/services.md. */
export const CLIENT_WORDS: PromptWords = {
  attachedFile: (path) => prompt("services", "harness.attached_file", { path }),
  conversationNote: () => prompt("services", "harness.conversation_note"),
  jsonInstruction: (schema) => prompt("services", "harness.json_instruction", { schema }),
};
