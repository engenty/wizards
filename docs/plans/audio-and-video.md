# Plan: audio and video in the search („Aufnahmen“)

Status: planned on 2026-11-08; nothing built. It continues step 9 („Later: audio and video“) of
`docs/plans/media-and-files.md` and replaces PR step 1 of `docs/plans/mlx-local-models.md` (its
switch `mediaSearch` and table `project_chunk` are old names: the switch for media is
`knowledgeMedia`, the table `space_chunk`). Measurements are from an Apple M4 on 2026-11-08, with
another VM using the CPU, so times are on the slow side.

A recording is a file of sound, with or without pictures: a voice memo, a podcast episode, a
screencast, a meeting, a product video. Today none of them can be found by what is said or shown.
Wissen refuses them as documents (`parseDocument` → `fileNotReadable`, the file is `failed`), Marke
indexes them by name and the description a person typed (#254), and Dateien skips them
(`status: "skipped"`; over 100 MB not even read).

## Goal

1. A recording is found by **what is said** (a transcript with times), **how it sounds** (the sound
   itself, embedded in 30 s windows) and, for a video, **what it shows** (frames).
2. A hit **opens the recording at its moment**, with the transcript beside the player.
3. Steps and Goose **read the transcript** like a document, with times.
4. Recordings come from uploads, folders on the computer, drives, **podcasts, YouTube, Zoom and
   Teams**.

## What is there today

| | Where | What it means for recordings |
|---|---|---|
| Units | `space_chunk` (`apps/runtime/src/db/schema.ts:635`) | Owner columns, `text`, `embedding`, `model`, `sheet` (a page), `kind` (`image` \| `page`). **No time.** About ten places read a non-null `kind` as "a picture" (`space-index.ts:145, 152, 172, 181, 494, 718, 807, 820, 1285, 1490`) |
| Times elsewhere | `space_mount_unit.start`/`end` (migration 0050) | Character offsets into extracted text, not seconds. `Found` carries `start`/`end`; for `space_chunk` they are `NULL` |
| Embedder | `models.ts` `embeddingModel()` | `embedImage` where Ollama reports `vision` (or the credits class `pictures: true`) and `knowledgeMedia` is on. Nothing reads the `audio` capability |
| Cloud embedding | Manage `gateway/ollama.ts`, `/v4/ai/picture-embedding` | engenty's own Ollama with EmbeddingGemma 2. `embedAt` forwards any `input` array; only pictures have a route |
| Transcription | `media/transcribe.ts` | `transcribeAudio` keeps `text` only and drops segments. `listenPieces` cuts at silences (12 s pieces, at most 120, ≈ 24 min) and times come from the cut, not the model |
| Transcription models | `models.ts` `listenerModel()` | Default `google/gemini-3.5-flash-lite` as a chat call. Own keys: ElevenLabs, fal, OpenAI. Manage: fal Whisper ($0.0001/s) and Scribe ($0.00011/s), both with segments (`gateway/fal.ts`, `gateway/elevenlabs.ts`). `LOCAL_JOBS` has no transcription job |
| Apple helper | `apple/Shared.swift:220` | `apple:transcribe` with `SpeechTranscriber` + `SpeechAnalyzer`, free, but returns `segments: []` |
| ffmpeg | `media/ffmpeg.ts` | `probeMedia`, `capVideo`, `toMp3`; WAV 16 kHz mono in `listenPieces`. Found on PATH or `FFMPEG_PATH`; the setup offers `brew install ffmpeg`; the cloud image installs it. Not in the npm package. No frame extraction |
| Delivery | `routes/delivery.ts:116` | Range requests (206) for `audio/*` and `video/*`, for Wissen and mount files |
| Players | `Assets.tsx:78`, `Files.tsx:105`, `file-preview.tsx` | `<video>`/`<audio>` in Marke and the runner. Wissen and Dateien viewers have no `audio`/`video` kind (`viewers-kind.ts`); nothing opens at a time |
| Sources | `PluginKnowledgeSource`, `PluginMountKind` | `PluginSourceRead` is `page \| document \| …`, no recording. No YouTube, RSS, Zoom or Teams kind. Microsoft connection has `Files.Read`, `Mail.Read`, `Calendars.Read`; there is no Zoom connection |
| Limits | `spaces.ts:628`, `app.ts:368`, `mounts.ts:61` | Asset 15 MB, video asset 80 MB, document 30 MB, request body 48 MB, mounts skip files over 100 MB |

## Measured

### Sound with EmbeddingGemma 2 (Ollama 0.40.14, MLX)

`POST /api/embed {"model":"embeddinggemma-2:740m","input":[{"audio":"<base64 WAV, 16 kHz mono>"}]}`.
A clip costs 25 tokens per second plus 4.

| Window | 5 s | 10 s | 20 s | 30 s | 60 s | 300 s |
|---|---|---|---|---|---|---|
| Time (German speech) | 0.29 s | 0.54 s | 1.2 s | 2.2 s | 5.5 s | 47 s |

- Longer than 30 s is accepted and not cut. The limit is the 8192-token context: about 327 s, then
  HTTP 413 (`num_ctx` is ignored on MLX). Time per second of sound grows with the window, so **30 s
  windows** are the efficient size. More clips per call is not faster.
- **Quality:** 10 German spoken passages (`say`), queries paraphrased without shared words, among
  23 passages: sound top-1 10/10 in German and English. The same passages' transcripts as text:
  top-1 9/10 German, 10/10 English, with larger margins (+0.09 against +0.06). Noise or music
  under the speech moves a vector little (cos 0.98–0.99 to the clean one).
- **Sound and text vectors must not be ranked together by cosine:** text scores higher across the
  board. In one mixed list a text was first for every query.
- **A long recording** (9.4 min, 30 s windows): without overlap a passage cut by a window edge fell
  to rank 10–16 (top-1 7–8/10); with a **15 s hop** top-1 9/10, top-3 10/10. Embedding: 2.8 min
  per hour of sound without overlap, **5.2 min with**.

### Frames

| Extraction from 1080p H.264, per hour of video | Time |
|---|---|
| Scene detection `select='gt(scene,0.3)'` | 7.0–7.5 min |
| `fps=1/10` | 3.2 min |
| `-skip_frame nokey` + `fps=1/10` | 1.2 min |
| One seek per frame (`-ss`) | 0.85 min |

A frame costs 268 tokens at any size (the model scales it), so 512 px is enough; about 1.2 s per
frame here (0.59 s measured on an idle M4). Text → frame on synthetic scenes: top-1 7/7.

### Transcription on this Mac (German, 248 s clean and 76 s with noise)

| Engine | Speed | Words right (clean / noise) | Ships how |
|---|---|---|---|
| **Apple SpeechTranscriber** (de-DE assets already on the Mac) | **25× realtime** | 98.0 % / 98.5 % | the `wizards-apple` helper we have |
| mlx-whisper large-v3-turbo | 2.6× (+10 s load) | 98.4 % / 99.0 % | Python and 1.6 GB of weights: no |
| whisper.cpp `whisper-cli`, medium | 3.3× | 86 % / 58 % (sentences dropped) | no |

### One hour on an M4, put together

| | Audio only | Video |
|---|---|---|
| Transcript (Apple) | 2.4 min | 2.4 min |
| Sound windows, 15 s hop | 5.2 min | 5.2 min |
| Frames, one per 10 s or per shot | – | 4–11 min |
| **Total** | **≈ 8 min** | **≈ 12–19 min** |
| Units | ≈ 240 windows + ≈ 120 transcript passages | + ≈ 360 frames |
| Vectors (3 KB each) | ≈ 1.1 MB | ≈ 2.2 MB |

Not measured yet: the GGUF build of the model that Linux and Windows run (Docker was off), the
VPS's CPU, and real recordings (several speakers, phone audio, music).

## What the sources allow

| Source | Transcript | Sound and frames | What decides it |
|---|---|---|---|
| Upload, folder on the computer, drives | ours | ours | the file is the person's |
| Podcast feed (RSS) | `podcast:transcript` where the feed has one (≈ 9 % of episodes), else ours | the enclosure is meant to be downloaded | the feed |
| Web page | `<track>` WebVTT where there is one | only where the site's terms allow | each site |
| **YouTube, own channel** | `captions.download` (OAuth `youtube.force-ssl`, only videos the person may edit, 200 of 10 000 quota units a day) | **no** | Developer Policies III.E.1: no download or cache of audio or video without written approval; III.I.7: never separate audio from video; API data refreshed or deleted within 30 days |
| **YouTube, other channels** | Gemini with the video's URL (public videos only, free tier 8 h a day) writes a timed transcript | **no** | as above. `youtube-transcript-api` and `yt-dlp` are blocked from cloud IPs and break the terms: not in the product |
| **Zoom** | `TRANSCRIPT` VTT with speaker names | `M4A`, `MP4` | Pro plan or higher with cloud recording and "audio transcript" on. Other companies' accounts only after Marketplace review (a private app: own account, up to 100 installs). API terms: no AI training, no "building databases" from Zoom data (legal read needed) |
| **Zoom, local recordings** | ours | ours | files in `~/Documents/Zoom`: a folder on the computer, which Dateien mounts today |
| **Teams** | `text/vtt` with `<v Speaker>` | MP4, organizer only | `OnlineMeetingTranscript.Read.All` and `OnlineMeetingRecording.Read.All` need admin consent even delegated. Since July 2026 the tenant switch "Transcript API access → Microsoft Graph" is off by default (`403 GraphAccessToTranscriptsDisabled`), speaker names a second switch. Recordings and transcripts expire after 120 days by default. No longer metered (since 2025-08-25) |
| **Teams, fallback** | ours | MP4 | the organizer's OneDrive folder `Recordings`, through the `Files.Read` mount we have; no admin needed |
| Google Meet | a Doc in Drive; entries deleted after 30 days | MP4 in Drive | Drive scopes for downloads are restricted (security assessment) |
| Vimeo, Wistia | text tracks for the owner | owner only | later |

## Design

### A recording becomes three kinds of units

| Unit | `kind` | Vector | Words (FTS) | Time |
|---|---|---|---|---|
| Transcript passage, ≈ 30 s, cut at segment ends | `null` (a text unit, as today) | text | the passage | `start_ms`, `end_ms` |
| Sound window, 30 s, every 15 s, silence skipped | `sound` | sound | the file's name and categories | `start_ms`, `end_ms` |
| Frame, one per 10 s, kept only when it differs from the last (8×8 average hash, as DigUp) | `frame` | picture | name and categories | `start_ms`; it lasts until the next frame |

- `space_chunk` gets `start_ms` and `end_ms` (integers, null for everything but recordings). A
  passage keeps its speaker in `heading` where the transcript names one.
- The places that read `kind` as "a picture" read it through one function: visual (`image`,
  `page`, `frame`), `sound`, or text. `pictureKey` uses the time instead of `sheet` for frames and
  windows; `ref` stays the file's hash, so a recording is embedded once while it is the same file.
- Without an embedder that takes sound, a recording gets transcript passages only. Without a
  transcript (no transcription available), it gets sound and frames only. Without ffmpeg, its name.

### Search

- **Each kind is ranked on its own and the lists are fused by rank**, as words and meaning are
  fused today. Raw cosines of sound, frames and text never meet (measured above). `MIN_LEAD` holds
  per kind.
- A recording shows once in the results, at its best moment, with up to two more moments under it.
- `KnowledgeHit` gets `at` and `until` (seconds) and `recording: "audio" | "video"`; `space_search`
  passes `at` and the passage's text to the model, so a step can say "at 12:40, Anna says …".
- `space_document` on a recording returns its transcript with times (`[12:40] Anna: …`).

### Preparing a recording

One background job per recording, after an upload, a mount's change or a source's read, behind the
text sweep and leaving the model room for searches (`leavingRoom`), as pictures do:

1. `probeMedia`: length, sound, size.
2. The sound once as 16 kHz mono WAV in `derived/<hash>/`; windows are cut from it in memory (one
   ffmpeg per window cost 12–15 s on 9 minutes).
3. The transcript (below), kept as `derived/<hash>/transcript.json` with segments, so it is paid
   for once, as `parsed/<sha256>.json` is for documents.
4. Frames with `-skip_frame nokey` or one seek per frame, 512 px JPEG, deduplicated.
5. Units written, vectors queued.

A recording over 3 hours is read in its first 3 hours and says so (DigUp stops at 1 200 frames).

### Transcription

A new local job `transcribe` in `LOCAL_JOBS`, and `transcribeTimed()` that returns segments
`{ start, end, text, speaker? }`:

| Where | Default | Why |
|---|---|---|
| Mac with macOS 26 | Apple `SpeechTranscriber` | 25× realtime, 98 % of German words, free, no download. `apple:transcribe` returns the result's time ranges instead of `segments: []` |
| Linux, Windows, older Mac | the credits class (or own key) | until a local engine is measured there (open point 3) |
| Cloud | Manage's transcription class with segments: Scribe (word times, speakers, $0.00011/s ≈ 79 credits an hour at markup 2) | fal Whisper ($0.0001/s) has no speakers; OpenAI's timed models (`whisper-1`, `-diarize`) shut down on 2027-02-26 |
| The source has one | Zoom and Teams VTT, a feed's `podcast:transcript`, a page's `<track>`, YouTube captions | no transcription, speakers included |

Long recordings go in pieces of at most 10 minutes, cut at silences (`listenPieces`' method), with
each piece's offset added to its segments.

### Sound embedding

- `ResolvedEmbedding` gets `embedSound(wav)`: on a computer where Ollama reports `audio`; in the
  cloud through `/v4/ai/sound-embedding` on engenty's Ollama (`embedAt` already forwards any
  input), once `/v1/models` says the embedding class takes sound (`sounds: true`).
- Pricing per second of sound, set after the VPS measurement (the token price, 25 tokens a second,
  rounds to nothing; the CPU time is the cost).
- `@engenty/search-index` `SearchEmbedder` gets `embedSound`, `search-libsql` `HitKind` gets
  `sound` and `frame`, so peer-it can follow.

### Player

- `viewers-kind.ts` gets `audio` and `video`: the player, and beside it the transcript, each line a
  link to its moment, the hit's lines marked.
- A hit opens `…#t=760`; `Place` gets `at`. Range delivery is there.
- YouTube hits open the official embed with `start` (no copy of the video exists).

### Sources

Recordings that another party owns are **Dateien mounts** (D1 of `media-and-files.md`): a pointer,
vectors, a word index, a thumbnail; the original stays where it is, and the units go when it goes
(a Teams recording expiring after 120 days drops out). Wissen takes a copy only through „In Wissen
übernehmen“.

| Mount kind | Lists by | New since the last read | Notes |
|---|---|---|---|
| Folder on the computer (core) | the folder | file watcher | covers Zoom's local recordings and any recorder app's folder |
| Google Drive, OneDrive, S3 (data-sourcer) | the drive | `changes` / `delta` | recordings read from the drive into `derived/` and deleted after preparing |
| Podcast (data-sourcer) | the feed's items | the feed, every few hours | the enclosure, the feed's transcript where there is one |
| YouTube (data-sourcer) | a channel, playlist or video URL | the Data API, every day | transcript only (captions for own channels, Gemini for others), metadata refreshed within 30 days, no bytes |
| Zoom (data-sourcer, new connection `connections-zoom`) | `GET /users/me/recordings`, one month per call | webhook `recording.transcript_completed` in the cloud; a poll on a computer | user-level OAuth, scopes `cloud_recording:read:list_user_recordings`, `cloud_recording:read:list_recording_files`; the VTT and the M4A, the MP4 for frames of shared screens |
| Teams (data-sourcer, Microsoft connection) | calendar events with a join URL → `onlineMeetings?$filter=JoinWebUrl eq …` → transcripts and recordings | subscription on `users/{id}/onlineMeetings/getAllTranscripts` (3 days, renewed) in the cloud; a poll on a computer | adds `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`; an admin page explains the two tenant switches; without them the mount falls back to the `Recordings` folder and our transcript |

`PluginSourceRead` and the mount reader get a recording result
`{ kind: "recording", name, mime, data | url, transcript?: Segment[], meta }`, so a kind that brings
its own transcript skips transcription.

### Open core and plans

| Core (open, every install) | Sources plugin `data-sourcer` (closed) |
|---|---|
| Units with times, the recording job, transcription per job, `embedSound`, the player | Podcast, YouTube, Zoom, Teams mount kinds and their connections |
| A folder on the computer as a mount (with recordings) | Drives' recordings |

Model work in the cloud runs on credits; on a computer's own Ollama and Apple's transcriber it is
free. Meetings carry other people's voices: deleting a mount or revoking a connection deletes its
units and `derived/` files.

## Steps

Behind a new release switch `recordings` („Aufnahmen in Wissen und Dateien“), in small PRs.

1. **Measure.** Ollama's GGUF build in Docker on Linux: does sound work, and how close are its
   vectors to the Mac's MLX build (one `model` value for both is the assumption, as
   `dateien-from-the-cloud.md` C3 assumes for text)? The VPS's CPU: sound windows and frames per
   minute. Three real recordings: a meeting with four voices, a phone voice memo, a podcast with
   music.
