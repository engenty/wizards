# Plan: Apple's local models

Status: Mac and phone built on 2026-10-10 (this branch). Written on 2026-10-10, after an
investigation of MLX and the Foundation Models framework.

Scope: the models Apple keeps on a device — the Foundation Models framework behind Apple
Intelligence (macOS 26, iOS 26) — as a way for wizards to think, only on devices that have them.
Open-weight models through MLX on a phone are out: 1–5 GB downloads, 8 GB phones only, no
simulator, small single-maintainer wrappers. On a Mac, MLX is already there through Ollama 0.19+.

## What a wizard can get from Apple

| Framework | Capability | Fits |
|---|---|---|
| Foundation Models, `SystemLanguageModel.default` | Text | Classifier, Standard. 4,096 tokens for prompt and answer together; guided generation keeps to a schema; no tools over the runtime's bridge |
| Foundation Models, `useCase: .contentTagging` | Text | Classifier: tagging, extraction |
| SpeechAnalyzer (macOS 26, iOS 26) | Voice notes | transcription on the device: `apple:transcribe` on the Mac, the app's `transcribe` on the phone |
| NLContextualEmbedding | Wissen search | 512-dim vectors — not built |

Devices: Apple Intelligence — a Mac with Apple silicon, iPhone 15 Pro, iPhone 16 and later,
iPhone Air, iPad with M1 or A17 Pro; Apple Intelligence switched on; 16 languages incl. German.

## The Mac (built)

The runtime runs on the Mac, so Apple's model is one more way beside an installed client, a
key and Ollama:

| | Where |
|---|---|
| `wizards-apple`: a Swift helper, one process per call — `status`, `generate` with a JSON schema turned into a `DynamicGenerationSchema`, `transcribe` (SpeechAnalyzer) | `apps/runtime/apple/main.swift` + `Shared.swift` (the code the app's module runs as well), built by `apps/runtime/scripts/build-apple.mjs` into `dist/apple/` |
| The models: `apple:default`, `apple:tagging` (text; the harness base runs it like a client, tools become warnings), `apple:transcribe` (voice notes, nothing paid) | `apps/runtime/src/harness/apple.ts` |
| Where a class runs: `apple` is a local provider; the availability and its reason in `GET /api/studio/models` (`apple`) | `apps/runtime/src/models.ts` |
| The choice "Apple Intelligence" under Text & reasoning (binds Classifier and Standard, enabled once Apple Intelligence answers) and under Voice notes (binds `audio`), shown only where the machine supports it; the same choice on the first-start setup | `apps/web/src/studio/Models.tsx`, `SetupPage.tsx` |
| The release: a `macos-26` job builds the helper, the package made on Linux takes it in | `.github/workflows/release.yml`, `scripts/npm-package.mjs --apple` |

Measured on an M-series Mac on macOS 26.5: 1.3 s for the first answer of a process, 0.4–0.7 s
after that, a guided JSON answer in about 1 s; six calls in a row without a rate limit. Apple
rate-limits command-line tools under load; `rateLimited` comes back as "try again shortly".

Not built on the Mac: embeddings, image input (macOS 27), the Private Cloud Compute model.
A guided call without instructions is refused by the model as "likely unsafe"; the shared code
sends a default instruction where a call brings none.

## The phone (built)

The app runs wizards in the runtime's runner (a WebView); the steps think on the runtime. The
phone's models answer what the runtime hands them through the bridge (the apps repo engenty-wizards-apps, `mobile/src/bridge`),
for a run open in the app. Worth it for cloud runs — nothing paid, the text stays on the phone.

| | Where |
|---|---|
| The Expo module `AppleIntelligence`: `status`, `generate`, `transcribe` — a copy of the Mac helper's `Shared.swift` (keep the two the same), weak-linked frameworks, nothing before iOS 26 | engenty-wizards-apps: `mobile/modules/apple-intelligence/` |
| Two bridge abilities, named to a page only where the phone has them: `transcribe` on iOS 26, `think` once Apple Intelligence answers (`appAbilities`) | engenty-wizards-apps: `mobile/src/bridge/{script,handle}.ts`, `mobile/src/app/run.tsx` |
| The runner: a recording is written down by the phone before the field keeps it (the server then skips its own transcription); on every connect of the run's stream it offers the phone for Classifier and Standard (`POST /api/runs/:id/device`), answers `device` events through `think`, and posts the answer | `apps/web/src/runner/{phone.ts,voice.tsx,useRun.ts}`, `lib/app.ts` |
| The runtime: a run's device as a model first — `DeviceModel` wraps the class's own model, asks over the stream, falls back when the phone does not answer in 60 s, errs, the prompt is over 12k characters, or the call needs tools the step declared or has uploads to read | `apps/runtime/src/engine/device.ts`, `events.ts`, `routes/runs.ts`, `models.ts` (`textModel`, `attachTools`) |

Checked end to end on the Mac with spoken audio and no bridge at all: headless Chrome with a
spoken WAV as its microphone records a voice note (WebM, which ffmpeg turns into WAV for
SpeechAnalyzer), the Mac writes it down in the runner's language ("Bitte ruf den Kunden morgen um
10:00 Uhr zurück. Die Rechnung vom März ist auch noch offen."), and Apple's model thinks the
Classifier and Standard steps from it — the answer on the result page is about that call and
that invoice. The note carries the runner's language (`AudioValue.lang`), since SpeechAnalyzer
listens in one language. Checked in headless Chrome with a fake bridge (record, phone transcript
shown, the standard step's text from the phone on the result page), and on the iOS simulator with
the real app: on the iOS 26.5 runtime (the host's own version) Apple's model answered the run's Standard
step on the phone — the runtime logged "the device answered a 78-character call" and that text
is the result. On the iOS 26.2 runtime the same call failed with `ModelManagerError 1026` (a
known simulator version mismatch) and the runtime fell back as designed. Neither simulator
holds speech assets ("not subscribed to transcription.de" in its log) and their microphone
records silence, so on-device transcription is verified on the Mac, which runs the same
`Shared.swift` (the studio's "Try it" for Voice notes answers through it). Android has no
counterpart yet: ML Kit's Prompt API (Gemini Nano) is a beta on few devices; the bridge offers
nothing there and the runner keeps its web way.

Not built: a decision step that has uploads runs as an agent with the generic tools and stays
on the runtime; the voice note's locale is the app's language, not detected.
