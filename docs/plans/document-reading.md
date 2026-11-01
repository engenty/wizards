# Plan: reading scans and old Word files on your computer

Status: decided and built on 2026-11-01 (branch `feat/local-ocr`). Open points for Matthias are
marked **Open**. Planning page: https://claude.ai/artifact/7PM1LngdXYJeUd9GRwPQMs

## Why

Wissen, Dateien and the agents' file tools read documents through
`apps/runtime/src/documents/parse.ts`. It reads a PDF's own text (pdf-parse) and Word files
(mammoth). A scan has no text of its own: Dateien and the agents got nothing, Wissen needed a
vision model. Goose could not tell the price in `Buchhaltung 2026/Tesla/2246_001 Tesla 2026
Kaufvertrag-1.pdf` (two scanned pages). Old Word files (`.doc`) were not read at all: mammoth
only reads `.docx`.

## What engenty-pro has

engenty-pro reads documents through `packages/doc-converter`: one interface
(`DocConverterProvider`: `canConvert`, `convert` → Markdown with page-break markers) and a
facade that picks a provider by type, preferred one first. `packages/document-scanner` builds
invoice and receipt extraction on top (classify → extract), with the cloud providers only.
engenty wizards already carries the interface, the page-break helpers and the local provider
(`apps/runtime/src/engenty/doc-converter/`) and the scanner's schemas.

| Provider | What it reads | Where it runs | Licence | Needs | Latest version | Quality, speed | Decision |
|---|---|---|---|---|---|---|---|
| `local`: pdf-parse + mammoth | PDF text layer, `.docx` | your computer, JavaScript | Apache-2.0, BSD-2-Clause | nothing | pdf-parse 2.4.5 (2025-10), mammoth 1.13.0 (2026-09) | text layer only; milliseconds | already here, stays |
| `liteparse` (LlamaIndex LiteParse) | PDF layout to Markdown, OCR of scans and pictures (Tesseract 5), Office via LibreOffice | your computer: Rust with PDFium and Tesseract built in, prebuilt for macOS, Linux (glibc, musl), Windows (x64, arm64) | Apache-2.0 | a native module (26 MB per platform; the main package adds 33 MB), OCR models downloaded on first use (see below) | 2.17.0 (2026-10-22), releases every few days; pro had 2.14.6 | Tesla scan: price, VIN and IBAN right; about 3 s of CPU per page | **migrate** |
| `llamaparse` (LlamaCloud) | everything, best on complex layouts | cloud service | paid service | API key | — | best of the set; seconds per page | not now: cloud |
| `mistral` (Mistral OCR) | PDF, images, Office | cloud service | paid service | API key | `mistral-ocr-latest` | very good OCR | not now: cloud |
| `gemini` (AI Gateway) | PDF, images by a vision model | cloud service | paid service | API key | — | good | not now: wizards already reads scans with the space's own vision model (`VisionProvider` in `parse.ts`) |
| document-scanner (Llama, Gemini) | invoice and receipt fields | cloud service | — | API keys | — | — | not now; its schemas already run on the space's models (`scanDocument`) |

Added here, not in engenty-pro:

| Library | What it reads | Licence | Needs | Latest version | Measured | Decision |
|---|---|---|---|---|---|---|
| word-extractor | `.doc` (Word 97–2003): body, headers, footnotes | MIT | JavaScript only (saxes, yauzl) | 1.0.4 (2022; the format does not change) | an invoice from 2015 in 38 ms | **add** |

Looked at and left out:

- **tesseract.js 7.0.0** (WebAssembly, Apache-2.0, 2025-12): no native module, but we would draw
  the PDF pages ourselves and get no layout. Page 1 of the Tesla scan took 4.3 s of CPU (LiteParse
  3.2 s).
- **officeparser 8.5.0**: reads `.docx`, `.pptx`, `.odt`, `.rtf`, but not `.doc`.
- **LibreOffice**: LiteParse reads `.pptx`, `.odt` and the like through it. A 300 MB install
  nobody has on a Mac. Not required, not bundled.