2. **Units with times.** `start_ms`/`end_ms`, the `kind` function, `KnowledgeHit.at`; no change in
   behaviour.
3. **Preparing recordings.** Probe, WAV in `derived/`, frames, the job; ffmpeg checked by
   `wizards setup` and status on every system, with a note in the studio when it is missing.
4. **Transcripts with times.** `transcribeTimed`, the `transcribe` job, Apple's time ranges,
   segments from Manage's class, pieces for long recordings; transcript passages in the index.
   Wissen accepts recordings as files.
5. **Sound and frames.** `embedSound` on a computer and through Manage; ranking per kind fused by
   rank; one hit per recording.
6. **The player.** Viewer kinds, opening at a moment, the transcript beside it; `space_search` and
   `space_document` with times; uploads of recordings past 48 MB in parts.
7. **Dateien.** Recordings in the folder mount and in drives.
8. **Podcasts and web pages.** The feed kind; `<track>` captions from `web.read`.
9. **Zoom.** The connection as a private app first (own account), the Marketplace review started
   the same week; the mount kind; the webhook in the cloud.
10. **Teams.** The meeting scopes, the admin page for consent and the two switches, the mount kind,
    the `Recordings` fallback.
11. **YouTube.** Own channels through captions; other channels through Gemini after the legal
    read (open point 4).

