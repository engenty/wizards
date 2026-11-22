# @engenty/browser

A browser for agents, on Mastra's agent-browser provider (`@mastra/agent-browser`). MIT.

- **One session per thread.** `new AgentPages()` starts Chrome on first use: the person's
  Chrome on a Mac, otherwise Playwright's Chromium (`executablePath` names another).
- **Tools for any tool system.** `tools()` returns plain definitions (name, description, zod
  input, `run(threadId, input)`): open, snapshot (an accessibility tree with refs like `@e1`),
  click, type, press, select, scroll, back, wait, tabs, close. None runs the model's
  JavaScript on a page.
- **Private fill.** `fillPrivately(threadId, ref, value, origin)` types a password or a code
  into a field only when the page and the field, also one inside a frame, are on `origin`. The
  value never passes through a model. `click(threadId, ref)` then sends the form.

```ts
import { AgentPages } from "@engenty/browser";

const pages = new AgentPages();
const [open, snapshot] = pages.tools();
await open.run(threadId, { url: "https://example.com/login" });
await pages.fillPrivately(threadId, "@e2", password, "https://example.com");
```