- **Tesseract's small models** (`tessdata_fast`, 5.6 MB for German and English): a third of
  the CPU, but the Tesla price and VIN came out wrong. We use `tessdata_best`.

## How a file is read now

One order for everything that reads a file: Wissen uploads, Dateien's index, the agents' file
tools (`space_read` on a mounted file, `web_fetch` of a PDF), steps' document reading and
plugins' `parseDocument`.

1. **PDF:** its own text, page by page (pdf-parse). Pages with fewer than 60 letters are
   read again by OCR (LiteParse, only those pages). Where a vision model may be used (Wissen,
   steps) and OCR still found hardly anything, the vision model reads the PDF, as before.
2. **Pictures:** in Wissen and steps, OCR first. With 60 letters or more, the text is what the
   picture says. Below that the vision model describes it, as before. Dateien does not read
   pictures for text (they are found by the embedding model, as before). **Open:** OCR pictures
   in Dateien too (scanned receipts as JPEG)? It costs about 3 s of CPU per picture, once.
3. **`.doc`:** word-extractor. `.docx`: mammoth, as before.
4. **Everything else** as before: tables, CSV, mail, HTML, text.

`ParsedDocument.via` gets `"ocr"`. Wissen asks for a comparison with the original when an OCR
read has little text, as it does for a vision read.

OCR runs in the runtime's process, one document at a time (PDFium allows no more). At most 100
pages of a document are read by OCR. **Open:** is 100 right for long scanned books?

## Models and downloads

Tesseract needs a model per language. LiteParse downloads it from GitHub
(`tesseract-ocr/tessdata_best`) the first time a scan is read. We keep it in
`DATA_DIR/tessdata`: on your computer `~/.engenty/wizards/data/tessdata`, in the cloud on the
data volume.

- German and English: `deu` 8.6 MB + `eng` 15.4 MB = 24 MB, once.
- Without the internet at that moment, the scan stays without text. Dateien reads it again the
  next time it is indexed.
- **Open:** languages. Now German and English for every space. Alternatives: from the space's
  language, or a setting. Each language adds 5–15 MB and a little time per page.
- **Open:** ship the 24 MB in the npm package instead of downloading on first use.

## Files read before

- **Dateien:** migration `0054_dateien_ocr` sets PDFs without text passages and `.doc` files
  back to pending. Indexing reads a file again when what was kept of it had no text.
- **Wissen:** a scan without a vision model failed to read and shows „Erneut lesen“. Nothing
  converts by itself.

## Later

- **Apple Vision on a Mac.** The `wizards-apple` helper could read text with
  `VNRecognizeTextRequest`: no download, very good on photos and handwriting, Mac only.
  **Open:** add it as the Mac's OCR?
- Cloud providers (LlamaParse, Mistral OCR) for a plan, with the same interface.
- `.pptx`, `.odt`, `.rtf`: officeparser, without LibreOffice.

## Measured

On a MacBook (10 cores), through `ownText` as Dateien and the agents read a file. Other work
loaded the machine during the library comparison; CPU time is the steadier figure there.

| File | Pages | Read by | Wall | CPU |
|---|---|---|---|---|
| Tesla purchase contract (scan) | 2 | own text: none; OCR both pages | 2.9 s (1.5 s per page); 5.3 s on the first read after a start | 4.6 s |
| same, page 1 as PNG, library alone | 1 | LiteParse OCR, `tessdata_best` | — | 3.2 s |
| same, page 1 as PNG, library alone | 1 | LiteParse OCR, `tessdata_fast` | — | 1.2 s, price and VIN wrong |
| same, page 1 as PNG, library alone | 1 | tesseract.js 7 | — | 4.3 s |
| invoice 2015 (`.doc`) | — | word-extractor | 38 ms | — |

What OCR read from the Tesla contract: „Kaufpreis: EUR 25.500“, „VIN: 5YJSA7E22LF404240“, the
IBAN and BIC. Tests: `apps/runtime/test/document-reading.test.ts` (a PDF with a text page and a
scanned page, a picture of a receipt, a `.doc`).
