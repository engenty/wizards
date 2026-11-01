# Copyrights

Copyright © 2026 Thru The Heart Creative GmbH - Matthias Platzer.

The code in this repository is published under the Functional Source License, version 1.1,
with the MIT future licence ([LICENSE](LICENSE), `FSL-1.1-MIT`): use it for yourself and your
company, run it, change it — just don't offer it to others as a competing product or service.
Each release becomes MIT two years after it is published. Every package of the workspace names
its licence in its `package.json`.

The wizard format is open to everyone now: the sixteen files that define a wizard, read it and
pack it as a `.wizard` file (`packages/shared/src/definition.ts`, `fit.ts`, `numbers.ts`,
`run.ts`, `runner-texts.ts`, `shape.ts`, `sharing.ts`, `store.ts`, `surface.ts`, `texts.ts`,
`theme.ts`, `translation.ts`, `wizard-package.ts` and `engenty/data-tables/columns.ts`,
`columns-format.ts`, `columns-value.ts`) are also under the MIT licence, at the
choice of whoever uses them (`FSL-1.1-MIT OR MIT`, [packages/shared/LICENSE-MIT](packages/shared/LICENSE-MIT)).
Each says so in its first line. The runner package (`packages/runner`, MIT) bundles them under MIT.
`@engenty/wizards` on npm is `FSL-1.1-MIT`; its `/openui` bundles the runner, whose MIT licence
ships beside it (`dist/openui/LICENSE-MIT`).
The plugin for the AI apps (`plugin/`, published as engenty/wizards-plugins) is under the MIT
licence ([plugin/LICENSE](plugin/LICENSE)), except the engenty figures in it.

The engenty figures are free artwork under CC BY 4.0 ([LICENSE-FIGURES](LICENSE-FIGURES)): use,
change and share them, commercially too, with credit. That covers the files that describe what
they look like (`apps/web/src/engenty/engenty.tsx`, `colors.ts`, `forms.ts`,
`helmet.tsx`, `goose-helmet-fit.ts`, the helmet's mesh and livery, `logo.tsx`,
`apps/runtime/src/services/engenty-shapes.ts`, `apps/portal/src/engenty-shapes.ts`, `plugin/claude-code/engenty.ts`, the PNGs in
`assets/engenty/`, the favicons and app icons); each text file among
them says so in its first line, and LICENSE-FIGURES names the rest. The code that renders and
animates them (fur, jelly) stays FSL-1.1-MIT.

"engenty" (the brand of a family of products), "engenty.wizards" (also written "engenty wizards"),
the wordmark and the engenty figures are trademarks of Thru The Heart Creative GmbH. The word
"wizards" on its own is not one of them: it names the package, the repository and the command.
No licence of any part (FSL, MIT, GPL, CC BY) grants trademark rights: using the name or the figures as your own brand, logo or
mascot, in advertising or on merchandise needs permission ([TRADEMARKS.md](TRADEMARKS.md)).

## What is not ours

| Files | Source | Terms |
|---|---|---|
| `apps/web/public/ai-labels/*.svg` | the European Commission's icons for marking AI-generated and AI-modified content (AI Act, Art. 50), as published by the Commission | © European Union; reused unchanged under the Commission's reuse policy (Decision 2011/833/EU) |

## Third-party software

What the runtime, the studio and the runner are built with and run on, under its own licence,
as the studio's About page shows it (`apps/web/src/about/oss-credits.json`). The full licence
text of each package is in the package itself (`node_modules/<name>/LICENSE`). Written by
`pnpm about:data --credits`; run it after a dependency changes.

<!-- third-party: written by scripts/write-about-data.mjs, do not edit by hand -->

### Shared

Declared by two or more of the workspaces below:

