# Upload checks

Decided and built on 2026-10-19. Built: the checks below for what people upload in a run and for
a space’s files. Not built yet: the items under [Later](#later).

## Why

Files reach engenty wizards from people we don’t know: a visitor’s photo in a run, a logo taken
from a web address, a picture in a wizard file someone shares. Until now only the type the sender
named and the size were checked. Serving was already careful (`nosniff`, `sandbox`, downloads for
anything that isn’t a picture, a recording, a clip or a PDF), so a file could never run as a page
of ours. But what was kept was what came:

- **A file named as something else.** A page declared as `image/png` was kept as a PNG.
- **Location and camera details.** A phone photo carries GPS coordinates in its EXIF data. It
  went on to models, results and shares as it was.
- **More than the picture.** A JPEG can carry a ZIP or HTML after its end, or a comment block.
- **Pictures that cost too much.** A small PNG can say it is 100 000 × 100 000 pixels. Decoding
  it for a model or a thumbnail takes 40 GB of memory.
- **SVG that is a program.** An SVG logo can hold scripts, event handlers, external references
  and entity declarations. It is shown through `<img>` and sandboxed today, but it travels on:
  into documents, wizard files and other spaces.

Themes with images of their own (see [themes.md](themes.md)) depend on these checks.

## Where files come in

| Way in | Who | Checked |
|---|---|---|
| A run’s image and file fields (`POST /api/runs/:id/uploads`) | anyone with the run | yes |
| A runner plugin’s `runs.upload` (messaging channels) | the plugin, for a person | yes |
| A space’s files: logos, patterns, assets, documents, as an upload | the space’s builders | yes |
| The same from a web address, or picked from a web page’s pictures | the space’s builders | yes, after the download |
| Brand fonts (a space file of kind asset) | the space’s builders | yes |
| Recordings for speech to text | anyone with the run, the studio | no: never kept |
| A wizard’s workspace files (widgets, scripts) | builders and their agents | no: code, run only in the sandbox |
| A wizard file (.wizard) | builders | its size and entry limits, as before |
| Files steps collect from mail and the web | connectors | no: kept as downloads, see Later |
| Documents a plugin puts into a space (`putDocument`) | plugins | no: see Later |

## The checks

One function, `checkUpload` in `apps/runtime/src/files/upload-check.ts`, runs before a file is
kept. It answers the name, type and bytes to keep, or refuses with a note the person reads.

1. **Name.** Control characters, bidirectional overrides (`photo`, U+202E, `gpj.exe` shows as
   `photoexe.jpg`), slashes and backslashes go. At most 120 characters.
2. **Type from the bytes.** The first bytes say what a file is: PNG, JPEG, GIF, WebP, AVIF, HEIC,
   BMP, SVG, PDF, ZIP (and so Word, Excel, PowerPoint, OpenDocument), old Office files, WebM and
   Matroska, MP4 and QuickTime, Ogg, WAV, MP3, AAC, FLAC, WOFF, WOFF2, TrueType, OpenType, glTF.
   - The declared type and the bytes must be the same kind of thing: a picture, a recording or a
     clip, a PDF, an Office file, a font. Otherwise the file is refused.
   - Within a kind the bytes win: a PNG named `.jpg` is kept as `image/png`.
   - Text types (plain text, CSV, Markdown, JSON, calendar, contact, mail) must not hold NUL bytes.
   - A type we don’t check is kept as before. It is served as a download.
3. **Pictures.** The size is read from the file’s header, before anything decodes it. More than
   50 megapixels, or more than 16 384 pixels on a side, is refused.
4. **Pictures, drawn again.** PNG, JPEG, WebP and AVIF are decoded and encoded again in the same
   format (JPEG and WebP at quality 92, AVIF at 80, PNG lossless). This
   - drops EXIF, XMP, IPTC and comments, and with them GPS coordinates and camera details,
   - turns a photo upright as its EXIF orientation says, so it stays upright without it,
   - drops whatever comes after the picture’s end,
   - refuses a file that doesn’t decode.

   Animated GIF, WebP, PNG and AVIF keep their bytes, because drawing them keeps one frame. So do
   HEIC files: the runtime can’t decode them. Both are checked by steps 2 and 3.
5. **SVG.** An SVG is parsed and written again from an allowlist:
   - Kept: shapes, paths, text, groups, `defs`, `use`, gradients, patterns, masks, clip paths,
     markers, filters (not `feImage`), `style`, `title`, `desc`, and `image` with a PNG, JPEG,
     GIF or WebP data address.
   - Dropped: `script`, `foreignObject`, animations, links (their content stays), editor
     metadata, every `on…` attribute, every reference that doesn’t start with `#`, and any style
     with `@import`, `expression(` or a `url(` that points outside the drawing.
   - Refused: a DOCTYPE or entity declaration, and a file whose root isn’t `<svg>`.

The checks take a fraction of a second for a phone photo, and they run where the file arrives.
Nothing is sent to another service.

## Serving

Unchanged, and now also for logos, brand fonts and a space’s files in the studio: the stored type
is sent only as a bare `type/subtype`, with `X-Content-Type-Options: nosniff`.

## Later

- **HEIC photos.** They keep their EXIF data, GPS included, until the runtime can decode them.
  iPhones usually send JPEG to a web page, but not always.
- **Recordings and clips.** MP4 and QuickTime files from phones can hold the place they were
  made. Removing it needs ffmpeg, which the runtime has only for films.
- **Documents.** Word, Excel and PowerPoint files are ZIP files. Reading them for knowledge
  should stop at a limit of unpacked bytes.
- **Files from connectors and plugins.** Attachments and downloads a step collects, and
  documents a plugin puts into a space (`putDocument`), get the same checks.
- **What a picture shows.** A check for nudity, violence and other content a space doesn’t allow,
  with a model or a moderation service. It needs a decision on the service, the cost and what the
  person sees when a picture is refused.
- **Known abuse images.** Before the catalog lists themes or templates with pictures: a hash
  check against known CSAM (Cloudflare’s CSAM Scanning Tool in front of the cloud, or PhotoDNA),
  a report button on run pages, and notice and takedown as the EU Digital Services Act asks of a
  host.
- **A domain for uploads.** Pictures people upload served from a cookieless domain of their own,
  so a reported picture can never get the run pages' domain blocked.
