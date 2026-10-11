# Motion-graphics wizards (HyperFrames × Opus 5.5)

Source: Julian Ivanov, "Claude Code ist unglaublich gut in Motion Graphics! (Opus 5.5)",
2026-10-01, https://www.youtube.com/watch?v=Vc0lLq3SVlw. Links in its description: Claude Code,
HyperFrames (github.com/heygen-com/hyperframes, Apache 2.0, by HeyGen), ElevenLabs, Pixabay
(royalty-free music), Excalidraw, n8n; a showcase spot on X (paywalled); the prompts sit behind a
newsletter sign-up (not read).

## What the video shows

Claude Code (Opus 5.5, effort high / extra high) writes HTML pages whose every frame is drawn
from code; HyperFrames renders them frame by frame to MP4. Every colour, timing and word stays
editable, a change costs tokens, not a new generation.

| Test | Input | Prompt essentials | Time |
|---|---|---|---|
| 1 Short from a raw recording | talking-head video | cut slips and pauses, hard cuts between camera layouts, graphics match what is said, research every claim and show logos / doc screenshots, captions, own sound | 15–20 min (high) |
| 2 Software commercial | website URL | adopt logo, font, colours; "the spot lives in the product's world"; 30 s; ElevenLabs voice; quiet Pixabay music | ~40 min |
| 3 Explainer | topic (phishing) | playful 2D figures drawn by the model, research official sources (BSI, Verbraucherzentrale), ElevenLabs voice, generated sound | ~60 min (extra high) |

Prompting advice from the video: give the goal, the references and your taste (look, audience,
captions) — not the how.

The HyperFrames skills (`product-launch-video`, `faceless-explainer`, `talking-head-recut`,
`embedded-captions`) are why the long runs work. Each one is a fixed pipeline with gates:
capture → design system (`frame.md`) → storyboard + script (user gate) → audio → visual design
per frame → one sub-agent per frame with a bounded packet → assemble → render. The orchestrator
plans with the big model; frame workers get only their packet. About 400 registry blocks
(`hyperframes catalog`, `hyperframes add`) cover named looks and effects.

## Conclusion

**The quality in the video comes from the model writing the film itself** — its own HTML,
animation and drawings per video, with the HyperFrames skills and blocks at hand. A fixed
template that a run only fills does not get there (first attempt below). Wizards need a step
that runs the installed client in a project folder of its own, with the skills, a shell and a
renderer. The split "prepare with the strong model, build lean" stays, but it applies to the
steps around that one, not to a template.

Such a run is the most expensive kind of wizard: about $18 of tokens for a 30-second spot, and
one Codex Plus subscription did not last for one run. Made from a showcase kit (below), a spot
took Sonnet 10 minutes and about $2.30.

## First attempt: a fixed motion kit (falls short)

Closed repo `engenty-wizards-manage`, branch `feat/motion-wizards`,
`apps/marketplace/entries/{talking-head-short,software-commercial,explainer-video}`, de + en,
status `unlisted`. All three share one kit in their workspace (`motion/motion.js`,
`motion.css`, `SCENES.md`): ten scene types, four looks, brand colours, captions, talking-head
layouts (full, split, pip), two sound effects. Groundwork steps run at class `high`, a
`standard` storyboard step fills one table row per scene, the film widget renders without a
model.

- **Short aus Rohaufnahme:** recording (`listen`) → cut (high) → review → research with browser
  screenshots (high) → storyboard → review → film → result.
- **Werbespot für Software:** URL → brand and product capture (high) → story and voice-over
  (high) → review → voice → storyboard → film → result.
- **Erklärvideo:** topic → research, official sources only (high) → script (high) → review →
  voice → storyboard → film → result.

Test runs on 2026-10-06 (local runtime, source Codex, voice over the gateway) all reached a
film:

| Wizard | Input | Run | Film |
|---|---|---|---|
| Short | 18 s synthetic recording, a false start, three pauses | 216 s | 12 s, 9:16; false start and pauses cut; Claude Code doc screenshots, the section marked while it is named |
| Commercial | excalidraw.com, Excalidraw+ 14 days free, 30 s | 652 s | 25 s; brand purple read from the site; app screenshots |
| Explainer | phishing, office staff, 45 s | 401 s | 46 s; character, comparison, marked e-mail, list, captions |

