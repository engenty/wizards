import { useEffect, useState, useSyncExternalStore } from "react";
import { appCall, appCan, appTell, asset, runnerEnv } from "./env.js";

/** A finger as the main pointer: a phone or a tablet. */
export const isTouch =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

/** The camera, the microphone and the position only exist on https (and localhost). */
export const canUseMedia =
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * Keeps `--kb` on the root: how much of the page the on-screen keyboard covers. iOS lays the
 * keyboard over the page without resizing it, so a bar stuck to the bottom would hide behind it.
 */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }
    const root = document.documentElement;
    // The field being typed in stays in sight: above the bar on the keyboard (its
    // scroll-margin, app.css), once the keyboard is up and on every move to another field.
    const reveal = () => {
      const el = document.activeElement;
      if (
        root.classList.contains("keyboard-open") &&
        el instanceof HTMLElement &&
        el !== document.body
      ) {
        requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
      }
    };
    const update = () => {
      // Pinch-zoom shrinks the visual viewport too; only an unzoomed page measures the keyboard.
      const covered = vv.scale > 1.01 ? 0 : window.innerHeight - vv.height - vv.offsetTop;
      const open = covered > 80;
      const opened = open && !root.classList.contains("keyboard-open");
      root.style.setProperty("--kb", open ? `${Math.round(covered)}px` : "0px");
      root.classList.toggle("keyboard-open", open);
      if (opened) {
        reveal();
      }
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", reveal);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", reveal);
      root.style.removeProperty("--kb");
      root.classList.remove("keyboard-open");
    };
  }, []);
}

/**
 * Keeps the screen on while `active` — a phone that dims and locks mid-step freezes the page.
 * The lock ends whenever the page is hidden and is taken again when the person comes back.
 */
export function useWakeLock(active: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (active && appCan("keepAwake")) {
      // The app keeps the screen on; the page's lock ends whenever iOS hides the WebView.
      appTell("keepAwake", true);
      setHeld(true);
      return () => {
        appTell("keepAwake", false);
        setHeld(false);
      };
    }
    if (!active || !("wakeLock" in navigator)) {
      return;
    }
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      if (stopped || lock || document.visibilityState !== "visible") {
        return;
      }
      try {
        const taken = await navigator.wakeLock.request("screen");
        if (stopped) {
          void taken.release().catch(() => undefined);
          return;
        }
        lock = taken;
        setHeld(true);
        taken.addEventListener("release", () => {
          if (lock === taken) {
            lock = null;
            setHeld(false);
          }
        });
      } catch {
        // Low battery or a browser policy: the run goes on, the screen may dim.
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => undefined);
      lock = null;
      setHeld(false);
    };
  }, [active]);
  return held;
}

// --- telling the person a long step is done ----------------------------------------------

const NOTIFY_KEY = "wz.notify";
const listeners = new Set<() => void>();
let audio: AudioContext | null = null;

function wanted(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

function setWanted(on: boolean) {
  try {
    if (on) {
      localStorage.setItem(NOTIFY_KEY, "1");
    } else {
      localStorage.removeItem(NOTIFY_KEY);
    }
  } catch {
    // private mode: the wish lasts until the page is reloaded
  }
  for (const listener of listeners) {
    listener();
  }
}

const hasNotifications = typeof window !== "undefined" && "Notification" in window;

/**
 * `off` — not asked for. `on` — a notification when the page is in the background, a sound and a
 * buzz when it is open. `quiet` — asked for, but the browser shows no notifications for this
 * page (blocked, or a phone browser without them): only sound and buzz while the page is open.
 */
export type NotifyState = "off" | "on" | "quiet";

/** In the mobile app: what the person answered the app's own question. */
let appAllows: boolean | null = null;

function notifyState(): NotifyState {
  if (!wanted()) {
    return "off";
  }
  if (appCan("notify")) {
    return appAllows === false ? "quiet" : "on";
  }
  return hasNotifications && Notification.permission === "granted" ? "on" : "quiet";
}

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyState,
    () => "off" as const,
  );
}

/** Whether the browser has blocked notifications for this page (the person can undo it there). */
export function notificationsBlocked(): boolean {
  if (appCan("notify")) {
    return appAllows === false;
  }
  return hasNotifications && Notification.permission === "denied";
}

/**
 * The person asks to be told. Called from their tap: the browser's permission question and the
 * sound both need one.
 */
export async function enableNotify(): Promise<NotifyState> {
  setWanted(true);
  if (appCan("notify")) {
    appAllows = appCan("notifyPermission")
      ? await appCall<boolean>("notifyPermission").catch(() => false)
      : true;
    for (const listener of listeners) {
      listener();
    }
    return notifyState();
  }
  // A sound may only play on a page the person has tapped; this is that tap.
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = null;
  }
  if (hasNotifications && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // stays "default": sound and buzz only
    }
  }
  if (hasNotifications && Notification.permission === "granted") {
    // Phones only show a page's notification through a service worker.
    const worker = runnerEnv().serviceWorker;
    if (worker) {
      await navigator.serviceWorker?.register(worker).catch(() => undefined);
    }
  }
  for (const listener of listeners) {
    listener();
  }
  return notifyState();
}

export function disableNotify() {
  setWanted(false);
}

function chime() {
  const ctx = audio;
  if (ctx?.state !== "running") {
    return;
  }
  const now = ctx.currentTime;
  for (const [i, freq] of [660, 880].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + i * 0.16);
    gain.gain.linearRampToValueAtTime(0.18, now + i * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.16 + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.16);
    osc.stop(now + i * 0.16 + 0.34);
  }
}

/** Tells the person, in whatever way they agreed to and the device has. A no-op otherwise. */
export async function signalPerson(message: { title: string; body: string; tag: string }) {
  if (!wanted()) {
    return;
  }
  if (appCan("notify")) {
    // The app knows whether it is in front: a buzz there, a notification otherwise.
    appTell("notify", message);
    return;
  }
  if (document.visibilityState === "visible") {
    chime();
    navigator.vibrate?.([120, 60, 120]);
    return;
  }
  if (!hasNotifications || Notification.permission !== "granted") {
    return;
  }
  const options = {
    body: message.body,
    tag: message.tag,
    icon: asset("icons/icon-192.png"),
    badge: asset("icons/icon-192.png"),
    data: { url: location.href },
  };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.active) {
      await registration.showNotification(message.title, options);
      return;
    }
  } catch {
    // falls through to the page's own notification
  }
  try {
    new Notification(message.title, options);
  } catch {
    // a phone without the service worker: the page title still says it
  }
}

/** A share sheet that takes files: phones, and desktop Safari and Chrome. */
export function canShareFiles(): boolean {
  if (typeof navigator === "undefined" || !navigator.canShare) {
    return false;
  }
  try {
    return navigator.canShare({ files: [new File(["x"], "x.pdf", { type: "application/pdf" })] });
  } catch {
    return false;
  }
}
