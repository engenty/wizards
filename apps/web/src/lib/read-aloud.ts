import { speechLocaleOf } from "@engenty-wizards/shared/definition";
import { useCallback, useEffect, useRef, useState } from "react";
import { lang as uiLang } from "./i18n";

/**
 * Reading aloud with the browser's own voices: nothing leaves the page, nothing costs. An
 * accessibility feature of the chat, switched on per browser.
 */

const KEY = "wz.readAloud";

export const canSpeak =
  typeof window !== "undefined" &&
  "speechSynthesis" in window &&
  "SpeechSynthesisUtterance" in window;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function keep(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // A private window: the choice holds for this page.
  }
}

/** A voice of the page's language, the browser's default one of them where there are several. */
function voiceFor(code: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const short = code.slice(0, 2);
  return (
    voices.find((v) => v.lang === code && v.default) ??
    voices.find((v) => v.lang === code) ??
    voices.find((v) => v.lang.startsWith(short) && v.default) ??
    voices.find((v) => v.lang.startsWith(short)) ??
    null
  );
}

/** Says `text` in the wizard's language after what is being said; `now` drops the queue first. */
export function speak(text: string, lang: string = uiLang, now = false) {
  if (!canSpeak || !text.trim()) {
    return;
  }
  const synth = window.speechSynthesis;
  if (now) {
    synth.cancel();
  }
  const code = speechLocaleOf(lang);
  const utterance = new SpeechSynthesisUtterance(text.trim().slice(0, 2000));
  utterance.lang = code;
  const voice = voiceFor(code);
  if (voice) {
    utterance.voice = voice;
  }
  synth.speak(utterance);
}

/** Says `text` now, dropping what is being said; resolves when it is said or cut off. */
export function say(text: string, lang: string = uiLang): Promise<void> {
  if (!canSpeak || !text.trim()) {
    return Promise.resolve();
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const code = speechLocaleOf(lang);
  const utterance = new SpeechSynthesisUtterance(text.trim().slice(0, 4000));
  utterance.lang = code;
  const voice = voiceFor(code);
  if (voice) {
    utterance.voice = voice;
  }
  return new Promise((resolve) => {
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    synth.speak(utterance);
  });
}

/** Markdown as it is said: no marks, links by their words, lists as sentences. */
export function spokenText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hush() {
  if (canSpeak) {
    window.speechSynthesis.cancel();
  }
}

/** Whether the chat reads aloud, kept per browser; off stops what is being said. */
export function useReadAloud(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => canSpeak && read());
  const set = useCallback((next: boolean) => {
    setOn(next);
    keep(next);
    if (!next) {
      hush();
    }
  }, []);
  // Voices arrive late in some browsers; asking once makes them load for the first utterance.
  useEffect(() => {
    if (canSpeak) {
      window.speechSynthesis.getVoices();
    }
  }, []);
  useEffect(() => () => hush(), []);
  return [on, set];
}

/**
 * Reads what is new in a thread: the bubbles of the wizard that were not there before, by their
 * keys, as text. On the first look only the last of them is read, not the whole history; an
 * answer of the person drops what is still being said.
 */
export function useReadLines(
  on: boolean,
  lang: string,
  lines: { key: string; who: "bot" | "me"; spoken?: boolean }[],
  textOf: (key: string) => string | null,
) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!on) {
      seen.current = null;
      return;
    }
    const keys = lines.map((l) => l.key);
    if (!seen.current) {
      // Switched on, or just opened: the last thing the wizard said is read, not everything.
      seen.current = new Set(keys);
      const last = [...lines].reverse().find((l) => l.who === "bot" && l.spoken !== false);
      if (last) {
        const text = textOf(last.key);
        if (text) {
          speak(text, lang, true);
        }
      }
      return;
    }
    const fresh = lines.filter((l) => !seen.current?.has(l.key));
    for (const key of keys) {
      seen.current.add(key);
    }
    if (fresh.some((l) => l.who === "me")) {
      hush();
    }
    for (const line of fresh) {
      if (line.who === "bot" && line.spoken !== false) {
        const text = textOf(line.key);
        if (text) {
          speak(text, lang);
        }
      }
    }
  }, [on, lang, lines, textOf]);
}