Matthias's verdict: "not even close" to the video. The reasons:

- The run fills slots; it cannot invent a look, a drawing or a motion the kit lacks. Every film
  looks like animated slides.
- The kit has fades and rises, hard cuts and system fonts; no transitions between scenes,
  camera moves, layered depth, kinetic type beyond words rising, or brand fonts.
- Nothing looks at the frames and fixes them.
- The storyboard ran at class `standard` with effort low on Codex, not Opus at high.

The kit stays useful for small, fixed films (a stills tour, an ad from stills); it is not the
path to motion design.

## Spikes: the client writes the film

Same brief as the video's Excalidraw+ test (30 s, 16:9, the product's own world, voice,
quiet music), run outside the wizards with the HyperFrames skills as files and the
`hyperframes` CLI 0.8.137. Voice offline with Kokoro, which has no German, so English.

| | Codex (`gpt-6-astra`, effort high) | Claude Code (Opus 5.5, effort high) |
|---|---|---|
| Result | 5 of 6 scenes, then the Codex Plus usage limit | the whole spot, 29.7 s |
| Time | 9 min until the limit | 45 min (the video: about 40) |
| Tokens | not reported | about $18 at API prices, on a Max subscription |
| Look | Excalifont, hand-drawn shapes, cursors, voice chat, text to diagram, presenting | the same, drawn with rough.js (the library Excalidraw renders with), the real logo, MusicGen music, pencil sounds |
| Self-check | snapshots planned | snapshots looked at; a scene handoff, an oversized cursor and a covered call to action fixed |

What the spikes showed about running it:

- **Both followed the HyperFrames pipeline on their own:** capture, `frame.md`, storyboard and
  script, audio, one scene at a time (Claude in parallel sub-agents), assembly, render.
- **Sandbox.** Inside Codex's own sandbox the renderer fails (`setpriority`, `uptime` refused).
  It worked with the agent kept in the sandbox and `hyperframes` commands run outside it by a
  small local service, limited to the project folder. Claude Code ran the renderer itself, with
  full shell access.
- **The render must not depend on the agent.** Claude started the final render in the
  background and exited; the render was cancelled with it. Re-rendered from the project
  afterwards: 19 s, no model.
- **Side effects.** Claude installed MusicGen with torch (about 1 GB) and a second Python venv in
  `/tmp`, because the long workspace path breaks the Kokoro phonemizer. Codex hit the same path
  problem. A wizard step must bring these engines or forbid installing them.
- **Sign-in.** The standalone Claude CLI needs `USER` in its environment to find its keychain
  sign-in. A runtime started from inside a Claude Code desktop session inherits that session's
  `CLAUDE_CODE_*` / `ANTHROPIC_*` variables and uses its connection instead — start it with a
  clean environment.

## Showcase first: the strong model sets the bar once