Later: Google Meet, Vimeo and Wistia, speakers in our own transcripts, text in frames (slides), an
LGPL ffmpeg of our own in the package, the libSQL vector index (an hour of video adds ≈ 720
vectors, so it is needed sooner than for pictures), the Swift MLX helper.

## Open points (the user decides)

1. The name: „Aufnahmen“ (recommended) for audio and video together, or „Audio und Video“.
2. Transcription in the cloud: Scribe through Manage (recommended: word times, speakers, already
   wired) or Gemini 3.5 Transcribe through the AI Gateway (≈ $0.005/min, speakers, transcription
   still in beta there).
3. Linux and Windows: credits for transcription (recommended for now), or a local engine
   (`sherpa-onnx-node` with Parakeet v3, CC BY 4.0, 25 European languages) after a measurement.
4. YouTube channels that aren't the person's: transcripts through Gemini by URL after a legal read
   (recommended), or own channels only.
5. Zoom, Teams, YouTube and podcasts as mount kinds of the sources plugin, as Pro (recommended,
   as drives in `media-and-files.md` open point 2), or in the core.
6. Mounted recordings keep their transcript as a file in `derived/` (recommended: it costs money
   to make again, and the result shows a line of it), or D3 holds strictly and the text is made
   again when needed.
7. How large a recording may be: 2 GB on a computer and 500 MB in the cloud (recommended), or
   other limits.
