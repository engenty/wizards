import { chatLibrarySpec } from "@engenty/chatviews/chat";
import { WizardSpec } from "./server.js";

/**
 * The views of engenty's chats (@engenty/chatviews, `engenty:core/1`) with the Wizard component
 * among them, as the model sees them: a chat server writes its prompt from this library, the
 * browser draws with `wizardsChatLibrary` (`@engenty/wizards/openui`). Both make the same prompt.
 */
export const wizardsChatLibrarySpec = chatLibrarySpec.extend({
  components: { add: [WizardSpec as never] },
});