| Package | Version | Licence |
|---|---|---|
| [@fontsource/bricolage-grotesque](https://fontsource.org/fonts/bricolage-grotesque) | 5.3.0 | OFL-1.1 |
| [@fontsource/caveat](https://fontsource.org/fonts/caveat) | 5.3.0 | OFL-1.1 |
| [@fontsource/creepster](https://fontsource.org/fonts/creepster) | 5.3.0 | OFL-1.1 |
| [@fontsource/dm-sans](https://fontsource.org/fonts/dm-sans) | 5.3.0 | OFL-1.1 |
| [@fontsource/figtree](https://fontsource.org/fonts/figtree) | 5.3.0 | OFL-1.1 |
| [@fontsource/fraunces](https://fontsource.org/fonts/fraunces) | 5.3.0 | OFL-1.1 |
| [@fontsource/fredoka](https://fontsource.org/fonts/fredoka) | 5.3.0 | OFL-1.1 |
| [@fontsource/inter](https://fontsource.org/fonts/inter) | 5.3.0 | OFL-1.1 |
| [@fontsource/lora](https://fontsource.org/fonts/lora) | 5.3.0 | OFL-1.1 |
| [@fontsource/nosifer](https://fontsource.org/fonts/nosifer) | 5.3.0 | OFL-1.1 |
| [@fontsource/nunito](https://fontsource.org/fonts/nunito) | 5.3.0 | OFL-1.1 |
| [@fontsource/playfair-display](https://fontsource.org/fonts/playfair-display) | 5.3.0 | OFL-1.1 |
| [@fontsource/young-serif](https://fontsource.org/fonts/young-serif) | 5.3.0 | OFL-1.1 |
| [@hono/node-server](https://github.com/honojs/node-server) | 2.1.3 | MIT |
| [@modelcontextprotocol/client](https://modelcontextprotocol.io) | 2.3.0 | Apache-2.0 |
| [@modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) | 2.0.3 | MIT |
| [ai](https://ai-sdk.dev/docs) | 7.0.102 | Apache-2.0 |
| [dompurify](https://github.com/cure53/DOMPurify) | 3.4.17 | (MPL-2.0 OR Apache-2.0) |
| [fflate](https://101arrowz.github.io/fflate) | 0.8.3 | MIT |
| [hono](https://hono.dev) | 4.13.14 | MIT |
| [lucide-react](https://lucide.dev) | 1.49.0 | ISC |
| [marked](https://marked.js.org) | 18.0.14 | MIT |
| [pdfmake](http://pdfmake.org) | 0.3.11 | MIT |
| [qr-scanner](https://github.com/nimiq/qr-scanner#readme) | 1.4.2 | MIT |
| [react](https://react.dev/) | 19.3.0 | MIT |
| [react-dom](https://react.dev/) | 19.3.0 | MIT |
| [zod](https://zod.dev) | 4.6.7 | MIT |

### docs (apps/docs)

| Package | Version | Licence |
|---|---|---|
| [fumadocs-core](https://fumadocs.dev) | 16.15.11 | MIT |
| [fumadocs-mdx](https://fumadocs.dev) | 15.4.1 | MIT |
| [fumadocs-ui](https://fumadocs.dev) | 16.15.11 | MIT |
| [mermaid](https://github.com/mermaid-js/mermaid#readme) | 11.17.2 | MIT |
| [next](https://nextjs.org) | 16.4.1 | MIT |
| [next-themes](https://github.com/pacocoursey/next-themes#readme) | 0.4.6 | MIT |

### runtime (apps/runtime)

| Package | Version | Licence |
|---|---|---|
| [@ai-sdk/anthropic](https://ai-sdk.dev/docs) | 4.0.54 | Apache-2.0 |
| [@ai-sdk/elevenlabs](https://ai-sdk.dev/docs) | 3.0.42 | Apache-2.0 |
| [@ai-sdk/fal](https://ai-sdk.dev/docs) | 3.0.42 | Apache-2.0 |
| [@ai-sdk/gateway](https://ai-sdk.dev/docs) | 4.0.82 | Apache-2.0 |
| [@ai-sdk/google](https://ai-sdk.dev/docs) | 4.0.72 | Apache-2.0 |
| [@ai-sdk/openai](https://ai-sdk.dev/docs) | 4.0.67 | Apache-2.0 |
| [@ai-sdk/replicate](https://ai-sdk.dev/docs) | 3.0.42 | Apache-2.0 |
| [@clack/prompts](https://github.com/bombshell-dev/clack/tree/main/packages/prompts#readme) | 1.8.1 | MIT |
| [@executor-js/plugin-openapi](https://github.com/UsefulSoftwareCo/executor/tree/main/packages/plugins/openapi) | 1.6.10 | MIT |
| [@libsql/client](https://github.com/tursodatabase/libsql-client-ts#readme) | 0.18.0 | MIT |
| [@lydell/node-pty](https://github.com/lydell/node-pty#readme) | 1.1.0 | MIT |
| [@mastra/ai-sdk](https://mastra.ai) | 1.11.2 | Apache-2.0 |
| [@mastra/core](https://mastra.ai) | 1.80.0 | Apache-2.0 |
| [@mastra/docker](https://mastra.ai) | 0.12.1 | Apache-2.0 |
| [@mastra/libsql](https://mastra.ai) | 1.27.1 | Apache-2.0 |
| [@mastra/memory](https://mastra.ai) | 1.39.1 | Apache-2.0 |
| [@mastra/quickjs](https://mastra.ai) | 0.1.5 | Apache-2.0 |
| [@modelcontextprotocol/server](https://modelcontextprotocol.io) | 2.3.0 | Apache-2.0 |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas#readme) | 1.0.13 | MIT |
| [@turbodocx/html-to-docx](https://github.com/TurboDocx/html-to-docx#readme) | 1.23.1 | MIT |
| [aws4fetch](https://github.com/mhart/aws4fetch#readme) | 1.0.20 | MIT |
| [cross-spawn](https://github.com/moxystudio/node-cross-spawn) | 7.0.6 | MIT |
| [drizzle-orm](https://orm.drizzle.team) | 0.45.3 | Apache-2.0 |
| [effect](https://effect.website) | 4.0.0-beta.59 | MIT |
| [exceljs](https://github.com/exceljs/exceljs#readme) | 4.4.0 | MIT |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser#readme) | 5.11.2 | MIT |
| [imapflow](https://imapflow.com/) | 2.2.1 | MIT |
| [jiti](https://github.com/unjs/jiti#readme) | 2.7.0 | MIT |
| [jose](https://github.com/panva/jose) | 6.2.12 | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js#readme) | 1.13.0 | BSD-2-Clause |
| [nanoid](https://github.com/ai/nanoid#readme) | 6.0.2 | MIT |
| [nodemailer](https://nodemailer.com/) | 10.1.4 | MIT-0 |
| [pdf-parse](https://mehmet-kozan.github.io/pdf-parse/) | 2.4.5 | Apache-2.0 |
| [playwright-core](https://playwright.dev) | 1.63.0 | Apache-2.0 |
| [postal-mime](https://postal-mime.postalsys.com) | 4.0.8 | MIT-0 |
| [rfc6902](https://github.com/chbrown/rfc6902) | 5.3.0 | MIT |
| [turndown](https://github.com/mixmark-io/turndown#readme) | 7.2.4 | MIT |
| [undici](https://undici.nodejs.org) | 8.12.3 | MIT |

### studio (apps/web)

| Package | Version | Licence |
|---|---|---|
| [@ai-sdk/react](https://ai-sdk.dev/docs) | 4.0.105 | Apache-2.0 |
| [@base-ui/react](https://base-ui.com) | 1.9.0 | MIT |
| @codemirror/autocomplete | 6.20.3 | MIT |
| @codemirror/commands | 6.11.1 | MIT |
| [@codemirror/lang-json](https://github.com/codemirror/lang-json#readme) | 6.0.2 | MIT |
| @codemirror/lang-markdown | 6.5.2 | MIT |
| @codemirror/language | 6.13.1 | MIT |
| @codemirror/lint | 6.9.7 | MIT |
| @codemirror/search | 6.7.2 | MIT |
| @codemirror/state | 6.7.6 | MIT |
| @codemirror/view | 6.43.14 | MIT |
| [@dagrejs/dagre](https://github.com/dagrejs/dagre#readme) | 3.1.1 | MIT |
| [@floating-ui/dom](https://floating-ui.com) | 1.8.0 | MIT |
| @lezer/highlight | 1.2.5 | MIT |
| [@shadcn/react](https://ui.shadcn.com) | 0.3.1 | MIT |
| [@tanstack/react-query](https://tanstack.com/query) | 5.104.0 | MIT |
| [@tiptap/core](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/extension-bubble-menu](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/extension-image](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/extension-list](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/extension-table](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/extensions](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/pm](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/react](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/starter-kit](https://tiptap.dev) | 3.32.1 | MIT |
| [@tiptap/suggestion](https://tiptap.dev) | 3.32.1 | MIT |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/master#readme) | 0.11.0 | MIT |
| [@xterm/addon-web-links](https://github.com/xtermjs/xterm.js/tree/master#readme) | 0.12.0 | MIT |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js#readme) | 6.0.0 | MIT |
| [@xyflow/react](https://reactflow.dev) | 12.12.0 | MIT |
| [class-variance-authority](https://github.com/joe-bell/cva#readme) | 0.7.1 | Apache-2.0 |
| [cn](https://github.com/shadcn-ui/cn#readme) | 0.5.0 | MIT |
| [modern-screenshot](https://github.com/qq15725/modern-screenshot) | 4.7.0 | MIT |
| [pdfjs-dist](https://mozilla.github.io/pdf.js/) | 6.4.299 | Apache-2.0 |
| [react-router](https://github.com/remix-run/react-router#readme) | 8.5.1 | MIT |
| [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css#readme) | 1.4.0 | MIT |
| [uqr](https://github.com/unjs/uqr#readme) | 0.1.3 | MIT |
| [xlsx](https://sheetjs.com/) | 0.20.3 | Apache-2.0 |

### Development only

Used to build, check and test; not part of what people run:

| Package | Version | Licence |
|---|---|---|
| [@biomejs/biome](https://biomejs.dev) | 2.5.0 | MIT OR Apache-2.0 |
| [@microsoft/api-extractor](https://api-extractor.com) | 7.59.4 | MIT |
| [@openuidev/react-lang](https://openui.com) | 1.0.1 | MIT |
| [@tailwindcss/postcss](https://tailwindcss.com) | 4.3.3 | MIT |
| [@tailwindcss/vite](https://tailwindcss.com) | 4.3.3 | MIT |
| [@types/cross-spawn](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/cross-spawn) | 6.0.6 | MIT |
| [@types/mdx](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/mdx) | 2.0.14 | MIT |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) | 26.6.4 | MIT |
| [@types/nodemailer](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/nodemailer) | 8.0.2 | MIT |
| [@types/pdfmake](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pdfmake) | 0.3.3 | MIT |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react) | 19.3.0 | MIT |
| [@types/react-dom](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom) | 19.3.0 | MIT |
| [@types/turndown](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/turndown) | 5.0.6 | MIT |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#readme) | 6.1.1 | MIT |
| [ajv](https://ajv.js.org) | 8.20.0 | MIT |
| [concurrently](https://github.com/open-cli-tools/concurrently#readme) | 10.0.6 | MIT |
| [drizzle-kit](https://orm.drizzle.team) | 0.31.11 | MIT |
| [git-cliff](https://github.com/orhun/git-cliff#readme) | 2.14.2 | MIT OR Apache-2.0 |
| [jsdom](https://github.com/jsdom/jsdom#readme) | 30.1.3 | MIT |
| [postcss](https://postcss.org/) | 8.5.31 | MIT |
| [tailwindcss](https://tailwindcss.com) | 4.3.3 | MIT |
| [tsx](https://tsx.hirok.io) | 4.23.15 | MIT |
| [typescript](https://www.typescriptlang.org/) | 7.0.2 | Apache-2.0 |
| [vite](https://vite.dev) | 8.3.4 | MIT |
| [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile/tree/main/#readme) | 2.3.3 | MIT |
| [vitest](https://vitest.dev) | 5.0.5 | MIT |

<!-- /third-party -->
