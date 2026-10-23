import type { VideoResolution } from "@engenty/wizards-shared/definition";
import { experimental_generateVideo, generateImage, generateSpeech, generateText } from "ai";
import { extFor } from "../files/storage.js";
import {
  type CallMeta,
  imageCostUsd,
  imageModel,
  isHarnessVendor,
  speechCostUsd,
  speechModel,
  textModel,
  videoCostUsd,
  videoModel,
} from "../models.js";
import { prompt } from "../prompts.js";
import { checkContent } from "../safety.js";
import { capVideo, toMp3 } from "./ffmpeg.js";
import { speechTags } from "./marking.js";

export interface MediaReference {
  bytes: Uint8Array;
  mediaType: string;
}

export interface GeneratedMedia {
  bytes: Uint8Array;
  mime: string;
  costUsd: number;
  /** The model that made it, for the file's marking. */
  system: string;
}

type Aspect = `${number}:${number}`;

/** One image. Gemini image models answer through chat with an image file; the rest through generateImage. */
export async function generateImageMedia(input: {
  call?: CallMeta;
  prompt: string;
  aspectRatio?: string;
  reference?: MediaReference | null;
  abortSignal?: AbortSignal;
}): Promise<GeneratedMedia> {
  const { reference, abortSignal } = input;
  const aspect = (input.aspectRatio ?? "1:1") as Aspect;
  const image = await imageModel(input.call);
  await checkContent({ kind: "image", text: input.prompt, call: input.call, signal: abortSignal });
  // The gateway books its own calls; a client's images are part of the person's subscription.
  const costUsd = image.metered || isHarnessVendor(image.vendor) ? 0 : imageCostUsd(image.ref);
  if (image.chat) {
    const chat = await textModel("image", input.call);
    const text = `${input.prompt}\n\n${prompt("step", "image.aspect", { aspect })}`;
    const result = await generateText({
      model: chat.model,
      abortSignal,
      providerOptions: {
        google: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: aspect } },
      },
      messages: [
        {
          role: "user",
          content: reference
            ? [
                { type: "text", text },
                { type: "image", image: reference.bytes, mediaType: reference.mediaType },
              ]
            : text,
        },
      ],
    });
    const file = result.files?.find((f) => (f.mediaType ?? "").startsWith("image/"));
    if (!file?.uint8Array?.byteLength) {
      throw new Error("The image model returned no image.");
    }
    return {
      bytes: file.uint8Array,
      mime: file.mediaType ?? "image/png",
      costUsd,
      system: image.ref,
    };
  }
  const result = await generateImage({
    model: image.model,
    n: 1,
    abortSignal,
    prompt: reference ? { images: [reference.bytes], text: input.prompt } : input.prompt,
    aspectRatio: aspect,
  });
  const img = result.image ?? result.images?.[0];
  if (!img?.uint8Array?.byteLength) {
    throw new Error("The image model returned no image.");
  }
  return {
    bytes: img.uint8Array,
    mime: img.mediaType ?? "image/png",
    costUsd,
    system: image.ref,
  };
}

/** The short side of a video in pixels, per resolution. */
const VIDEO_SHORT_SIDE: Record<VideoResolution, number> = { "720p": 720, "480p": 480 };

/** The pixel size a model is asked for: the short side as the resolution says, the long one as the aspect. */
function videoSize(aspect: Aspect, resolution: VideoResolution): `${number}x${number}` {
  const short = VIDEO_SHORT_SIDE[resolution];
  const [w, h] = aspect.split(":").map(Number);
  const long = Math.round((short * Math.max(w, h)) / Math.min(w, h) / 2) * 2;
  return w >= h ? `${long}x${short}` : `${short}x${long}`;
}

/**
 * One video clip. Text-to-video, or image-to-video when a reference is given. Rendered at 720p,
 * or 480p when the step asks: a model that gives more anyway is scaled down to it.
 */
export async function generateVideoMedia(input: {
  call?: CallMeta;
  prompt: string;
  aspectRatio?: string;
  duration?: number;
  resolution?: VideoResolution;
  reference?: MediaReference | null;
  abortSignal?: AbortSignal;
}): Promise<GeneratedMedia> {
  const duration = Math.min(Math.max(Math.round(input.duration ?? 8), 4), 10);
  const aspect = (input.aspectRatio === "1:1" ? "16:9" : (input.aspectRatio ?? "16:9")) as Aspect;
  const resolution = input.resolution ?? "720p";
  const videoClass = await videoModel(input.call);
  await checkContent({
    kind: "video",
    text: input.prompt,
    call: input.call,
    signal: input.abortSignal,
  });
  const result = await experimental_generateVideo({
    model: videoClass.model,
    prompt: input.reference ? { image: input.reference.bytes, text: input.prompt } : input.prompt,
    aspectRatio: aspect,
    resolution: videoSize(aspect, resolution),
    duration,
    abortSignal: input.abortSignal,
  });
  const video = result.video ?? result.videos?.[0];
  if (!video?.uint8Array?.byteLength) {
    throw new Error("The video model returned no video.");
  }
  return {
    bytes: await capVideo(video.uint8Array, VIDEO_SHORT_SIDE[resolution]),
    mime: video.mediaType ?? "video/mp4",
    costUsd: videoClass.metered ? 0 : videoCostUsd(videoClass.ref, duration, resolution),
    system: videoClass.ref,
  };
}

/** A text read aloud, as MP3 where ffmpeg is at hand (else as the model gave it). */
export async function generateSpeechMedia(input: {
  call?: CallMeta;
  text: string;
  /** How to speak: "warm, ruhig, etwas schneller". */
  style?: string;
  abortSignal?: AbortSignal;
}): Promise<GeneratedMedia> {
  const speech = await speechModel(input.call);
  await checkContent({
    kind: "speech",
    text: input.style ? `${input.text}\n\nStyle: ${input.style}` : input.text,
    call: input.call,
    signal: input.abortSignal,
  });
  const result = await generateSpeech({
    model: speech.model,
    text: input.text,
    instructions: input.style || undefined,
    abortSignal: input.abortSignal,
  });
  const audio = result.audio;
  if (!audio?.uint8Array?.byteLength) {
    throw new Error("The speech model returned no audio.");
  }
  const mime = audio.mediaType ?? "audio/mpeg";
  const costUsd = speech.metered ? 0 : speechCostUsd(speech.ref, input.text.length);
  // As MP3, and saying in its tags that a model speaks here.
  const mp3 = await toMp3(
    audio.uint8Array,
    extFor(mime) === "bin" ? "wav" : extFor(mime),
    speechTags({ origin: "generated", system: speech.ref }),
  );
  return mp3
    ? { bytes: mp3, mime: "audio/mpeg", costUsd, system: speech.ref }
    : { bytes: audio.uint8Array, mime, costUsd, system: speech.ref };
}
