import { FIELD_WAYS, type Field, type PageStep } from "@engenty-wizards/shared/definition";
import type { RunView } from "@engenty-wizards/shared/run";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { eventText, t } from "../lib/i18n";
import type { useRun } from "./useRun";

/**
 * A live conversation with the wizard, in the browser: the person talks, the wizard talks back,
 * and the model drives the run through the same commands the chat has. Audio goes between the
 * browser and the speech model directly; the runtime only mints the secret and the rules.
 */

type Run = ReturnType<typeof useRun>;

export type VoiceState = "off" | "connecting" | "live" | "error";

/** What the page the run is on lends the conversation: its draft and its send. */
/** A line of what was said, as the model wrote it down. */
export interface Caption {
  id: string;
  who: "bot" | "me";
  text: string;
}

export interface PageBinding {
  step: PageStep;
  fields: Field[];
  values: Record<string, unknown>;
  setField(id: string, value: unknown): string | null;
  submit(): void;
}

interface Session {
  clientSecret: string;
  model: string;
  endpoint: string;
}

/** What the model may hear: fields it can fill by voice, not those of the person's device. */
const byVoice = (f: Field) => FIELD_WAYS[f.kind] !== "device";

/** A frame of the camera, small enough for the model and for a photo field. */
const FRAME_WIDTH = 1024;
/** While the person speaks, the model sees a frame at most this often. */
const FRAME_EVERY_MS = 4000;

