# @engenty-wizards/runner

The components that draw a wizard's run: pages with their fields (camera, signature, location,
voice, files), the working state, reviews, surfaces, results and downloads. They take a
`RunSource` — the run's view and the commands a person gives — and know no server: the studio
drives them over a server-sent stream (`apps/web/src/runner/useRun.ts`), the WordPress plugin
over its own REST routes.

```ts
import { configureRunner, RunnerBody } from "@engenty-wizards/runner";

configureRunner({ lang: "de", runBase: (id) => `/api/runs/${id}`, withBase: (p) => p, asset: (p) => p, Mascot });
<RunnerBody run={source} />;
```

`@engenty-wizards/runner/check` reads a `.wizard` package and says whether it runs on its own
(`standaloneEntry`, from `@engenty-wizards/shared/fit`).

`pnpm --filter @engenty-wizards/runner build` writes `dist/`: the components as ES modules with
React external, and `runner.css` — the look of a wizard's page, every rule scoped to
`.engenty-runner`, for a host without Tailwind.

MIT, the modules of `@engenty-wizards/shared` it bundles included: the wizard format
(definition, fit, numbers, run, runner-texts, shape, store, surface, texts and the data-tables
columns) is `FSL-1.1-MIT OR MIT`
(packages/shared/LICENSE-MIT). The rest of engenty wizards is FSL-1.1-MIT.
