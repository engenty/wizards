# Wizards in OpenUI – the example chat

An [OpenUI](https://github.com/thesysdev/openui) chat that starts your published wizards. The
chat's model decides that a wizard fits and writes one line, `Wizard("<token>", "<note>",
{prefill})`. From then on the wizard runs inside the conversation as its author defined it:
its pages, its AI steps, the review and the result with its downloads. When it is done, the
chat hears about the result and goes on. No iframe: the steps are drawn in the chat's own page.

The component is `@engenty/wizards/openui` (`packages/wizards/src/openui`); the developer docs explain
how it works (`docs/content/dev/integration/openui.md`). The concept is
`docs/plans/wizards-in-generative-ui.md`.

## Try it

You need Node 24 and pnpm, as for the rest of the repository.

1. **Start the runtime** from the repository root, with a model it can use (see
   `docs/development.md`):

   ```bash
   pnpm install
   cp .env.example .env.local   # a model key, DEV_LOGIN=1
   pnpm dev                     # studio on http://localhost:5181
   ```

2. **Publish one or two wizards** in the studio and copy each one's token: the part of its link
   after `/w/` (`http://localhost:5181/w/<token>`).

3. **Tell the chat about them and about its model.** Put an `.env.local` in this folder:

   ```bash
   WIZARDS=<token>,<token>
   CHAT_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
   CHAT_API_KEY=sk-...
   CHAT_MODEL=gpt-5-mini
   # WIZARDS_RUNTIME_URL=http://localhost:24368   # where the runtime answers, if not there
   ```

   Other endpoints that work: the Vercel AI Gateway (`https://ai-gateway.vercel.sh/v1`, model
   `anthropic/claude-sonnet-5.5`), Anthropic's OpenAI-compatible endpoint
   (`https://api.anthropic.com/v1`, model `claude-sonnet-5-5`), Ollama
   (`http://127.0.0.1:11434/v1`, no key).

4. **Start the chat:**

   ```bash
   pnpm --filter @engenty-wizards/example-openui-chat dev   # http://localhost:5190
   ```

   The first start builds the runner's styles once.

5. **Ask for something a wizard does**, in your own words. The welcome screen also lists your
   wizards. Mention something the wizard asks, a number plate say, and its field starts filled in.

## Good to know

- **Visitor limit.** The runtime lets a visitor start 6 runs an hour by default. Set
  `LIMIT_VISITOR_RUNS_PER_HOUR=100` in the runtime's `.env.local` while you try things.
- **Camera, microphone and location** work as on the wizard's own page: on `localhost` or
  HTTPS, once the person allows them. The chat page is not a frame, so nothing else is needed.
- **Runs spend credits** as on the wizard's own page.
- **One runtime per page.** `configureWizards` names it once. The page reaches it through its own
  proxy (`/wizards-runtime`, see `vite.config.ts`), so the runner's cookie stays first-party.
- **The “OpenUI Inspect” button** at the bottom right is OpenUI's own: `@openuidev/react-lang`
  adds it to every page in development and loads it from jsDelivr. It lists the errors of the
  model's answers, and its banner advertises OpenUI's cloud. A production build leaves it out,
  and there is no switch for it in development.
