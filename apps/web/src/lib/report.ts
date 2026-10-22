import { keepLine } from "../report/log";
import { withBase } from "./base";

/**
 * A page tells the runtime of an error it met — a thrown error, a promise nobody caught, a
 * call the server failed — so a look at the runtime from afar sees the browser's side too. A few
 * per page load, each once; nothing a person typed goes along.
 */
const seen = new Set<string>();
let sent = 0;
const MOST = 20;

export function report(level: "error" | "warn", message: string, stack?: string) {
  const text = String(message || "").slice(0, 2000);
  keepLine(level, text);
  if (!text || sent >= MOST || seen.has(text)) {
    return;
  }
  seen.add(text);
  sent++;
  const body = JSON.stringify({
    level,
    message: text,
    stack: stack?.slice(0, 4000),
    url: window.location.href.slice(0, 500),
    agent: navigator.userAgent.slice(0, 300),
  });
  fetch(withBase("/api/log"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "include",
  }).catch(() => undefined);
}

/** Hooks the window once. */
export function watchErrors() {
  window.addEventListener("error", (event) => {
    const error = event.error as { stack?: string } | undefined;
    report("error", event.message || String(event.error), error?.stack);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined;
    report("error", reason?.message ?? String(event.reason), reason?.stack);
  });
}