The video starts the same way: before any product, Claude makes "a 15-second motion graphics
video that shows what an incredibly good motion designer you are, as if applying for a job";
the commercials follow in the same chat with one sentence ("can we make some videos like this
for …"). The showcase is the quality bar and the vocabulary. Tested on 2026-10-06 as two runs,
outside the wizards, HyperFrames skills as files:

| | 1 · Showcase | 2 · Spot from the showcase |
|---|---|---|
| Brief | 15 s showreel, look "hand-drawn canvas", no brand, no product; leave a reusable kit | Excalidraw+, 15 s, 9:16, no voice; read the kit and the stored brand files, no new capture |
| Model | Opus 5.5, effort max | **Sonnet 5.5, effort medium** |
| Time | 82 min, 252 turns | **10 min**, 44 turns |
| Tokens (API prices, paid by Max) | ~$35 | **~$2.30** |
| Result | one camera take over a dot-grid board: a marker pen writes, sketches, connects, hatches, slaps sticky notes, grows a chart, closes with a highlighter line | idea → sketch → three cursors drawing live → "Text to diagram" → logo and call to action; the showcase's pen, strokes and sounds in Excalidraw's skin |

What run 1 left behind (the kit, about 2 MB without stills): `frame.md` (palette, type scale,
stroke widths and roughness, timing, easing, do/don't), `SHOWCASE.md` (each technique with its
time range in the reel, the function that makes it, when to use it), `assets/sketch.js` +
`sketch.css` (importable drawing helpers), baked handwriting, paper texture, fonts, `AUDIO.md`,
one still per technique (42 MB of stills — a wizard keeps three or four).

Findings:

- **Groundwork with the strong model, films with a cheap one works**: 1/15 of the cost, 8× faster,
  and the spot keeps the showcase's craft. This answers "prepare high, compose lean": the
  preparation is a showcase and a kit, not a template.
- **Audio from a catalog only** held in both runs: a local catalog of 410 files (391 soundcn
  sounds, CC0 by Kenney, ≤ 71 KB each, tagged; 19 HyperFrames sounds), `catalog.json` with tags
  and licence, a hard rule against generating, synthesizing or installing audio. The marker
  "foley" is catalog scratch sounds placed on every pen-down; HyperFrames mixes. Neither source
  has a music bed.
- **Run 2's 9:16 frame leaves the lower ~40 % empty**: the kit was made for 16:9 and Sonnet
  checked stills per scene but never played the final film. A kit needs rules per format, and the
  build step a last check of the whole film.
- **Export size**: the showcase MP4 is 56 MB for 15 s at HyperFrames' default quality, the spot
  12 MB; an export preset (CRF 23) brings the showcase to 8 MB.

Second use case, the explainer, the same way (2026-10-06), for engenty's own explainers:

| | 3 · Explainer showcase | 4 · engenty explainer from it |
|---|---|---|
| Brief | 20 s, "flat 2D illustrated explainer", no brand: character rig, one-eyed mascot, busy UI reduced to calm shapes, step flows; every colour from a `brand.json` shaped like the space brand (colours named by use, logos, fonts) | 45 s, 16:9, English; brand and material only from a `brand/` folder (brand.json from the landing's colours, logo, landing/gallery/studio/wizard screenshots, launch footage, README); engenties as the characters |
| Model | Opus 5.5, effort max | Sonnet 5.5, effort medium — plan, then film in the same session |
| Time / tokens | 94 min, ~$43 | plan 2 min ~$0.55; voice (platform speech model, per line, with durations) 30 s; film 28 min ~$5.35 |
| Result | 20 s; the theming proven with a dark and a light example brand; `frame.md` with 16:9 and 9:16 rules, `SHOWCASE.md` with 23 techniques and how to sync each to voice-over | 49 s; flat engenties in the brand's yellow, orange and violet, reduced studio and runner UI, real screenshots for a second as proof, timed to the nine voice lines |

- **The pipeline matches a wizard**: plan step (cheap) → voice step (platform) → build step
  resuming the same session. Sonnet re-timed every scene from the voice files' durations and
  word timings (`hyperframes transcribe`, no install).
- **The space brand is enough to theme a film** when the colour names say what each is for. Gaps it
  found: no green/red for done/problem, and a brand font (Geist) not available as a file — the
  brand needs font files, not only names.
- Sonnet checked the whole MP4 frame by frame this time (a rule added after run 2).
- The talking-head short still needs a real recording; not run yet.

Three levels follow, each made by the one above:

| Level | Made | Model | Kept |
|---|---|---|---|
| Showcase per look and use case | once, by the platform (Manage) | strongest, max effort | in the skill package as examples |
| Style kit per brand or series | once per project | strong, "like the showcase, for this brand" | with the project (brand colours, logo, fonts, `frame.md`) |
| Film | each run | cheap class | MP4 + project folder with the run |

## The film step (built, uncommitted)

A step kind next to `agent`: `{ type: "film", brief, skills, kit, inputs, format, seconds, model,
effort }` (`packages/shared/src/definition.ts`, runtime `apps/runtime/src/film/`).

- **Where it runs:** only on Claude Code installed and signed in as the AI subscription
  (`filmClient` in `models.ts`). Never on credits or keys, never in the cloud. The runner says so
  before a run starts (`missingModels`); the marketplace shows the capability "Films with Claude
  Code (on your subscription)" and counts about 25 minutes for the step (`effortOf`). Codex is
  left out for now: its sandbox blocks the renderer and its Plus quota lasted 9 minutes.
- **The folder:** `DATA_DIR/films/<run>/<step>/`, kept with the run and removed with its files:
  `BRIEF.md`, `CLAUDE.md`/`AGENTS.md` (the rules), `.claude/skills/` (skill packages),
  `showcase/` (the wizard's style kit, unpacked from a .zip in its workspace), `brand/`
  (`brand.json` from the space: name, about, colours named by use, facts, plus the logo files),
  `input/` (the run's material: voice, pictures, script JSON, uploads), `audio-catalog/`, and
  `film/` (the HyperFrames project, set up by the runtime with `hyperframes init` in the format).
- **Sandbox:** Claude Code's own sandbox — the shell writes only inside the folder and has no
  network; Read/Edit/Write are limited to the folder; no web tools. HyperFrames runs outside the
  sandbox through an MCP tool of the step (`hyperframes`, allow-listed subcommands, paths kept
  inside the folder): lint, check, snapshot, render, transcribe, keyframes, …
- **Skill packages:** platform packages fetched once at a pinned version (HyperFrames' 22 skills
  from GitHub at commit 6308727, Apache 2.0) or `skills/<name>` folders in the wizard's workspace.
- **Sounds:** a catalog built once in the data folder: 391 soundcn sounds (CC0, Kenney) plus
  HyperFrames' 19 effects, `catalog.json` with tags and licence. Generating audio is forbidden by
  the rules; voice comes from the run's voice step.
- **The render is the runtime's:** after the client ends, `hyperframes render … --crf 23`; the MP4
  is the step's asset (marked as AI-generated). HyperFrames itself is installed into the data
  folder on the first film (npm, pinned 0.8.137).
- **Resume and change:** the client's session id is kept in the folder. A run that stops (limit,
  crash, restart of the runtime) continues the same session on the next attempt — tested by
  accident when the runtime restarted mid-film. A review's "regenerate" note on a film step asks
  the client for that change in the existing code instead of starting over. New script or voice
  (a changed brief or inputs) starts a fresh folder.
- **Progress:** the step shows the client's current task from its own task list and when it
  looks at frames.

The explainer wizard (`engenty-wizards-manage`, `apps/marketplace/entries/explainer-video`, de +
en, unlisted) is the first on it: topic + material → research (high, web) → script (high) →
review → voice → film (9:16 or 16:9, standard, the explainer style kit as
`kit/explainer-kit.zip`, 3.7 MB) → review with change requests → result.

## Faster films: build once, compose per run (planned)

Today every run starts from the kit as a *bar to reach*: the client reads it, copies its helpers,
maps the brand and writes the whole film as code. Only HyperFrames, the skills and the sound
catalog are kept between runs.

**Measured** (local install v0.2.21, explainer wizard, 9:16, 34 s, Sonnet medium, 2026-10-06):

| Phase | Time | What happened |
|---|---|---|
| Folder setup | 1:15 | skills copied, kit unpacked, HyperFrames installed (first film only), `init` |
| Reading | 1:35 | BRIEF, input, `SHOWCASE.md`, `reel.js` and the kit's helpers read in pieces; transcribe (23 s) |
| Writing | 4:30 | one `film.js` of 46 KB (30 k output tokens) plus nine scene files — the scenes and their timing |
| Checking | 2:45 | 4 snapshots, 3 checks, a draft render; a fix for the brand (below) |
| Final render | < 0:10 | the runtime's |
| **Step** | **10:35** | |

The brand cost a round: the space's colours are named in German ("Primär (Logo & Text)",
"Hintergrund"), `theme.js` matches English role words, and the film came out black and white
until the client renamed them in its copy. Every run in this space would pay that again.

### 1. The template ships a base project

The kit becomes a ready HyperFrames project instead of a showcase to imitate:

- `base/` in the kit zip: `index.html` with the theme started, `assets/` (theme, kit, ui,
  character, mascot, type, flow, camera — today's helpers, unchanged), fonts, and **scene
  templates** for the explainer's beats: problem (busy UI), the person, the helper arrives, product
  UI simplified, flow/steps, result, sign-off with logo and recap. Each is a function
  `scene(tl, root, { lines, words, text, picture })` that times itself to the voice line it gets.
- `PARTS.md` (one page) instead of `SHOWCASE.md` as the first read: the scene templates, their
  options, and when a new scene is worth writing. `SHOWCASE.md` and the stills stay for scenes
  the templates do not cover.
- The runtime copies `base/` into `film/` (instead of `hyperframes init`) and writes
  `film/timing.json` from the voice (lines and words, transcribed once by the runtime, not the
  client).
- The client's task becomes: pick a template per beat, fill text and pictures, write only what is
  new. The rules say so; a film that only uses templates is fine.
- Made once with Opus max from the explainer kit (about an hour); the kit zip grows from 3.7 MB
  by little (code, no renders).

Changes: `prepareFilmFolder` (base instead of init, `timing.json`), `CLAUDE.md` rules, kit
format documented in the authoring guide (`base/`, `PARTS.md`), the explainer entry's kit.

### 2. A brand base per space

What depends only on the space's brand is made once and kept:

- `brand/theme.json`: the space's colours mapped to the kit's roles (accent, background, ink,
  surfaces, on-accent), with text-safe variants and fonts — decided once by the client (it
  understands "Primär", "Hintergrund"), checked by a snapshot, then fixed.
- The logo prepared for the sign-off (SVG cleaned, light/dark variants) and the mascot in the
  brand's colours.
- Kept with the project's files under `films/brand-base/<kit>/`, keyed by a hash of brand.json
  plus the kit's version; a changed brand or kit makes it again. The first film in a space pays
  1–2 minutes for it as a small turn of its own before the film; later films copy it.

Changes: a `brandBase` turn in `runFilmStep` before the film turn, storage next to the project's
brand, `theme.js` reads `theme.json` first and its name matching stays the fallback.

### 3. The second format from the first

`film16` today is a second film from scratch. Instead it starts from the first film's folder:

- A film step may name `from: "steps.film"`: its folder is a copy of that step's `film/` (code,
  assets, timing), resized with HyperFrames' format, and the client's task is "lay this out for
  16:9" — the scenes, timing and sound stay.
- When the first film is not there (the branch skipped it), the step makes its film as today.

In the explainer the branch becomes: always the 9:16 film, then 16:9 from it when asked — or the
person picks one format and the other is offered at the end.

Changes: `from` in `filmStepSchema` (a film step earlier in the flow), `prepareFilmFolder`
copies, the explainer entry's flow.

### Expected

| | Today | With 1–3 |
|---|---|---|
| First film in a space | 10–15 min | 6–9 min (brand base included) |
| Next films | 10–15 min | 4–7 min |
| Second format | 10–15 min | 2–4 min |

Writing drops the most (templates instead of 46 KB of new code), reading by a minute, the brand
round goes away. Checking stays — it is what keeps the film clean.

## Runtime changes made (open repo, uncommitted)

Made for the first attempt; all stay useful:

- File field `listen`: a recording is listened to before the next step — pauses found with
  ffmpeg `silencedetect`, each piece written down by the audio class in its own call (four at a
  time; several pieces in one call shifted words between pieces), times exact because they come
  from the recording. `{{field.speech}}` gives `[12.40–15.10] text` lines; kept in
  `RunState.heard`.
- Film audio tracks take `from` (second of the source), up to 48 tracks: a recording cut into
  pieces plays one track per piece, with 30 ms fades at the cuts.
- Films mix sounds from the wizard's workspace (`wizard.url`, data URLs).
- Widget data `steps.<agentStep>.assets` gives the pictures an agent step kept (browser
  screenshots, export_file, generate_image) as `{ assetId: URL }`.
- A voice step's `style` is a template (`{{voiceStyle}}, natural pace`).
- A review no longer shows a step the run skipped (a branch).

## What the framework is missing

### Skills (tenant and platform)

Today: no skills anywhere a wizard can use. The harness starts Claude Code with
`--setting-sources "" --disable-slash-commands` and Codex with `--ignore-user-config`, so even
installed skills stay out (`harness/claude.ts`, `harness/codex.ts`).

The spikes show skills are needed **at run time**, by the step that builds the film: both
clients read the HyperFrames skills and followed them. Proposal:

- A skill package is a folder with a `SKILL.md` and its references, a source, a licence and a
  version. The step names the packages it needs (`skills: ["hyperframes"]`); the runtime puts
  them into the project folder as files. Files, not client-native skills, so Claude Code and
  Codex read them the same way.
- **Tenant:** Settings → Skills lists the installed packages; a project uses them.
- **Platform (Manage):** a catalog of approved packages (source, licence, version, hash),
  enabled per tenant like plugins.
- The architect writing a wizard reads the same packages.

Open question for Matthias: own skills from any git URL in the open studio, or catalog only.

### Model class, effort, pinning, fallback

Today: a step names a class (`classifier`, `standard`, `high`, `highest`) and an effort (low,
medium, high); the source binds it (`models.ts`). This keeps wizards vendor-neutral. Gaps:

- **Effort tops at high.** The video used extra high. Proposal: add `max`, mapped to Claude
  `--effort max` and Codex `model_reasoning_effort="xhigh"`; elsewhere `high`.
- **Codex has no step between standard and high**: both are `gpt-6.1-sol`
  (`harness/codex.ts`), so a cheaper class saves nothing on Codex except effort.
- **No preferred model.** Proposal: `prefer: ["anthropic/claude-opus-5-5"]` on a step as a hint
  — used when the source can serve it, otherwise the class binding. The class stays the
  contract, so GPT users still run the wizard. The spikes give a reason: Opus finished the spot,
  Codex at its highest class ran out first.
- **No fallback between sources.** During the tests the installed Claude Code was not signed in
  and every step failed; switching the source to Codex fixed it. Proposal: an ordered list of
  sources (the setup already keeps `setup-done`), the next one on a sign-in or quota error, the
  run's log says which one answered.
- No class or effort default per wizard; every step repeats it.

### Marking wizards that belong on a subscription

Today: a call on an installed client costs 0 credits (`costOf`); the marketplace derives a cost
tier (`costTierOf`); `credits/estimate.ts` estimates per step. Nothing tells the person "run
this on your subscription" or warns before publishing a heavy wizard to the cloud.

Measured: one 30-second spot is about $18 of tokens and 45 minutes; a Codex Plus subscription
stopped after 9 minutes. Proposal, derived, never authored:

- A wizard is **heavy** when it has a build step or its estimate is above a threshold.
- Local studio: "runs on your subscription — 0 credits, about N minutes; may use up a smaller
  plan" next to the test run button.
- Share dialog / sync to the cloud: "a run costs about N credits there"; under Free the cloud
  copy of a heavy wizard runs only for the owner, or not at all (tiers are not decided — see the
  subscription outline).
- Marketplace: show "best on a subscription" next to the cost tier.

### Reusing groundwork between runs

Today: no step output is reused across runs; the project keeps brand (name, colours, logos) and
facts, lists and kept files persist per wizard and person. The commercial captures the same
website again on every run.

For films see "Faster films" above (brand base per space). Otherwise:
the capture and `frame.md` of a brand are kept with the project and reused while the
website has not changed — a "brand kit" run done once, read by every film. A `project_write`
tool (confirmed by the person) or `keep` on a step (reuse its output while the same inputs
repeat, with an age limit).

### Smaller gaps

- Video uploads stop at 40 MB (`routes/delivery.ts`); a one-minute 1080p phone clip is larger.
- Film widgets stop at 60 s and 25 fps (`widgets/render.ts`); a widget step has one fixed size,
  so 9:16 and 16:9 need two steps and a branch.
- No word timings from the voice step.
- No music library: music is the person's own upload (Pixabay, as in the video). Sound effects
  can come from soundcn (MIT code, CC0 sounds, `soundcn.xyz/r/registry.json`); it has no music,
  no typing and no pencil sounds.
- Kokoro, HyperFrames' offline voice, has no German.
- Long agent steps show no progress until the client answers; there is no per-step timeout.
