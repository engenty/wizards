import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { env } from "../env.js";
import { extFor } from "../files/storage.js";
import { ffmpeg, hasFfmpeg, probeMedia, withTempDir } from "../media/ffmpeg.js";
import { newContext, offlineContext } from "../render/chromium.js";

export { hasFfmpeg } from "../media/ffmpeg.js";

export interface WidgetSize {
  width: number;
  height: number;
}

const FPS = 25;
const MAX_SECONDS = 60;

/** Exports set `wizard.mode` to "export" so the widget hides its controls and does not autoplay. */
function forExport(html: string): string {
  return html.replace(
    '<script type="application/json" id="wizard-payload">',
    '<script>window.__WIZARD_EXPORT=true</script><script type="application/json" id="wizard-payload">',
  );
}

async function withWidget<T>(
  html: string,
  size: WidgetSize,
  scale: number,
  use: (page: Page, errors: string[]) => Promise<T>,
): Promise<T> {
  const context = await offlineContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: scale,
  });
  const errors: string[] = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });
    await page.setContent(forExport(html), { waitUntil: "load", timeout: 30_000 });
    // A widget calls wizard.ready() after its first frame; one that never does gets 3 seconds.
    await page.evaluate(() =>
      Promise.race([(window as any).wizard?.__ready, new Promise((r) => setTimeout(r, 3000))]),
    );
    return await use(page, errors);
  } finally {
    await context.close();
  }
}

async function timelineOf(page: Page): Promise<{ duration: number; poster: number } | null> {
  return page.evaluate(() => {
    const t = (window as any).wizard?.__timeline?.();
    return t ? { duration: Number(t.duration), poster: Number(t.poster ?? 0) } : null;
  });
}

async function seek(page: Page, seconds: number) {
  await page.evaluate(async (t) => {
    // A film's seek waits for its clips to reach the frame; a drawn animation returns at once.
    await (window as any).wizard.__timeline().seek(t);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }, seconds);
}

/** Loads the widget once: does it run, and does it animate? */
export async function probeWidget(
  html: string,
  size: WidgetSize,
): Promise<{ duration: number | null; errors: string[]; png: Uint8Array }> {
  return withWidget(html, size, 1, async (page, errors) => {
    const timeline = await timelineOf(page);
    if (timeline) {
      await seek(page, timeline.poster);
    }
    const png = await page.screenshot({ type: "png" });
    return {
      duration: timeline ? Math.min(timeline.duration, MAX_SECONDS) : null,
      errors: [...new Set(errors)].slice(0, 10),
      png,
    };
  });
}

export async function widgetPng(html: string, size: WidgetSize): Promise<Uint8Array> {
  return withWidget(html, size, 2, async (page) => {
    const timeline = await timelineOf(page);
    if (timeline) {
      await seek(page, timeline.poster);
    }
    return page.screenshot({ type: "png", fullPage: true });
  });
}

export async function widgetPdf(html: string, size: WidgetSize): Promise<Uint8Array> {
  return withWidget(html, size, 1, async (page) => {
    const timeline = await timelineOf(page);
    if (timeline) {
      await seek(page, timeline.poster);
    }
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    return page.pdf({
      width: `${size.width}px`,
      height: `${Math.max(size.height, height)}px`,
      printBackground: true,
      pageRanges: "1",
    });
  });
}

