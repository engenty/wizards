import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@engenty/chatviews/react/ui";
import { useEffect, useRef } from "react";
import { useSetupHost } from "./host.js";

/**
 * A terminal of the host, shown inline: what the command prints arrives as a stream, every key
 * goes back to it. The host keeps the session; this is its screen and keyboard.
 */
export default function Terminal({
  id,
  onExit,
  onDone,
  className,
}: {
  id: string;
  /** The command ended with this exit code. */
  onExit?: (code: number) => void;
  /** The command did what it was started for; it may still be running. */
  onDone?: () => void;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef(useSetupHost());
  const exit = useRef(onExit);
  exit.current = onExit;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const at = el.current;
    if (!at) {
      return;
    }
    const host = api.current;
    const term = new Xterm({
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      cursorBlink: true,
      scrollback: 3000,
      theme: {
        background: "#0f1424",
        foreground: "#e6e9f2",
        cursor: "#f0b35b",
        selectionBackground: "#2f3a5f",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // A sign-in link the browser did not open by itself: a click opens it.
    term.loadAddon(new WebLinksAddon((_event, uri) => host.open(uri)));
    term.open(at);
    const path = `/terminal/${id}`;
    const quiet = () => undefined;
    const sync = () => {
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
      void host.post(`${path}/resize`, { cols: term.cols, rows: term.rows }).catch(quiet);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(at);
    const input = term.onData((data) => void host.post(`${path}/input`, { data }).catch(quiet));
    const stop = host.follow(id, (event) => {
      if (event.type === "data") {
        term.write(event.data);
      } else if (event.type === "done") {
        done.current?.();
      } else {
        exit.current?.(event.code);
      }
    });
    term.focus();
    return () => {
      stop();
      observer.disconnect();
      input.dispose();
      term.dispose();
    };
  }, [id]);
  return (
    <div
      ref={el}
      className={cn(
        "h-[28rem] max-h-[60dvh] w-full overflow-hidden rounded-lg bg-[#0f1424] p-2",
        className,
      )}
    />
  );
}
