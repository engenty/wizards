# Plan: a wizard in the viewer's own language, on request

Status: agreed and built on 2026-10-15 (branch `claude/eloquent-sanderson-f2cac1`, not released).

Scope: the public runner (`/w/<token>`, steps and chat). The studio's own languages stay as they
are (`LANGS`, the string tables of v0.5.8).

## What the viewer sees

- A wizard opens in its own language, always: `wizardLang(def)`.
- Where the viewer's own language differs, the page shows a switch beside the theme toggle: the
  same two-sided pill as `LangSwitch` (`apps/web/src/studio/LangSwitch.tsx`), tone `ground` on
  the wizard's colour. One side is the wizard's own language, the other the viewer's; the lit
  side is named in full on the white thumb, the other side shows its code ("EN · Italiano").
  Reference: the Onboarding frame of https://claude.ai/artifact/NHTFhd1bx1uf1SbzwJ5zdn. The
  pill takes any two languages, not only `en` and the person's own, and is shared with the
  studio's switch rather than copied. The viewer's language is read like
  the studio reads it (browser languages, then the time zone's country), but it may be any
  language, not only one of `LANGS` (`viewerLang`, below).
- The pick is kept in this browser for every wizard: someone who switched to their language once
  gets the next wizard translated too, and someone who switched back keeps the originals.
- The first switch into a language shows "Translating …" in place of the start screen for a few
  seconds. Later viewers get the stored translation at once.
- A translated page says so under the title: "Machine-translated · Show original". A translation
  the author wrote or corrected by hand says only "Show original".
- The runner's own words (buttons, notes, errors) speak the same language as the wizard's texts,
  so a page never mixes two languages.

## What is translated, and what never is

| Translated | Never translated |
|---|---|
| wizard `title`, `description`, `intro` | ids, `next`, `when`, `ask`, `group` statements |
| step `title`, `description`, `cta`, `working`, result `message` | AI-step `instructions`, `prompt`, `brief`, field groups' `instructions` |
| field `label`, `help`, `placeholder`, item column `label` | the values of `options` (only how they are shown, below) |
| the labels of `options` of select / multiselect / radio fields | `slot` options (dates, the runner writes them in the language) |
| list `title`, `description`, column `name`, select column option `label` | `{{…}}` placeholders, `{name}` gaps, URLs, numbers, currency codes |
| connection `title`, `description` | surface components, widget code, outputs already made |
| deliverable `label` | |

- A choice keeps its value: the person sees "Fish", the answer holds "Fisch", every `when`,
  branch and template still compares with "Fisch". The run view carries the shown labels beside
  the step (`labels: { [value]: label }`), and the runner shows `labels[value] ?? value`.
- The translated texts are written into a copy of the definition, which passes `wizardSchema` and
  `validateWizard` like the original, and each string keeps exactly the `{{…}}` and `{…}` of its
  original. A translation that fails either is not stored; the page stays in the original and
  says "This wizard can't be translated right now."

## How a translation is made and kept

- One structured call per wizard and language: the visible texts as `{ path: text }`, the answer
  the same keys (`Output.object` with every key required). Measured below.
- Kept per wizard and language as a memory of `original text → translated text`, each entry
  marked `machine` or `author`, in a new tenant table `wizard_translation`
  (`wizard_id`, `lang`, `texts` JSON, `version` last completed, `updated_at`).
- Publishing again changes nothing at once. The next viewer in that language finds the texts of
  the new version that the memory lacks and only those go to the model; entries an author wrote
  stay as long as their original text is unchanged.
- A run started on an older version reads the same memory; texts it lacks are translated the
  same way.
- Two viewers at the same moment share one call (one pending promise per wizard and language).
- The call runs on the wizard owner's models, as a step would, and is booked to the owner by the
  model-gateway like any call of the tenant. A local install translates on its own way to a model.

## The runner's own words in any language

- `en` and `de` have their written tables and need no call.
- Any other language: the runner's table and the run notes (`RUN_NOTES`, 244 lines) are
  translated once per language for the whole runtime, kept in the control database
  (`ui_translation`: `lang`, `source`, `texts`), and served at
  `GET /api/public/wizards/:token/texts/:lang` (the token says whose credits pay the first time).
  A changed English table (another hash) is translated again on the next request.
- The runner's table moved to `packages/shared/src/runner-texts.ts` so the runtime reads its
  English; the 57 lines of the studio table the public runner pages used (`chat.*`, `talk.*`,
  `video.*`, `install.*`, …) moved into it, about 230 lines now.
- Plural lines are sent once per plural category of that language
  (`Intl.PluralRules(lang).resolvedOptions().pluralCategories`) and come back as a `Plural`.
- Sent as four calls in parallel of about a hundred lines each: one call for all 470 lines took
  30–40 s, a quarter of it about 10 s. The wizard's own texts arrive first; the switch waits until
  both are there, so the page turns in one go.
- Booked like the wizard's texts, to the owner of the wizard whose viewer asked first. About half
  a cent, once per language and runtime.
- The runner gets an extra table for a language outside `LANGS`: `setRunnerTable(lang, lines)` in
  `packages/runner/src/i18n.ts`, and the same on the studio side for the runner pages only.
  `lineText` reads such a table with the plural rules of any locale (`shared/texts`); the
  studio's `t()` reads it too while a runner page shows (`showLang`, which never touches the
  person's own pick).

## Runs in a translated wizard

- `run.lang` (new column, null = the wizard's language) holds the language the viewer reads.
  The run starts with the viewer's pick; switching during a run sets it from then on.
- Every AI step of such a run gets one more ground rule: "Write everything the person reads in
  French." in place of "the language the person wrote their answers in".
- A step's "working" line is the wizard's own text and shows translated; the run's notes come
  from the translated notes table.
- An AI step's output field descriptions (the headings a review shows) are translated in the
  view; the step itself still gets the original.
- What is already made stays as it is when someone switches mid-run. On the result step a
  finished text output offers "Translate", which translates the text outputs of the shown steps
  once and keeps them on the run (`state.translated[lang][stepId]`); "Show original" goes back.

## The author's controls

- Studio, wizard → Share: a switch "Offer a translation" (on by default), column
  `wizard.translate`. Off: the page shows no switch and the public routes refuse a translation.
- Below it, the stored languages, each with "Edit": the original and the translation side by
  side, every line editable. Saving marks the edited lines `author`. "Delete" removes the
  language; the next viewer gets a fresh machine translation.

## The model, measured

Two starters from the marketplace (`invoice` de, 35 texts; `menu-plan` en, 64 texts), into
English and German (checked against the starters' own human translations) and into French and
Italian. One structured call each, through the AI Gateway, prices of the gateway's list
(USD per wizard and language).

| Model | invoice de→en | menu-plan en→de | invoice de→fr | menu-plan en→it | Quality |
|---|---|---|---|---|---|
| `openai/gpt-6-luna`, effort low (the `standard` class today) | $0.00041 · 1110 in / 607 out | $0.00075 · 1947 / 1120 | $0.00044 | $0.00079 | close to the human texts; one Italian line in the plural "voi" |
| `mistral/mistral-small` | $0.00041 | $0.00082 | $0.00046 | $0.00085 | good; Italian "working" lines turn into nouns ("Creazione … in corso") |
| `openai/gpt-oss-20b` | $0.00022 | $0.00042 | $0.00018 | $0.00034 | **wrong meaning**: "berücksichtigt Feiertage nicht" for "leaves out public holidays", broken grammar |
| `anthropic/claude-haiku-5.5` | $0.00061 | $0.00127 | $0.00064 | $0.00122 | as good as luna, the best Italian |
| `openai/gpt-5.4-nano`, effort none | $0.00078 | $0.00160 | $0.00084 | $0.00163 | good, dearer |
| `deepseek/deepseek-v4-flash` | $0.00086 | $0.00162 | $0.00083 | $0.00150 | thinks 2,000–4,000 tokens per call |
| `alibaba/qwen3.7-flash` | $0.00067 | $0.00092 | $0.00103 | $0.00100 | thinks 4,000–7,000 tokens, 45–85 s |
| `google/gemini-3.5-flash-lite` | $0.00210 | $0.00411 | $0.00222 | $0.00424 | good, five times the price |

Every model returned every key and kept every placeholder.

The runner's own table with luna: 174 lines into French $0.0018 (3,845 in / 2,744 out), into
Polish $0.0020 with its four plural forms right; the 244 run notes into French $0.0031.

**Pick: the `standard` class at effort low.** It is luna today, the cheapest model that translates
without mistakes, and it needs nothing new in the model-gateway: no new class, no binding. Should
`standard` be bound to a dearer model later, a translation costs that model's price; Haiku 5.5
would be the alternative at about 1.5×. Not used: `classifier` (the decision model), `high`,
`highest`, and the batch prices (half, but hours late).

What it costs:

| What | When | Cost |
|---|---|---|
| a wizard into one language | first viewer in that language, then only texts a new version changed | $0.0004–0.0008 |
| the runner's words into one language outside `en`/`de` | once per runtime and language, again when the English tables change | about $0.005 |
| a viewer | never | nothing, the stored translation is read |

The prompt asks for one person addressed in the singular, so luna's "voi" goes away.

## Also in this change

- "The wizard doesn't match the schema." (`apps/runtime/src/services/wizards.ts`, `parseDraft`)
  goes through the runtime's string table (`apps/runtime/src/texts.ts`), English and German.

## Not in this change

- Translating the studio, the mails or the site into more languages.
- Speech in the live conversation and voice notes in a language outside `LANGS`
  (`SPEECH_LOCALES`): a translated wizard still talks in its own language.
- Widgets and surfaces: their fixed text stays in the original.
- Output already made, beyond the "Translate" of a finished result.

## Checks

- Unit: the texts of a definition and writing them back (`shared`), placeholders kept, validation
  of the translated copy, the memory reused after a republish, plural tables of any locale.
- Browser: an English wizard in a German browser, a German wizard in an English browser, and a
  wizard in a French browser (runner words in French too), each started, switched mid-run and
  run to the result.
