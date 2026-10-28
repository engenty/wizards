# Plan: local models through MLX

Status: investigation only, written on 2026-10-28 against main at #256 (v0.11.13), with the
measurements of the same day on a base M4 with 32 GB and Ollama 0.40.12. Nothing built. Follows
[Apple's local models](local-models-apple.md), which left MLX on a Mac to Ollama.

Scope: whether the runtime on a Mac can run open-weight models through Apple's MLX — first the
embedding model of the Knowledge search (EmbeddingGemma 2, text, images and sound in one
768-dim space), then the text classes and the decision model — and through which process.

## Recommendation

Stay on Ollama. It already runs our default embedding model on MLX, with images and sound, so
there is no change of model and no new engine for it. Build media search (`mediaSearch`) on
`/api/embed`. A direct MLX route would only spare a person the Ollama app; keep that as a later
option, as a Swift helper, never as a Python worker.

1. **Ollama is MLX already.** Since Ollama 0.40 a model whose files are safetensors runs on MLX
   on Apple silicon. On the M4, `ollama pull embeddinggemma-2:740m` (`LOCAL_EMBEDDING_MODEL`,
   unchanged) gave `runner: mlx`, `format: safetensors`, `quantization: nvfp4`,
   `capabilities: [embedding, vision, audio]`, 1.27 GB loaded, 8k context. Ollama picks the MLX
   build of the tag for the machine: a plain registry read of the same tag returns the GGUF build
   (304 MB model + 981 MB projector), which other machines run on llama.cpp.
2. **Images and sound work there.** `/api/embed` takes them as list entries (shapes below); the
   vectors share the text's space well enough for search (Quality).
3. **MLX without Ollama gains no speed worth a second engine.** The model's time is MLX's
   either way; going direct saves only the HTTP hop. What it would save is the Ollama app, which
   the setup installs today anyway (`apps/runtime/src/cli/ollama.ts`), and which the text
   classes and Clef-flash need regardless.
4. **If the Ollama app is to go, Swift beats Python.** `mlx-swift-lm` has a full
   EmbeddingGemma 2 (text, image, audio, video, interleaved) since 2026-10-12 (#684). It builds
   beside `wizards-apple` in the `macos-26` release job and adds no runtime dependency. The
   Python route (`mlx-vlm` 0.7.10) works too but brings a Python, a venv of several hundred MB
   and pins on fast-moving packages into `~/.engenty/wizards`.

## Measured on the M4 (Ollama 0.40.12, `embeddinggemma-2:740m`, MLX nvfp4)

Request shapes on `POST /api/embed`:

| Input | Shape | Tokens |
|---|---|---|
| Text | `input: "…"` or a list of strings | – |
| Image | `input: [{"image": "<base64 JPEG>"}]` | about 277 |
| Sound | `input: [{"audio": "<base64 WAV, 16 kHz mono>"}]` | about 25 per second |

The top-level `images` field is ignored; `video` is not accepted.

| Speed | |
|---|---|
| Text, in a batch | about 14 ms per text |
| Image, 512 px | about 590 ms |
| Spoken clip, 5–8 s | about 170 ms |

| Quality | Top-1 | Top-3 / MRR |
|---|---|---|
| 43 images, German and English text queries | 11/12 | 12/12 |
| 6 spoken German notes | 4/6 | 6/6 |
| 15 German passages, 18 paraphrased queries: EmbeddingGemma 2 | 17/18 | MRR 0.97 |
| the same: `text-embedding-3-small` | 18/18 | |
| the same: `nomic-embed-text` | 11/18 | |

## EmbeddingGemma on MLX

| Port | Text | Image | Audio | Video | State |
|---|---|---|---|---|---|
| Ollama `embeddinggemma-2:740m` on Apple silicon (MLX runner, nvfp4) | yes | yes | yes | no (`/api/embed`) | released, 0.40+; our default, measured |
| Ollama `embeddinggemma-2:740m` elsewhere (llama.cpp, GGUF + projector) | yes | yes (0.40.4: multimodal embeddings through llama-server) | not measured | no | released |
| `mlx-vlm` `models/embedding_gemma2` (Python) | yes | yes | yes | yes | in v0.7.10 (2026-10-21); own processor, Transformers ≥ 5.14 |
| `mlx-community/embeddinggemma-2-{bf16,8bit,mxfp8,5bit,4bit,mxfp4}` | yes | yes | yes | yes | weights, 1.49 GB at bf16; cards report cosine to FP32 (image 0.99995 bf16, 0.9995 mxfp8; audio 0.97–0.99 at 4 bit) |
| `mlx-swift-lm` `MLXEmbedders/Models/EmbeddingGemma2.swift` + `MLXVLM/EmbeddingGemma2.swift` | yes | yes | yes | yes | on main since 2026-10-12, not in a release (newest 3.32.3, 2026-09-30) |
| `embeddinggemma` v1 (300M, text only): `mlx-embeddings` `gemma3_text`, `mlx-swift-lm` `Gemma3.swift`, `mlx-community/embeddinggemma-300m-{6bit,8bit}` | yes | – | – | – | released; no reason to fall back to it while v2 runs everywhere |

The model card's prompts stay as they are: `task: search result | query: …` for a question,
`title: none | text: …` for a passage. Matryoshka sizes 128/256/512/768; the index keeps 768.

## How the runtime would call it

| | Ollama (today) | Python worker, JSON lines (DigUp) | MLX HTTP server (`mlx_lm.server`, `embedding-gemma-exp`) | Swift helper on `mlx-swift-lm` |
|---|---|---|---|---|
| What ships in `~/.engenty/wizards` | nothing new: the setup installs Ollama | a Python (uv-managed), a venv with `mlx`, `mlx-vlm`, `transformers`, `numpy`, `pillow`, `opencv`; the worker script | the same venv plus a server; `mlx_lm.server` has no `/v1/embeddings`, so a server of our own | one binary + `mlx.metallib` in `dist/mlx/`, built on the `macos-26` job like `wizards-apple` |
| Python | none | yes, ours to keep current | yes | none |
| Weights | `~/.ollama/models`, pulled by the search page (#255) | `~/.cache/huggingface` or our folder: a second copy | same | our folder: a second copy |
| Process | Ollama's, kept warm by `keep_alive` | ours, long-lived, started by the runtime | ours, long-lived, on a port | ours, long-lived; one process per call (as `wizards-apple`) reloads the weights every call |
| Startup | Ollama loads the model on the first call | Python imports + load; DigUp warms up with two passes | same | native start + load |
| Memory | 1.27 GB measured, shared with every other client of Ollama | the model + the Python process | same | the model |
| Media | image + audio, measured | all four | `embedding-gemma-exp`: content parts with `url` | all four, in Swift |
| Linux / Intel / Windows | the same call on llama.cpp | none | none | none |
| Risk | Ollama's MLX runner is weeks old | pins on a git commit of `mlx-vlm` and a dev Transformers for some media; a Python tree in every install | as Python, plus a port | `mlx-swift-lm` pinned to a commit until a release; SwiftPM cannot build Metal shaders, so the build needs `xcodebuild` |

The `wizards-apple` pattern (one process per call, `runClient`) fits Apple's model, which the
system keeps loaded. An MLX helper loads the weights itself, so it would be a long-lived child
of the runtime speaking JSON lines on stdin/stdout, as DigUp's `digup_worker.py` does: a
`ready` line with `info`, then `text` / `image` / `audio` requests, float32 vectors as base64,
one error per item, all MLX work on one thread.

## Other model classes

- **Text (Low, Classifier, Standard):** Ollama runs the MLX builds of Gemma 4 and Qwen 3.5–3.8
  on MLX already (`qwen3.8:27b-mlx` on the M4). A direct route would have to reimplement chat,
  tools and structured output that the AI SDK gets from Ollama's OpenAI endpoint. Not worth it.
- **Decision model:** Clef-flash runs on MLX in Ollama since 0.40.0 (safetensors on the M4),
  and the runtime calls Ollama's `/v1/systemone`; `mlx-lm` has no such endpoint. Stays on
  Ollama.
- So a direct MLX engine would serve embeddings only, while a Mac that thinks locally still
  needs Ollama. Dropping Ollama only pays for a person who wants local search and nothing else
  local.

## Speed elsewhere

No published benchmark measures EmbeddingGemma (v1 or v2) on MLX against llama.cpp or Ollama.
Generation figures (Ollama's MLX preview: Qwen3.5-35B-A3B decode 58 → 112 tok/s; tuned
llama.cpp against MLX on M4 Max 1.4–1.8× for MLX, a Gemma 3 4B case the other way) and one
embeddings blog post (MLX about 50 % ahead of llama.cpp on M5 Max, versions inconsistent) say
nothing firm. The M4 measurements above are what counts: 14 ms per text indexes a space of a
few thousand passages in under a minute.

## Open questions

1. A Mac with 8 or 16 GB: does Ollama still choose the MLX build of `740m`, and how fast is it
   there?
2. Linux and Windows run the GGUF build on llama.cpp: does `audio` work there, and are its
   vectors close enough to the MLX build's that one `model` value (`ollama:embeddinggemma-2:740m`)
   can stand for both? A space synced between machines would mix them.
3. Is local search without the Ollama app worth a Swift helper (open question for the product,
   not the code)? Only then does the table's last column matter.
4. If it is: one helper for Apple Intelligence and MLX (`wizards-apple` grows a long-lived
   `serve` mode), or a second binary? Two keeps the per-call helper simple; one keeps one build
   and one signature.

## PR steps

1. **`feat(runtime): images and sound in the Knowledge index`** (behind `mediaSearch`). Our own
   `/api/embed` call beside `embedMany` for media (the AI SDK takes text only), only on the
   `local` way: an image asset or a PDF page as a base64 JPEG (about 277 tokens), a sound window
   as base64 16 kHz mono WAV (ffmpeg, `apps/runtime/src/media/ffmpeg.ts`); video as frames and
   its sound track. The vector lands in `project_chunk.embedding` with the same `model` as the
   text, so one cosine query finds both. Ways without media (`gateway`, `openai`, `credits`)
   keep indexing media by name and description (#254).
2. **`feat(runtime): the search page says whether the local model reads images and sound`.**
   From `/api/show` `capabilities`, so a GGUF build without `audio` or an older Ollama shows
   what it lacks instead of failing in the index run.
3. **Only if open question 3 says yes: `feat(runtime): a Swift MLX helper for embeddings`.**
   `apps/runtime/mlx/` as a SwiftPM package pinned to the `mlx-swift-lm` commit with #684 (a
   release once there is one), built with `xcodebuild` on the `macos-26` release job into
   `dist/mlx/` and taken into the package like `wizards-apple` (`scripts/npm-package.mjs`); a
   long-lived child speaking JSON lines; weights downloaded by the search page into
   `~/.engenty/wizards/models`; a new `EmbeddingWay` (`mlx`) tried before `local` on Apple
   silicon. No Python route in any case.
