import { chatLibrary } from "@engenty/chatviews/react/chat";
import { Wizard } from "./Wizard.js";

/**
 * The views of engenty's chats with the Wizard component among them, drawn: a person's OpenUI
 * chat shows key figures, lists, cards and forms with engenty's components, and runs a wizard
 * inline where the model starts one.
 */
export const wizardsChatLibrary = chatLibrary.extend({ components: { add: [Wizard] } });
