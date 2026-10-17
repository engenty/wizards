# @engenty/wizards

What code outside engenty wizards imports, one subpath per use. The runtime and the studio of
engenty wizards are not in it.

| Import | What it is | Docs |
|---|---|---|
| `@engenty/wizards/plugin` | A plugin's server half: `definePlugin` and its types | `docs/content/dev/plugins` |
| `@engenty/wizards/plugin/studio` | A plugin's studio half: `defineStudioPlugin` | `docs/content/dev/plugins/studio.md` |
| `@engenty/wizards/plugin/thread` | A messenger channel: `ThreadDoor` | `docs/content/dev/plugins/runners.md` |
| `@engenty/wizards/openui` | Wizards in [OpenUI](https://github.com/thesysdev/openui) chats: the `Wizard` component | `docs/content/dev/integration/openui.md` |
| `@engenty/wizards/openui/server` | Its server half: the rules and the list of wizards for the chat's prompt | |
| `@engenty/wizards/openui/styles.css` | The styles the `Wizard` component draws with | |

## Wizards in OpenUI chats

The chat's model decides that a wizard runs and what it already knows. The wizard then runs
inside the conversation as its author defined it, drawn by the runner (`packages/runner`) in
the chat's own page.

```tsx
// The browser
import "@engenty/wizards/openui/styles.css";
import { addWizard, configureWizards, Wizard } from "@engenty/wizards/openui";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";

configureWizards({ runtime: "/wizards-runtime" }); // where the runtime answers
const library = addWizard(openuiChatLibrary, Wizard);
```

```ts
// The server that builds the system prompt
import { addWizard, loadWizards, wizardRules } from "@engenty/wizards/openui/server";

const wizards = await loadWizards("http://localhost:24368", ["<token>"]);
const prompt = addWizard(openuiChatLibrary).prompt({
  ...openuiChatPromptOptions,
  additionalRules: [...(openuiChatPromptOptions.additionalRules ?? []), ...wizardRules(wizards)],
});
```

What the model writes: `Wizard("<token>", "<note>", {plate: "W-12345"})`. The prefill starts
the page's fields, and the person still sees and sends each page. When the run is done, the
component sends a `continue_conversation` action with the result's texts as its context, and
the chat goes on with it. A chat to try it with: `examples/openui-chat`.

## Licences

`src/openui/` is under the MIT licence (`src/openui/LICENSE`), the rest under FSL-1.1-MIT like
the repository.