/** Steps through the timeline frame by frame and encodes the frames as H.264 (no sound). */
async function encodeFrames(
  page: Page,
  seconds: number,
  out: string,
  onProgress?: (done: number) => void,
) {
  const encoder = spawn(
    env.ffmpegPath,
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(FPS),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  encoder.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const done = new Promise<void>((resolve, reject) => {
    encoder.on("error", reject);
    encoder.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg: ${stderr.slice(0, 300)}`)),
    );
  });
  const frames = Math.max(1, Math.round(seconds * FPS));
  for (let i = 0; i < frames; i++) {
    await seek(page, (i * seconds) / frames);
    const jpeg = await page.screenshot({ type: "jpeg", quality: 92 });
    if (!encoder.stdin.write(jpeg)) {
      await new Promise((r) => encoder.stdin.once("drain", r));
    }
    if (i % FPS === 0) {
      onProgress?.(i / frames);
    }
  }
  encoder.stdin.end();
  await done;
}

/** Steps through the widget's timeline frame by frame and encodes the frames as H.264. */
export async function widgetMp4(html: string, size: WidgetSize): Promise<Uint8Array | null> {
  if (!(await hasFfmpeg())) {
    return null;
  }
  const even = { width: size.width - (size.width % 2), height: size.height - (size.height % 2) };
  return withTempDir(async (dir) => {
    const out = join(dir, "out.mp4");
    return withWidget(html, even, 1, async (page) => {
      const timeline = await timelineOf(page);
      if (!timeline) {
        return null;
      }
      await encodeFrames(page, Math.min(timeline.duration, MAX_SECONDS), out);
      return new Uint8Array(await readFile(out));
    });
  });
}

// --- films: a timeline of clips and stills, with sound ---------------------------------

/** Where a film's page finds this run's clips, images and voice-over while it is rendered. */
export const FILM_MEDIA_ORIGIN = "http://wizard.media";

export interface FilmMedia {
  bytes: Uint8Array;
  mime: string;
}

interface AudioTrack {
  src: string;
  /** Second of the film the track starts at. */
  start: number;
  /** Seconds of the track that play; default: all of it. */
  duration?: number;
  /** Second of the source the track plays from; default 0. Cuts of a recording set it. */
  from?: number;
  volume?: number;
}

/** A film names at most this many sound tracks: voice-over, music, and every cut of a recording. */
const MAX_TRACKS = 48;

export interface Film {
  mp4: Uint8Array;
  png: Uint8Array;
  duration: number;
  errors: string[];
}

/**
 * Renders a film widget: its page draws every frame from this run's clips and images, and names
 * the sound that belongs to it (voice-over, the clips' own sound). Clips are re-encoded with a
 * key frame every few frames first, so the page reaches any frame quickly and exactly.
 */
export async function renderFilm(
  html: string,
  size: WidgetSize,
  media: Map<string, FilmMedia>,
  onProgress?: (done: number) => void,
): Promise<Film | null> {
  if (!(await hasFfmpeg())) {
    return null;
  }
  const even = { width: size.width - (size.width % 2), height: size.height - (size.height % 2) };
  return withTempDir(async (dir) => {
    // url → the file as it came (for its sound) and what the page is served.
    const files = new Map<string, { path: string; served: FilmMedia }>();
    let n = 0;
    for (const [url, file] of media) {
      const path = join(dir, `media-${n++}.${extFor(file.mime)}`);
      await writeFile(path, file.bytes);
      let served = file;
      if (file.mime.startsWith("video/")) {
        const seekable = join(dir, `seek-${n}.mp4`);
        const { code } = await ffmpeg([
          "-y",
          "-loglevel",
          "error",
          "-i",
          path,
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-g",
          "5",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          seekable,
        ]);
        if (code === 0) {
          served = { bytes: new Uint8Array(await readFile(seekable)), mime: "video/mp4" };
        }
      }
      files.set(url, { path, served });
    }

    const context = await newContext({ viewport: even, deviceScaleFactor: 1 });
    const errors: string[] = [];
    try {
      await context.route("**/*", async (route) => {
        const request = route.request();
        const file = files.get(request.url().split(/[?#]/)[0])?.served;
        if (!file) {
          await route.abort("blockedbyclient");
          return;
        }
        // Players ask for byte ranges and only seek freely when they get them.
        const total = file.bytes.byteLength;
        const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const from = range ? Math.min(Number(range[1]), total - 1) : 0;
        const to = range?.[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
        await route.fulfill({
          status: range ? 206 : 200,
          contentType: file.mime,
          headers: {
            "accept-ranges": "bytes",
            ...(range ? { "content-range": `bytes ${from}-${to}/${total}` } : {}),
          },
          body: Buffer.from(file.bytes.subarray(from, to + 1)),
        });
      });
      const page = await context.newPage();
      page.on("pageerror", (err) => errors.push(err.message));
      await page.setContent(forExport(html), { waitUntil: "load", timeout: 30_000 });
      // A film is ready once its clips are loaded; that takes longer than a drawn widget.
      await page.evaluate(() =>
        Promise.race([(window as any).wizard?.__ready, new Promise((r) => setTimeout(r, 45_000))]),
      );
      const timeline = await page.evaluate(() => {
        const t = (window as any).wizard?.__timeline?.();
        return t
          ? {
              duration: Number(t.duration),
              poster: Number(t.poster ?? 0),
              audio: (Array.isArray(t.audio) ? t.audio : []) as AudioTrack[],
            }
          : null;
      });
      if (!timeline) {
        return null;
      }
      const seconds = Math.min(timeline.duration, MAX_SECONDS);
      const silent = join(dir, "silent.mp4");
      await encodeFrames(page, seconds, silent, onProgress);
      await seek(page, Math.min(timeline.poster, seconds));
      const png = await page.screenshot({ type: "png" });

      const tracks: (AudioTrack & { path: string })[] = [];
      // Sounds from the wizard's workspace (wizard.url) arrive as data URLs.
      const inline = new Map<string, string>();
      for (const track of timeline.audio.slice(0, MAX_TRACKS)) {
        const data = String(track.src).match(/^data:(audio\/[\w.+-]+);base64,(.+)$/);
        if (data && !inline.has(track.src)) {
          const path = join(dir, `sound-${inline.size}.${extFor(data[1])}`);
          await writeFile(path, Buffer.from(data[2], "base64"));
          inline.set(track.src, path);
        }
      }
      for (const track of timeline.audio.slice(0, MAX_TRACKS)) {
        const path = inline.get(track.src) ?? files.get(String(track.src).split(/[?#]/)[0])?.path;
        if (path && track.start < seconds && (await probeMedia(path)).audio) {
          tracks.push({ ...track, path });
        }
      }
      let out = silent;
      if (tracks.length) {
        const mixed = join(dir, "film.mp4");
        const chains = tracks.map((track, i) => {
          const length = Math.min(track.duration ?? seconds, seconds - track.start);
          const volume = Math.max(0, Math.min(2, track.volume ?? 1));
          const delay = Math.round(Math.max(0, track.start) * 1000);
          const cut = track.from !== undefined;
          const from = Math.max(0, Number(track.from) || 0);
          // A cut out of a recording gets short fades, so the hard cut does not click.
          const fade = cut ? Math.min(0.03, length / 4) : 0.25;
          const fadeIn = cut ? `afade=t=in:d=${fade.toFixed(3)},` : "";
          return `[${i + 1}:a]atrim=${from.toFixed(3)}:${(from + length).toFixed(3)},asetpts=PTS-STARTPTS,${fadeIn}afade=t=out:st=${Math.max(0, length - fade).toFixed(3)}:d=${fade.toFixed(3)},adelay=${delay}:all=1,volume=${volume}[a${i}]`;
        });
        const mix = `${tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${tracks.length}:normalize=0:duration=longest[mix]`;
        const { code, stderr } = await ffmpeg([
          "-y",
          "-loglevel",
          "error",
          "-i",
          silent,
          ...tracks.flatMap((track) => ["-i", track.path]),
          "-filter_complex",
          [...chains, mix].join(";"),
          "-map",
          "0:v",
          "-map",
          "[mix]",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-b:a",
          "160k",
          "-t",
          seconds.toFixed(3),
          "-movflags",
          "+faststart",
          mixed,
        ]);
        if (code === 0) {
          out = mixed;
        } else {
          errors.push(`The sound could not be mixed: ${stderr.slice(-200)}`);
        }
      }
      return {
        mp4: new Uint8Array(await readFile(out)),
        png,
        duration: seconds,
        errors: [...new Set(errors)].slice(0, 10),
      };
    } finally {
      await context.close();
    }
  });
}
