import { SPEECH_LOCALES } from "@engenty-wizards/shared/definition";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { lang } from "./i18n";

interface RecognitionResult {
  readonly isFinal: boolean;
  [index: number]: { readonly transcript: string };
}

interface RecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResult };
}

interface Recognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((ev: Event & { error: string }) => void) | null;
  onresult: ((ev: RecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionConstructor = new () => Recognition;

declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  }
}

/** Some shells have the browser's recognition but no service behind it; then the server listens. */
let recognitionBroken = false;

function recognition(): RecognitionConstructor | undefined {
  if (typeof window === "undefined" || recognitionBroken) {
    return undefined;
  }
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

const canRecord =
  typeof navigator !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  typeof MediaRecorder !== "undefined";

/** The person's choices for dictation, kept in this browser and shared by every composer. */
export interface DictationSettings {
  /** An input device; empty is the system's default. */
  deviceId: string;
  /** The mic button records while it is held, instead of on and off with a click. */
  hold: boolean;
}

const SETTINGS_KEY = "wizards.dictation";
const listeners = new Set<() => void>();
let settings: DictationSettings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return { deviceId: String(saved.deviceId ?? ""), hold: saved.hold === true };
  } catch {
    return { deviceId: "", hold: false };
  }
})();

export function useDictationSettings(): [
  DictationSettings,
  (patch: Partial<DictationSettings>) => void,
] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => settings,
  );
  const change = useCallback((patch: Partial<DictationSettings>) => {
    settings = { ...settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // kept for this visit only
    }
    for (const listener of listeners) {
      listener();
    }
  }, []);
  return [value, change];
}

/**
 * The microphones of this device. Their names come only once the browser may use one: `allow`
 * asks for that and lists them again.
 */
export function useMicrophones() {
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const list = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(
      all
        .filter(
          (d) =>
            // Without leave to use one, the browser lists microphones with no id and no name.
            d.kind === "audioinput" &&
            Boolean(d.deviceId) &&
            d.deviceId !== "default" &&
            d.deviceId !== "communications",
        )
        .map((d) => ({ deviceId: d.deviceId, label: d.label })),
    );
  }, []);
  useEffect(() => {
    void list();
    navigator.mediaDevices?.addEventListener?.("devicechange", list);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", list);
  }, [list]);
  const allow = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
    } catch {
      return false;
    }
    await list();
    return true;
  };
  return { devices, named: devices.some((d) => d.label), allow, refresh: list };
}

function join(before: string, spoken: string): string {
  const base = before.trimEnd();
  const next = spoken.trim();
  return base && next ? `${base} ${next}` : base || next;
}

/**
 * Speaking into a draft. The browser writes along where it can recognise speech; elsewhere the
 * recording is written down on the server once the person stops.
 */
export function useDictation(
  draft: string,
  onDraft: (value: string) => void,
  options: {
    /**
     * Where a recording is written down: the studio's route, or a run's own. null: nowhere
     * (someone not signed in), so only the browser's own recognition writes along.
     */
    endpoint?: string | null;
    /** A microphone of its own; the browser's recognition only hears the default one. */
    deviceId?: string;
  } = {},
) {
  const endpoint = options.endpoint === undefined ? "/api/studio/transcribe" : options.endpoint;
  const mayRecord = canRecord && endpoint !== null;
  const deviceId = options.deviceId ?? "";
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const active = useRef<{ stop: () => void } | null>(null);
  // A stop asked for while the microphone is still being opened: done once it is.
  const starting = useRef(false);
  const stopWhenStarted = useRef(false);

  useEffect(() => () => active.current?.stop(), []);

  const record = async () => {
    const before = draftRef.current;
    let stream: MediaStream;
    starting.current = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
    } catch {
      starting.current = false;
      stopWhenStarted.current = false;
      setError("denied");
      return;
    } finally {
      starting.current = false;
    }
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      active.current = null;
      setListening(false);
      const mime = (recorder.mimeType || "audio/webm").split(";")[0];
      const file = new File(chunks, "dictation", { type: mime });
      if (!(file.size && endpoint)) {
        return;
      }
      setProcessing(true);
      try {
        const { text } = await api.upload<{ text: string }>(endpoint, file);
        if (text.trim()) {
          onDraftRef.current(join(before, text));
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setProcessing(false);
      }
    };
    active.current = { stop: () => recorder.state !== "inactive" && recorder.stop() };
    recorder.start();
    setListening(true);
    if (stopWhenStarted.current) {
      stopWhenStarted.current = false;
      recorder.stop();
    }
  };

  const recognise = (Recognition: RecognitionConstructor) => {
    const before = draftRef.current;
    let committed = "";
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = SPEECH_LOCALES[lang];
    rec.onresult = (event) => {
      // Results below resultIndex were committed by an earlier event.
      let interim = "";
      for (let i = Math.max(0, event.resultIndex); i < event.results.length; i++) {
        const result = event.results[i];
        const said = result[0]?.transcript ?? "";
        if (result.isFinal) {
          committed = join(committed, said);
        } else {
          interim += said;
        }
      }
      onDraftRef.current(join(before, join(committed, interim)));
    };
    rec.onerror = (event) => {
      if (event.error === "aborted" || event.error === "no-speech") {
        return;
      }
      if (event.error === "not-allowed") {
        setError("denied");
        return;
      }
      // No recognition service behind the API: from now on the recording goes to the server.
      recognitionBroken = true;
      if (mayRecord && !committed) {
        rec.onend = null;
        active.current = null;
        void record();
      } else {
        setError(event.error);
      }
    };
    rec.onend = () => {
      active.current = null;
      setListening(false);
    };
    active.current = { stop: () => rec.stop() };
    rec.start();
    setListening(true);
  };

  const start = () => {
    if (processing || active.current || starting.current) {
      return;
    }
    setError(null);
    stopWhenStarted.current = false;
    const Recognition = recognition();
    if (Recognition && !(deviceId && mayRecord)) {
      recognise(Recognition);
    } else if (mayRecord) {
      void record();
    }
  };
  const stop = () => {
    if (active.current) {
      active.current.stop();
    } else if (starting.current) {
      stopWhenStarted.current = true;
    }
  };
  const toggle = () => {
    if (active.current) {
      stop();
    } else {
      start();
    }
  };

  return {
    supported: Boolean(recognition()) || mayRecord,
    listening,
    processing,
    error,
    toggle,
    start,
    stop,
  };
}
