# Plan: local models through MLX

Status: investigation only, written on 2026-10-28 against main at #256 (v0.11.13). Nothing built,
nothing downloaded. Follows [Apple's local models](local-models-apple.md), which left MLX on a
Mac to Ollama.

Scope: whether the runtime on a Mac can run open-weight models through Apple's MLX — first the
embedding model of the Knowledge search (EmbeddingGemma 2, text, images and sound in one
768-dim space), then the text classes and the decision model — and through which process.

## Recommendation

Stay on Ollama, and ask it for the MLX build of EmbeddingGemma 2. Build a Swift helper on
MLX Swift only if Ollama's MLX runner does not embed images and sound.

1. **Ollama is MLX now.** Since Ollama 0.40 (October 2026) a model whose files are safetensors
   runs on MLX on Apple silicon; a GGUF model still runs on llama.cpp. This Mac runs 0.40.12.
   The 0.40.0 notes name `embeddinggemma-2` as the first embedding model on MLX; Clef-flash
   (`clef-flash:latest` is safetensors here) and the MLX tags of the text models already run
   there.
2. **Our default is the llama.cpp build.** `LOCAL_EMBEDDING_MODEL = "embeddinggemma-2:740m"`
   is a GGUF text model (304 MB) plus a projector (981 MB). `embeddinggemma-2:740m-mxfp8`
   (1.4 GB) is the MLX build: safetensors with the language model, the vision tower and the
   audio tower. Changing the tag is a one-line change; the setup already installs Ollama and the
   search page already downloads the model (#255).
3. **The media call is the same either way.** `/api/embed` takes `{text?, image?, audio?}`
   objects with base64 bytes (video: not accepted). The open spike is whether the MLX runner
   honours them for `740m-mxfp8`: 0.40.4 added multimodal embeddings "through llama-server",
   i.e. the GGUF path, and the library page lists the MLX tag as "Text, Image" with no tag for
   audio. One `curl` per modality answers it (Measurements).
4. **A second engine costs more than it gives.** Every direct route ships a binary or a Python
   tree in the install, keeps a second copy of the weights outside `~/.ollama`, and needs a
   long-lived process of our own to keep 1.4 GB loaded. The speed it could win over Ollama's MLX
   runner is the HTTP hop, small next to the model's own time.
5. **If Ollama falls short on media, Swift beats Python.** `mlx-swift-lm` has a full
   EmbeddingGemma 2 (text, image, audio, video, interleaved) since 2026-10-12 (#684), with the
   reference's image resize. It builds beside `wizards-apple` in the `macos-26` release job and
   adds no runtime dependency. The Python route (`mlx-vlm` 0.7.10) works today but brings a
   Python, a venv of several hundred MB and pins on fast-moving packages into
   `~/.engenty/wizards`.

## EmbeddingGemma on MLX

| Port | Text | Image | Audio | Video | State |
|---|---|---|---|---|---|
| Ollama `embeddinggemma-2:740m-mxfp8` / `-nvfp4` (MLX runner) | yes | listed | towers in the files, not listed | no (`/api/embed`) | released, 0.40+ |
| Ollama `embeddinggemma-2:740m` / `-q8_0` / `-bf16` (llama.cpp) | yes | yes | not listed | no | released, our default |
| `mlx-vlm` `models/embedding_gemma2` (Python) | yes | yes | yes | yes | in v0.7.10 (2026-10-21); own processor, Transformers ≥ 5.14 |
| `mlx-community/embeddinggemma-2-{bf16,8bit,mxfp8,5bit,4bit,mxfp4}` | yes | yes | yes | yes | weights, 1.49 GB at bf16; cards report cosine to FP32 (image 0.99995 bf16, 0.9995 mxfp8; audio 0.97–0.99 at 4 bit) |
| `mlx-swift-lm` `MLXEmbedders/Models/EmbeddingGemma2.swift` + `MLXVLM/EmbeddingGemma2.swift` | yes | yes | yes | yes | on main since 2026-10-12, not in a release (newest 3.32.3, 2026-09-30) |
| `embeddinggemma` v1 (300M, text only): `mlx-embeddings` `gemma3_text`, `mlx-swift-lm` `Gemma3.swift`, `mlx-community/embeddinggemma-300m-{6bit,8bit}` | yes | – | – | – | released; no reason to fall back to it while v2 runs everywhere |

The model card's prompts stay as they are: `task: search result | query: …` for a question,
`title: none | text: …` for a passage. Matryoshka sizes 128/256/512/768; the index keeps 768.

## How the runtime would call it

| | Ollama, MLX tag | Python worker, JSON lines (DigUp) | MLX HTTP server (`mlx_lm.server`, `embedding-gemma-exp`) | Swift helper on `mlx-swift-lm` |
|---|---|---|---|---|
| What ships in `~/.engenty/wizards` | nothing new: the setup installs Ollama | a Python (uv-managed), a venv with `mlx`, `mlx-vlm`, `transformers`, `numpy`, `pillow`, `opencv`; the worker script | the same venv plus a server; `mlx_lm.server` has no `/v1/embeddings`, so a server of our own | one binary + `mlx.metallib` in `dist/mlx/`, built on the `macos-26` job like `wizards-apple` |
| Python | none | yes, ours to keep current | yes | none |
| Weights | `~/.ollama/models`, pulled as now | `~/.cache/huggingface` or our folder: a second copy | same | our folder: a second copy |
| Process | Ollama's, kept warm by `keep_alive` | ours, long-lived, started by the runtime | ours, long-lived, on a port | ours, long-lived; one process per call (as `wizards-apple`) reloads 1.4 GB every call |
| Startup | Ollama loads the model on the first call | Python imports + load; DigUp warms up with two passes | same | native start + load |
| Memory | the model (≈1.4 GB), shared with every other client of Ollama | the model + the Python process | same | the model |
| Media | `/api/embed` with base64 image/audio, if the MLX runner takes it (spike) | all four, today | `embedding-gemma-exp`: content parts with `url` | all four, in Swift |
| Linux / Intel / Windows | the same call on llama.cpp | none | none | none |
| Risk | Ollama's MLX runner is weeks old | pins on a git commit of `mlx-vlm` and a dev Transformers for some media; a Python tree in every install | as Python, plus a port | `mlx-swift-lm` pinned to a commit until a release; SwiftPM cannot build Metal shaders, so the build needs `xcodebuild` |

The `wizards-apple` pattern (one process per call, `runClient`) fits Apple's model, which the
system keeps loaded. An MLX helper loads the weights itself, so it would be a long-lived child
of the runtime speaking JSON lines on stdin/stdout, as DigUp's `digup_worker.py` does: a
`ready` line with `info`, then `text` / `image` / `audio` requests, float32 vectors as base64,
one error per item, all MLX work on one thread.

## Other model classes

- **Text (Low, Classifier, Standard):** Ollama runs the MLX tags of Gemma 4, Qwen 3.5–3.8 on
  MLX already (`qwen3.8:27b-mlx` here). A direct route would have to reimplement chat, tools
  and structured output that the AI SDK gets from Ollama's OpenAI endpoint. Not worth it.
- **Decision model:** Clef-flash runs on MLX in Ollama since 0.40.0, and the runtime calls
  Ollama's `/v1/systemone`; `mlx-lm` has no such endpoint. Stays on Ollama.
- So a direct MLX engine would serve embeddings only, which argues for Ollama: one engine, one
  model store, one download page.

## Speed

No published benchmark measures EmbeddingGemma (v1 or v2) on MLX against llama.cpp or Ollama.
What exists:

- Generation, not embeddings: Ollama's own MLX preview figures, Qwen3.5-35B-A3B decode
  58 → 112 tok/s; tuned llama.cpp against MLX on M4 Max 1.4–1.8× in MLX's favour for decode,
  and a Gemma 3 4B case where llama.cpp was ahead (123 vs 105 tok/s).
- Embeddings: one blog post (Contra Collective, M5 Max) reports MLX about 50 % faster than
  llama.cpp for nomic-embed-text-v2, bge-m3 and Qwen3-Embedding; its versions do not add up, so
  it is a hint, not a number.

An index run embeds a few hundred passages at a time, and media one item at a time; the model
time dominates either way. Measure before deciding (below).

## Measurements for the person to run

Each pull downloads about 1.3–1.5 GB; nothing here was run.

```bash
ollama pull embeddinggemma-2:740m-mxfp8
```

```bash
ollama pull embeddinggemma-2:740m
```

Text speed, 256 passages, each tag (repeat once; the first call loads the model):

```bash
python3 -c 'import json,urllib.request,time; b=json.dumps({"model":"embeddinggemma-2:740m-mxfp8","input":["title: none | text: passage %d about invoices and appointments" % i for i in range(256)]}).encode(); t=time.time(); r=json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:11434/api/embed",b,{"Content-Type":"application/json"}))); print(len(r["embeddings"]), len(r["embeddings"][0]), round(time.time()-t,2), "s")'
```

Image and sound on the MLX tag (the spike):

```bash
curl -s localhost:11434/api/embed -d "{\"model\":\"embeddinggemma-2:740m-mxfp8\",\"input\":{\"image\":\"$(base64 -i photo.jpg)\"}}" | head -c 200
```

```bash
curl -s localhost:11434/api/embed -d "{\"model\":\"embeddinggemma-2:740m-mxfp8\",\"input\":{\"audio\":\"$(base64 -i note.wav)\"}}" | head -c 200
```

Which runner holds it, and its memory:

```bash
ollama ps
```

For a number against MLX without Ollama (installs `mlx-vlm` 0.7.10 into a throwaway uv
environment and downloads the bf16 weights, 1.49 GB):

```bash
uvx --from "mlx-vlm==0.7.10" --with "transformers>=5.14" python -c 'import time,mlx.core as mx; from mlx_vlm import load; m,p=load("mlx-community/embeddinggemma-2-bf16"); x=p.tokenizer(["title: none | text: passage %d about invoices and appointments" % i for i in range(256)],padding=True,return_tensors="np"); t=time.time(); e=m(**{k:mx.array(v) for k,v in x.items()}).text_embeds; mx.eval(e); print(e.shape, round(time.time()-t,2), "s")'
```

## Open questions

1. Does the MLX runner of Ollama 0.40.12 embed `image` and `audio` for `740m-mxfp8`, and are the
   vectors in the same space as its text (a photo next to its caption scores well above
   unrelated text)? If only images: is sound worth a helper of our own now?
2. Is the MLX tag faster or slower than the GGUF tag on the person's Mac, and by how much on an
   8 GB or 16 GB machine, where Ollama may keep the GGUF build for memory?
3. Does Ollama pick the MLX runner for the tag on a Mac with less memory, or fall back? The
   0.19 preview needed more than 32 GB; 0.40 does not say.
4. The default tag differs by machine (MLX on Apple silicon, GGUF elsewhere), so `model` in
   `project_chunk` differs too. A space synced between a Mac and the cloud embeds twice anyway
   (the cloud uses credits); is that acceptable as it is today?
5. If a Swift helper becomes necessary: one helper for Apple Intelligence and MLX
   (`wizards-apple` grows a long-lived `serve` mode), or a second binary? Two keeps the
   per-call helper simple; one keeps one build and one signature.

## PR steps

1. **`feat(runtime): EmbeddingGemma 2 on MLX on a Mac with Apple silicon`.** `LOCAL_EMBEDDING_MODEL`
   becomes `embeddinggemma-2:740m-mxfp8` on a Mac with Apple silicon (`darwin` and `arm64`, as
   `appleMachine()` checks), `embeddinggemma-2:740m` elsewhere; the search page downloads that tag. Existing
   vectors carry `ollama:embeddinggemma-2:740m` and are embedded again by the reindex that a
   change of model already runs. Gated on open question 2 (no slower than the GGUF tag).
2. **The spike.** The `curl`s above on the MLX tag and the GGUF tag; result into
   `docs/plans/` beside the multimodal search concept. Decides step 3 or 4.
3. **`feat(runtime): image and sound into the Knowledge index through Ollama`** (behind
   `mediaSearch`). Our own `/api/embed` call beside `embedMany` for media (the AI SDK takes
   text only): base64 bytes of an image asset or a PDF page image, a sound window; the vector
   lands in `project_chunk.embedding` with the same `model` as the text, so one cosine query
   finds both.
4. **Only if Ollama's MLX runner refuses media: `feat(runtime): a Swift MLX helper for
   embeddings`.** `apps/runtime/mlx/` as a SwiftPM package pinned to the `mlx-swift-lm` commit
   with #684 (a release once there is one), built with `xcodebuild` on the `macos-26` release
   job into `dist/mlx/` and taken into the package like `wizards-apple`
   (`scripts/npm-package.mjs`); a long-lived child speaking JSON lines; weights downloaded by
   the search page into `~/.engenty/wizards/models`; a new `EmbeddingWay` (`mlx`) before
   `local` on Apple silicon. No Python route in any case.
