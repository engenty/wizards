import { SPEECH_LOCALES } from "@engenty-wizards/shared/definition";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { withBase } from "../../lib/base";
import { lang } from "../../lib/i18n";
import { hush, say, spokenText } from "../../lib/read-aloud";
import type { Chat } from "../editor/ChatPanel";

/**
 * Live chat with the studio assistant, the browser's way: the browser turns speech into text
 * (Chrome with Google's service, Safari with Apple's), a pause sends it as a normal message, the
 * same assistant answers, and the answer is read aloud — by the speech model where one is set up
 * and chosen, else by the computer's voices. Then it listens again. Talking over it stops its
 * voice. Where the browser cannot recognise speech (Firefox), it records, and a pause sends the
 * recording to be written down.
 */

export type LiveState = "off" | "listening" | "thinking" | "speaking";

/** Silence after speech that ends what the person says. */
const PAUSE_MS = 1300;

/** How long after its voice ends the recognition may still hand in what the speakers played. */
const TAIL_MS = 3000;

interface Recognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((ev: Event & { error: string }) => void) | null;
  onresult:
    | ((ev: {
        resultIndex: number;
        results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } };
      }) => void)
    | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

function recognition(): RecognitionConstructor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const canLive =
  typeof window !== "undefined" &&
  (Boolean(recognition()) ||
    (Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined"));

/** Words without case, marks or hyphens, so "Editor-Chats," and "editorchats" are the same. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-–—/]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

/**
 * Does `heard` sound like the voice we play, not the person? Speakers echo into the mic, and the
 * recognition mishears a word now and then: most of the words being in what was said is enough.
 */
function echo(heard: string, playing: string): boolean {
  const said = new Set(words(playing));
  const got = words(heard);
  if (got.length < 2) {
    return true;
  }
  return got.filter((w) => said.has(w)).length / got.length >= 0.75;
}

export function useLiveChat(chat: Chat) {
  const [state, setState] = useState<LiveState>("off");
  const [muted, setMuted] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState("");
  /** Read aloud by the speech model: where one is set up, and on by default where it costs no credits. */
  const [voice, setVoice] = useState<{ way: string; natural: boolean } | null>(null);

  const stateRef = useRef<LiveState>("off");
  const mutedRef = useRef(false);
  const rec = useRef<Recognition | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const playing = useRef("");
  /** What its voice said last and until when the recognition may still hand it in. */
  const lastSaid = useRef<{ text: string; until: number }>({ text: "", until: 0 });
  const pending = useRef("");
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answeredUpTo = useRef<string | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const set = useCallback((next: LiveState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopVoice = useCallback(() => {
    hush();
    if (audio.current) {
      audio.current.pause();
      audio.current = null;
    }
    playing.current = "";
  }, []);

  const flush = useCallback(() => {
    if (pause.current) {
      clearTimeout(pause.current);
      pause.current = null;
    }
    const text = pending.current.trim();
    pending.current = "";
    setHeard("");
    if (!text || stateRef.current === "off") {
      return;
    }
    set("thinking");
    answeredUpTo.current = chatRef.current.messages.at(-1)?.id ?? null;
    void chatRef.current.send(text).then((sent) => {
      if (!sent && stateRef.current === "thinking") {
        set("listening");
      }
    });
  }, [set]);

  /** What the person said so far; a pause after it sends it. */
  const onSpeech = useCallback(
    (text: string, final: boolean) => {
      if (mutedRef.current || stateRef.current === "off" || stateRef.current === "thinking") {
        return;
      }
      if (stateRef.current === "speaking") {
        if (echo(text, playing.current)) {
          return;
        }
        // Talked over: its voice stops, and what was said counts.
        stopVoice();
        set("listening");
      } else if (Date.now() < lastSaid.current.until && echo(text, lastSaid.current.text)) {
        // The end of its own voice, handed in late.
        return;
      }
      setHeard(text);
      if (final) {
        pending.current = `${pending.current} ${text}`.trim();
        setHeard(pending.current);
      }
      if (pause.current) {
        clearTimeout(pause.current);
      }
      pause.current = setTimeout(flush, PAUSE_MS);
    },
    [flush, stopVoice, set],
  );

  // --- listening ---------------------------------------------------------------------------

  const listen = useCallback(() => {
    const Recognition = recognition();
    if (!Recognition || rec.current) {
      return;
    }
    const r = new Recognition();
    r.continuous = true;
    r.interimResults = true;
    r.lang = SPEECH_LOCALES[lang];
    r.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          onSpeech(result[0].transcript, true);
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim.trim()) {
        onSpeech(`${pending.current} ${interim}`.trim(), false);
      }
    };
    r.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("denied");
      }
    };
    // Chrome ends a recognition after a while of silence: it starts again while the call is on.
    r.onend = () => {
      rec.current = null;
      if (stateRef.current !== "off" && !mutedRef.current) {
        setTimeout(listen, 200);
      }
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      rec.current = null;
    }
  }, [onSpeech]);

  /** Without recognition: a recording per utterance, written down on the server. */
  const record = useCallback(
    (media: MediaStream, analyser: AnalyserNode) => {
      let recorder: MediaRecorder | null = null;
      let chunks: Blob[] = [];
      let spokeAt = 0;
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (stateRef.current === "off") {
          recorder?.stop();
          return;
        }
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) {
          peak = Math.max(peak, Math.abs(v - 128) / 128);
        }
        const loud = peak > 0.08 && !mutedRef.current && stateRef.current === "listening";
        if (loud) {
          spokeAt = Date.now();
          if (!recorder) {
            const tail = Date.now() < lastSaid.current.until ? lastSaid.current.text : "";
            chunks = [];
            recorder = new MediaRecorder(media);
            recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
            recorder.onstop = async () => {
              const file = new File(chunks, "live", {
                type: (recorder?.mimeType || "audio/webm").split(";")[0],
              });
              recorder = null;
              if (!file.size || stateRef.current === "off") {
                return;
              }
              set("thinking");
              try {
                const { text } = await api.upload<{ text: string }>("/api/studio/transcribe", file);
                if (tail && echo(text, tail)) {
                  set("listening");
                  return;
                }
                pending.current = text;
                flush();
              } catch (err) {
                setError((err as Error).message);
                set("listening");
              }
            };
            recorder.start();
          }
        } else if (recorder && Date.now() - spokeAt > PAUSE_MS) {
          recorder.stop();
        }
        setTimeout(tick, 100);
      };
      tick();
    },
    [flush, set],
  );

  // --- the call ----------------------------------------------------------------------------

  const start = useCallback(async () => {
    if (stateRef.current !== "off") {
      return;
    }
    setError(null);
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setError("denied");
      return;
    }
    stream.current = media;
    answeredUpTo.current = chatRef.current.messages.at(-1)?.id ?? null;
    set("listening");
    setSince(Date.now());
    // The level bars, and without recognition the pauses, come from the microphone itself.
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(media).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const meter = () => {
      if (stateRef.current === "off") {
        void context.close();
        return;
      }
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) {
        peak = Math.max(peak, Math.abs(v - 128) / 128);
      }
      setLevel(mutedRef.current ? 0 : Math.min(1, peak * 3));
      setTimeout(meter, 90);
    };
    meter();
    if (recognition()) {
      listen();
    } else {
      record(media, analyser);
    }
    if (!voiceRef.current) {
      void api
        .get<{ way: string }>("/api/studio/assistant/voice")
        .then(({ way }) => setVoice({ way, natural: way === "key" || way === "local" }))
        .catch(() => setVoice({ way: "none", natural: false }));
    }
  }, [listen, record, set]);

  const end = useCallback(() => {
    set("off");
    setSince(null);
    setHeard("");
    setLevel(0);
    pending.current = "";
    if (pause.current) {
      clearTimeout(pause.current);
    }
    rec.current?.abort();
    rec.current = null;
    stopVoice();
    for (const track of stream.current?.getTracks() ?? []) {
      track.stop();
    }
    stream.current = null;
  }, [stopVoice, set]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    for (const track of stream.current?.getAudioTracks() ?? []) {
      track.enabled = !next;
    }
    if (next) {
      rec.current?.abort();
      rec.current = null;
    } else if (stateRef.current !== "off") {
      listen();
    }
  }, [listen]);

  /** Reads the answer aloud, then listens again. */
  const speakAnswer = useCallback(
    async (markdown: string) => {
      const text = spokenText(markdown);
      if (!text) {
        set("listening");
        return;
      }
      set("speaking");
      playing.current = text;
      const natural = voiceRef.current?.natural && voiceRef.current.way !== "none";
      let said = false;
      if (natural) {
        try {
          const res = await fetch(withBase("/api/studio/assistant/speak"), {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: text.slice(0, 4000) }),
          });
          if (res.ok && stateRef.current === "speaking") {
            const url = URL.createObjectURL(await res.blob());
            const player = new Audio(url);
            audio.current = player;
            await new Promise<void>((resolve) => {
              player.onended = () => resolve();
              player.onerror = () => resolve();
              player.onpause = () => resolve();
              void player.play().catch(() => resolve());
            });
            URL.revokeObjectURL(url);
            said = true;
          }
        } catch {
          // The browser's voices say it instead.
        }
      }
      if (!said && stateRef.current === "speaking") {
        await say(text, lang);
      }
      audio.current = null;
      playing.current = "";
      if (stateRef.current === "speaking") {
        lastSaid.current = { text, until: Date.now() + TAIL_MS };
        // What the recognition holds now is its own voice: a fresh one listens from here.
        pending.current = "";
        setHeard("");
        rec.current?.abort();
        set("listening");
      }
    },
    [set],
  );

  // A turn that ends during the call: its answer is said.
  useEffect(() => {
    if (state !== "thinking" || chat.phase !== "idle") {
      return;
    }
    const last = chat.messages.at(-1);
    if (last?.role === "assistant" && last.id !== answeredUpTo.current && !last.pending) {
      answeredUpTo.current = last.id;
      void speakAnswer(last.content);
    } else if (chat.error) {
      set("listening");
    }
  }, [state, chat.phase, chat.messages, chat.error, speakAnswer, set]);

  useEffect(() => () => end(), [end]);

  return {
    state,
    muted,
    since,
    error,
    level,
    heard,
    voice,
    setNatural: (natural: boolean) => setVoice((v) => (v ? { ...v, natural } : v)),
    start,
    end,
    toggleMute,
  };
}

export type LiveChat = ReturnType<typeof useLiveChat>;
