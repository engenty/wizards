/**
 * What engenty wizards is, on one page, in every turn of the studio assistant. Written from the
 * user guide (docs/content/user/index.md and the pages it links); the details are a docs_search
 * away.
 */
export const PRIMER = `ENGENTY WIZARDS IN ONE PAGE
engenty wizards turns something done again and again into a wizard: pages that ask what it needs, AI steps that do the work, and a link to share. It runs on the person's own computer (a "local install" at ~/.engenty/wizards, studio at /studio) or in the cloud at engenty.ai with an account.

Words
- Studio: where wizards are built. Home lists the space's wizards; the editor (/edit/<id>) shows a wizard's flow as a diagram with its own chat (the architect) that builds and changes it.
- Wizard: a flow of steps a person walks through on a link. Step kinds: a page (fields to fill in), an AI step (an agent with tools: web search, reading files, writing documents, images, video, pages, other services), a review, and the result.
- Run: one person going through a wizard once. Results lists every run that reached its result.
- Space: what all wizards of a team know. Its page has four parts: Info & brand (title, about, logos, colours, assets, facts), Knowledge (pages, tables and files the AI steps look things up in, kept apart by typed categories), Data (tables and pages the wizards keep) and Results (finished runs).
- Model class: the kind of model a step needs (Classifier, Standard, High, Highest for text; Image, Video, Speech, Audio). Which model serves a class is a setting (Settings › Models), not part of the wizard.

Thinking: an installed AI client on the person's subscription (Claude Code, Codex, Antigravity, Cursor Agent), own API keys (OpenAI, Anthropic, Google, fal.ai, ElevenLabs, Replicate, Vercel AI Gateway), a local model (Ollama), or engenty credits from an account. Settings › Models shows which way serves each class and what is missing.

Sharing: Test runs a draft. Publish makes a version live behind a link. Share holds the link, the tag for a website, a QR code, channels (the page, the chat, and what plugins add: WhatsApp, SMS, calls) and the link's settings (on/off, runs per day, a new address). With an account, what is published on a local install also runs in the cloud, on the account's credits, while the computer is off.

AI apps: the install is an MCP server; Claude Desktop, Cursor, Codex and others build and run wizards through it (Settings › AI apps).

Plugins add pages to the studio (a Shop, a Termin-Planer), settings sections, sections of the space page, tools for AI steps and for this assistant, and channels. Settings › Plugins lists what is installed.

Account and plans: an account is optional on a local install; it brings credits, cloud publishing, sync and Pro modules. In the cloud, teams are on a plan (Free, Pro, Team) with monthly credits; credits can be topped up on the account's billing page. Plans, prices and the balance come from the account (tools: plans, account, usage), never from memory.

Studio addresses: / (home), /new (a new wizard), /edit/<id> (the editor), /space/info, /space/knowledge, /space/data, /space/results, /settings/account, /settings/team (cloud), /settings/connectors, /settings/models, /settings/integrate (AI apps), /settings/plugins, and the pages plugins add.`;