function clip(text: string | undefined, max: number): string {
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max)} …` : text;
}

/** The run as the model reads it: what is waited for, in a few lines. */
export function stateText(view: RunView, page: PageBinding | null, camera = false): string {
  const lines: string[] = [`status: ${view.status}`, `camera: ${camera ? "on" : "off"}`];
  if (view.ask) {
    lines.push(
      view.ask.kind === "confirm"
        ? `question: the step wants to "${view.ask.action.summary}" in ${view.ask.service}; answer_ask allows or skips it`
        : `question: a sign-in at ${view.ask.site.host}; the person types it on the screen, wait`,
    );
    return lines.join("\n");
  }
  if (view.status === "running") {
    const latest = [...view.events]
      .reverse()
      .find((ev) => ev.type === "tool" || ev.type === "info" || ev.type === "step_started");
    lines.push(`working on: ${view.step?.title ?? ""}`);
    if (latest) {
      lines.push(`doing: ${eventText(latest)}`);
    }
    return lines.join("\n");
  }
  if (view.status === "done") {
    lines.push("done. made:");
    for (const { step, output } of view.shown) {
      lines.push(`- ${step.title}: ${clip(output?.text, 400) || "(a file, on the screen)"}`);
    }
    return lines.join("\n");
  }
  if (view.status === "failed") {
    lines.push(`failed: ${view.error ?? ""}; go_back or the person retries on the screen`);
    return lines.join("\n");
  }
  if (page) {
    lines.push(`page: ${page.step.title}`);
    for (const f of page.fields) {
      const value = page.values[f.id];
      const answered = value !== undefined && value !== null && value !== "";
      const how = byVoice(f)
        ? "by voice"
        : f.kind === "image"
          ? "with the camera (take_photo) or on the screen"
          : "on the screen only";
      const options = f.options?.length ? `; options: ${f.options.join(" | ")}` : "";
      lines.push(
        `- field ${f.id} (${f.kind}${f.required ? ", required" : ""}, ${how}): ${f.label}${f.help ? ` – ${f.help}` : ""}${options}${answered ? ` = ${clip(String(Array.isArray(value) ? value.join(", ") : value), 120)}` : " = (open)"}`,
      );
    }
    return lines.join("\n");
  }
  if (view.step?.type === "review") {
    lines.push(`review: ${view.step.title}`);
    for (const { step, output } of view.shown) {
      lines.push(
        `- ${step.id} "${step.title}": ${clip(output?.text, 600) || "(a picture or file, on the screen)"}`,
      );
    }
    lines.push(`regenerate allowed: ${view.step.regenerate ? "yes" : "no"}`);
    return lines.join("\n");
  }
  lines.push(`step: ${view.step?.title ?? ""}`);
  return lines.join("\n");
}

/**
 * The conversation on one run. `page` is what the page the run is on lends it; the hook keeps
 * the connection, tells the model when the run changes, and runs the model's tool calls.
 */
export function useLiveVoice(
  runId: string,
  view: RunView | null,
  run: Run,
  page: PageBinding | null,
) {
  const [state, setState] = useState<VoiceState>("off");
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [camera, setCamera] = useState(false);
  /** Which camera: the back one to show things, the front one to be seen. */
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  const [muted, setMuted] = useState(false);
  /** What was said, written down by the model, newest last. */
  const [captions, setCaptions] = useState<Caption[]>([]);
  const video = useRef<HTMLVideoElement | null>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const lastFrame = useRef(0);
  const cameraRef = useRef(false);
  cameraRef.current = camera;
  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pageRef = useRef(page);
  pageRef.current = page;
  const runRef = useRef(run);
  runRef.current = run;
  const lastState = useRef("");

  const send = useCallback((event: Record<string, unknown>) => {
    const ch = channel.current;
    if (ch && ch.readyState === "open") {
      ch.send(JSON.stringify(event));
    }
  }, []);

  /** A frame of the camera as a JPEG data URL, or null while the camera is off. */
  const frame = useCallback((): string | null => {
    const el = video.current;
    if (!cameraRef.current || !el || el.videoWidth === 0) {
      return null;
    }
    const scale = Math.min(1, FRAME_WIDTH / el.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(el.videoWidth * scale);
    canvas.height = Math.round(el.videoHeight * scale);
    canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.75);
  }, []);

  const stopCamera = useCallback(() => {
    for (const track of cameraStream.current?.getTracks() ?? []) {
      track.stop();
    }
    cameraStream.current = null;
    if (video.current) {
      video.current.srcObject = null;
    }
    setCamera(false);
  }, []);

  /** The camera the person shows things to: the back one on a phone, the one there is elsewhere. */
  const startCamera = useCallback(async (which?: "user" | "environment") => {
    if (cameraStream.current) {
      return;
    }
    const wanted = which ?? "environment";
    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: wanted }, width: { ideal: 1280 } },
        audio: false,
      });
      cameraStream.current = cam;
      // Which way the camera got looks: a laptop has only the front one, whatever was asked.
      const got = cam.getVideoTracks()[0]?.getSettings().facingMode;
      setFacing(got === "user" || got === "environment" ? got : wanted);
      if (video.current) {
        video.current.srcObject = cam;
        await video.current.play().catch(() => undefined);
      }
      setCamera(true);
    } catch (err) {
      setError(
        (err as Error).name === "NotAllowedError" ? t("talk.cameraDenied") : (err as Error).message,
      );
    }
  }, []);

  /** The other camera of a phone. */
  const flipCamera = useCallback(async () => {
    const next = facing === "user" ? "environment" : "user";
    stopCamera();
    await startCamera(next);
  }, [facing, stopCamera, startCamera]);

  /** The microphone stays open but silent. */
  const toggleMute = useCallback(() => {
    setMuted((was) => {
      for (const track of stream.current?.getAudioTracks() ?? []) {
        track.enabled = was;
      }
      return !was;
    });
  }, []);

  const stop = useCallback(() => {
    stopCamera();
    channel.current?.close();
    channel.current = null;
    pc.current?.close();
    pc.current = null;
    for (const track of stream.current?.getTracks() ?? []) {
      track.stop();
    }
    stream.current = null;
    if (audio.current) {
      audio.current.srcObject = null;
      audio.current.remove();
      audio.current = null;
    }
    lastState.current = "";
    setSpeaking(false);
    setListening(false);
    setMuted(false);
    setState("off");
  }, [stopCamera]);

  useEffect(() => () => stop(), [stop]);

  /** Runs one tool call of the model against the run, and says what came of it. */
  const call = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<string> => {
      const v = viewRef.current;
      const p = pageRef.current;
      const r = runRef.current;
      switch (name) {
        case "get_state":
          return v ? stateText(v, p, cameraRef.current) : "no run";
        case "look": {
          const shot = frame();
          if (!shot) {
            return "the camera is off; ask the person to switch it on";
          }
          send({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "[camera] what the person shows right now" },
                { type: "input_image", image_url: shot },
              ],
            },
          });
          return "a picture arrived as the next message";
        }
        case "take_photo": {
          if (!p) {
            return "no page is open";
          }
          const target = p.fields.find((f) => f.id === String(args.field ?? ""));
          if (target?.kind !== "image") {
            return "no such photo field on this page";
          }
          const shot = frame();
          if (!shot) {
            return "the camera is off; ask the person to switch it on";
          }
          try {
            const blob = await (await fetch(shot)).blob();
            const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
            const ref = await api.upload<{ id: string }>(`/api/runs/${runId}/uploads`, file);
            const had = p.values[target.id];
            const next = target.multiple
              ? [...(Array.isArray(had) ? had : had ? [had] : []), ref.id]
              : ref.id;
            const problem = p.setField(target.id, next);
            return problem ? `refused: ${problem}` : "the photo is in the field";
          } catch (err) {
            return `failed: ${(err as Error).message}`;
          }
        }
        case "set_field": {
          if (!p) {
            return "no page is open";
          }
          const problem = p.setField(String(args.field ?? ""), args.value);
          return problem ? `refused: ${problem}` : "kept";
        }
        case "submit_page": {
          if (!p) {
            return "no page is open";
          }
          const missing = p.fields.filter(
            (f) =>
              f.required &&
              byVoice(f) &&
              f.kind !== "toggle" &&
              (p.values[f.id] === undefined || p.values[f.id] === null || p.values[f.id] === ""),
          );
          if (missing.length) {
            return `still open: ${missing.map((f) => f.id).join(", ")}`;
          }
          p.submit();
          return "sent; wait for the next state";
        }
        case "accept_review":
          if (v?.step?.type !== "review") {
            return "no review is open";
          }
          return (await r.accept(v.step.id)) ? "accepted" : (r.error ?? "refused");
        case "regenerate":
          if (v?.step?.type !== "review") {
            return "no review is open";
          }
          return (await r.regenerate(v.step.id, String(args.target ?? ""), String(args.note ?? "")))
            ? "the wizard makes it again; wait"
            : (r.error ?? "refused");
        case "answer_ask":
          if (!v?.ask) {
            return "no question is open";
          }
          try {
            await api.post(`/api/runs/${runId}/ask/${v.ask.id}`, {
              type: args.allow ? "done" : "skip",
            });
            return args.allow ? "allowed" : "skipped";
          } catch (err) {
            return `refused: ${(err as Error).message}`;
          }
        case "go_back":
          return (await r.back()) ? "went back; wait for the state" : (r.error ?? "refused");
        default:
          return `unknown tool ${name}`;
      }
    },
    [runId, frame, send],
  );

  const start = useCallback(async () => {
    if (pc.current) {
      return;
    }
    setError(null);
    setCaptions([]);
    setState("connecting");
    try {
      const session = await api.post<Session>(`/api/runs/${runId}/talk`);
      // Echo cancellation takes the wizard's own voice out of what the mic hears.
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      stream.current = mic;
      const peer = new RTCPeerConnection();
      pc.current = peer;
      const out = document.createElement("audio");
      out.autoplay = true;
      out.setAttribute("playsinline", "");
      document.body.append(out);
      audio.current = out;
      peer.ontrack = (e) => {
        out.srcObject = e.streams[0];
      };
      for (const track of mic.getTracks()) {
        peer.addTrack(track, mic);
      }
      const ch = peer.createDataChannel("oai-events");
      channel.current = ch;
      ch.onmessage = (e) => {
        let event: { type: string; [k: string]: unknown };
        try {
          event = JSON.parse(e.data);
        } catch {
          return;
        }
        switch (event.type) {
          case "output_audio_buffer.started":
            setSpeaking(true);
            break;
          case "output_audio_buffer.stopped":
          case "output_audio_buffer.cleared":
            setSpeaking(false);
            break;
          case "input_audio_buffer.speech_started": {
            setListening(true);
            // With the camera on, what the person shows goes with what they say, now and then.
            const shot = Date.now() - lastFrame.current > FRAME_EVERY_MS ? frame() : null;
            if (shot) {
              lastFrame.current = Date.now();
              send({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [
                    { type: "input_text", text: "[camera] what the person shows while speaking" },
                    { type: "input_image", image_url: shot },
                  ],
                },
              });
            }
            break;
          }
          case "input_audio_buffer.speech_stopped":
            setListening(false);
            break;
          // What either side said, as text: the call screen's captions.
          case "response.output_audio_transcript.done":
          case "conversation.item.input_audio_transcription.completed": {
            const text = String(event.transcript ?? "").trim();
            if (text) {
              const who = event.type === "response.output_audio_transcript.done" ? "bot" : "me";
              setCaptions((all) => [...all.slice(-199), { id: `${Date.now()}:${who}`, who, text }]);
            }
            break;
          }
          case "response.function_call_arguments.done": {
            const name = String(event.name ?? "");
            const callId = String(event.call_id ?? "");
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(String(event.arguments ?? "{}"));
            } catch {
              // No arguments: the tool runs without.
            }
            void call(name, args).then((output) => {
              send({
                type: "conversation.item.create",
                item: { type: "function_call_output", call_id: callId, output },
              });
              send({ type: "response.create" });
            });
            break;
          }
          case "error":
            setError(String((event.error as { message?: string })?.message ?? "error"));
            break;
        }
      };
      ch.onopen = () => {
        setState("live");
        // The first thing said: what the run waits for, and a greeting.
        const v = viewRef.current;
        if (v) {
          lastState.current = stateText(v, pageRef.current, cameraRef.current);
          send({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `[state]\n${lastState.current}\n\nGreet the person in one sentence and ask the first open field.`,
                },
              ],
            },
          });
          send({ type: "response.create" });
        }
      };
      ch.onclose = () => {
        if (pc.current === peer) {
          stop();
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const res = await fetch(session.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.clientSecret}`,
          "content-type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!res.ok) {
        throw new Error(`${t("talk.failed")} (${res.status})`);
      }
      await peer.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch (err) {
      stop();
      setError(
        (err as Error).name === "NotAllowedError" ? t("chat.micDenied") : (err as Error).message,
      );
      setState("error");
    }
  }, [runId, call, frame, send, stop]);

  // The run moved: the model hears the new state, and speaks where there is something to say.
  useEffect(() => {
    if (state !== "live" || !view) {
      return;
    }
    const text = stateText(view, page, camera);
    if (text === lastState.current) {
      return;
    }
    const before = lastState.current;
    lastState.current = text;
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[state]\n${text}` }],
      },
    });
    // A note while the wizard works is told, not answered every time; a new step or page is.
    const quiet =
      view.status === "running" &&
      before.startsWith("status: running") &&
      !before.includes("working on: ")
        ? false
        : view.status === "running" && before.split("\n")[1] === text.split("\n")[1];
    if (!quiet) {
      send({ type: "response.create" });
    }
  }, [state, view, page, camera, send]);

  return {
    state,
    error,
    speaking,
    listening,
    start,
    stop,
    camera,
    facing,
    startCamera,
    stopCamera,
    flipCamera,
    muted,
    toggleMute,
    captions,
    video,
  };
}
