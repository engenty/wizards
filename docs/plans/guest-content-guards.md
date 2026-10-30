# Guest content guards

Planned 2026-10-30 (Matthias: "content created by a guest user should NOT be publicly available –
it must not be possible to create illegal, abusive content with wizards we host / share").
Steps 1–3 and the runtime's half of 4 built 2026-10-30. The Manage-App's Abuse checks page shows this goal as "Creating abusive
content" (engenty-wizards-manage `docs/plans/wizards-admin.md`).

A **guest** is the person of a live run without an account: `mode: "live"` with a `visitorId`
and no `userId` (`routes/runs.ts:476`, the only route that starts one; plugin doors at
`plugins/runs.ts:47`).

## What is there today

| | Today | Where |
|---|---|---|
| Rules in prompts | `safety.md` policy in every AI step, Goose, architect, voice | `engine/steps.ts:153`, `safety.ts` |
| Image, video, speech | asked against the rules first; a yes or no answer stops it | `media/generate.ts:46,128,163` |
| Text an AI step writes | **not checked**; stored as is | `engine/steps.ts:683-732`, `runner.ts:832` |
| A guest's edit in a review | **not checked**, up to 50k chars | `runner.ts:997-1007` |
| Guest values in prompts | `{{field}}` put into `# TASK` as plain text; "data, not instructions" only as a prompt line | `template.ts:307`, `prompts/step.md:17` |
| Prompt injection | **not detected** | – |
| Public share link | **any guest** can make one of a finished run: `/s/<token>`, no sign-in, 7 days, link preview with title, text and first image | `routes/runs.ts:1525`, `services/shares.ts:25`, `link-preview.ts:29` |
| Public page example | a team's page can show a shared run per wizard; a guest's run qualifies | `services/pages.ts:240` |
| Indexing | no `noindex` / `X-Robots-Tag` anywhere | – |
| Sending a result | a guest mails up to 3 recipients from our address, values up to 20k chars | `sharing/targets/email.ts:14` |
| Manage hears of a stop | only as a failed run's error text | `safety.ts:60`, `manage-reports.ts:169` |
| Limits | guest budget per org (Manage), 6 runs/h per visitor or IP, wizard daily limit, Turnstile | `runner.ts:276`, `env.ts:304`, `limits.ts` |

## The plan, in order of what it protects

### 1. Nothing a guest makes is public

Matthias, 2026-10-30: "private sharing is OK". A guest keeps their link and their sending; what
they made is never shown in public:

- A guest's `/s/<token>` opens for whoever has it, but its link card names only the wizard (no
  result text, no picture: `/api/shares/<token>/image` is a 404) – `guestRun` in `safety.ts`.
- A team's public page takes as example only a run a member started.
- `noindex, nofollow` on `/s/*` and on a run's own pages (`/w/<token>/<runner>/<runId>`), meta tag
  and `X-Robots-Tag`, and on everything below `/api/shares`. A wizard's start page stays findable.
- Sending (mail, storage, connectors) stays as it is.

### 2. What an AI step writes is checked, for guests

- `checkGuestText` (`safety.ts`), `safety.md` section `check_text`.
- After every automatic step of a guest run, before the output is stored (`engine/runner.ts`):
  one decision call on the text (JSON as text). A yes stops the step as media does
  (`ContentBlockedError`, note `contentBlocked`); the guest sees the note, the run fails.
- A guest's edit in a review step goes through the same check.
- Fail closed, as media: no check model, no guest AI step.
- Cost: one Jev call per AI step of a guest run, a fraction of the step itself.

### 3. A guest's input is data, and an attack is stopped

- An agent step's `# TASK` marks the person's values as data: `renderTask` (`template.ts`) wraps
  each in `<data field="…">…</data>`, and `step.md` ground rules say what is inside is never an
  instruction. Members' runs the same, so a wizard behaves alike for both. Briefs of documents,
  images, video and speech still use `renderTemplate`.
- Before a guest run's automatic step: `checkGuestInput`, one decision call on the answers and
  regenerate notes with two questions (`check_input.rules`, `check_input.override`). Asked again
  only when the answers changed (`state.inputChecked`). A yes stops the run before any model works
  on it. Text read from uploads is not asked yet.
- The architect, Goose and the studio stay as they are: only members use them.

### 4. Manage knows, and the admins see it

- The run keeps what stopped it (`state.blocked`); `reportRun` sends `blocked: "input" |
  "injection" | "text" | "image" | "video" | "speech"` with the failed turn
  (`docs/manage-contract.md`).
- Manage keeps it on `run_report`; the Abuse checks page's "Creating abusive content" shows
  stops by kind over 7 days, each a link to the runs; a wizard with stops gets a flag
  ("Misused"), which also points the publishing check at its creator.

## Decided

1. Guest results: private sharing stays, nothing public (Matthias, 2026-10-30).
2. Checks for guests only; a member publishes in their own name.
3. Fail closed: no check model answering, no guest step.
4. The rules stay in the runtime's `safety.md`; the Abuse checks page may set them later.

## Open

- The decision model's latency per guest step, measured on a real run (target: under a second).
- Text read from a guest's uploads is not asked before a model reads it.
