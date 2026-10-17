// The tag a website shows a wizard with. Where the tag stands, the wizard appears:
//
//   <script async src="https://…/embed.js" data-wizard="<token>"></script>
//     in the page, as tall as its content
//   <script async src="https://…/embed.js" data-wizard="<token>" data-mode="modal" data-label="Start"></script>
//     a button that opens it in a window over the page
//   <script async src="https://…/embed.js" data-wizard="<token>" data-runner="chat"></script>
//     as a chat in the page, 640 px high (data-height="…" in px)
//   <script async src="https://…/embed.js" data-wizard="<token>" data-mode="popout"></script>
//     a chat button with the wizard's engenty in the page's lower right corner that opens the
//     chat above it (data-label="…" puts words beside it, data-color="#…" colours that pill and
//     the open button)
//
//   <script async src="https://…/embed.js" data-wizard="<token>" data-mode="bubble" data-label="Fragen?"></script>
//     a round button at the bottom right of every page that opens it in the window;
//     `data-text` puts a short line beside it, `data-color` gives it the website's colour
//
// The button takes the website's own styles: `.engenty-wizard-button`, `.engenty-wizard-launcher`,
// `.engenty-wizard-bubble`. `data-page`: the address of the page the run is started on, kept with its
// result (the page's own address when left out).
(() => {
  const script = document.currentScript;
  const token = script?.dataset.wizard;
  if (!script || !token) {
    return;
  }
  // The app lives where this file does: https://example.com/wizards/embed.js → …/wizards/w/<token>.
  const app = new URL(".", script.src);
  const mode = ["modal", "popout", "bubble"].includes(script.dataset.mode)
    ? script.dataset.mode
    : "inline";
  // A popout is always a chat.
  const chat = script.dataset.runner === "chat" || mode === "popout";
  const label = script.dataset.label || (mode === "popout" ? "" : "Start");
  const page = (script.dataset.page || location.href).split("#")[0].slice(0, 2000);

  const frame = () => {
    const el = document.createElement("iframe");
    // In the bubble the wizard opens in the same window as behind a button.
    const shown = mode === "bubble" ? "modal" : mode;
    el.src = `${app.href}w/${encodeURIComponent(token)}${chat ? "/chat" : ""}?embed=${shown}&page=${encodeURIComponent(page)}`;
    el.title = label;
    // What a page of the wizard may ask the visitor for: photos, voice notes, the position.
    el.allow = "camera; microphone; geolocation; clipboard-write; fullscreen; screen-wake-lock";
    return el;
  };
  /** What the wizard in `el` tells this page (`lib/embed.ts`). */
  const listen = (el, type, then) =>
    addEventListener("message", (event) => {
      if (
        event.source === el.contentWindow &&
        event.origin === app.origin &&
        event.data?.type === `engenty-wizard:${type}`
      ) {
        then(event.data);
      }
    });

  if (mode === "inline" && chat) {
    // A chat scrolls inside its own box; the website gives it the height.
    const el = frame();
    const height = Number(script.dataset.height) || 640;
    el.style.cssText = `display:block;width:100%;height:${height}px;border:1px solid rgba(0,0,0,.1);border-radius:16px;overflow:hidden`;
    script.after(el);
    return;
  }

  if (mode === "inline") {
    const el = frame();
    el.style.cssText = "display:block;width:100%;height:640px;border:0";
    listen(el, "height", ({ height }) => {
      el.style.height = `${Number(height) || 640}px`;
    });
    script.after(el);
    return;
  }

  if (mode === "popout") {
    // In the page's <head> the script can run before there is a body to put the button in.
    if (document.body) {
      popout();
    } else {
      addEventListener("DOMContentLoaded", popout);
    }
    return;
  }

  if (!document.getElementById("engenty-wizard-style")) {
    const style = document.createElement("style");
    style.id = "engenty-wizard-style";
    // :where() weighs nothing, so any rule of the website restyles the button.
    style.textContent = `
:where(.engenty-wizard-button){font:inherit;font-weight:600;line-height:1.2;color:#fff;background:#1c1917;border:0;border-radius:999px;padding:.8em 1.6em;cursor:pointer}
.engenty-wizard-dialog{position:fixed;inset:0;width:min(720px,calc(100vw - 32px));height:min(860px,calc(100dvh - 32px));max-width:none;max-height:none;margin:auto;padding:0;border:0;border-radius:16px;overflow:hidden;background:#faf8f5;box-shadow:0 24px 64px rgba(0,0,0,.3)}
.engenty-wizard-dialog::backdrop{background:rgba(20,18,16,.5)}
.engenty-wizard-dialog iframe{display:block;width:100%;height:100%;border:0}
.engenty-wizard-close{position:absolute;top:10px;right:10px;display:flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:50%;color:#fff;background:rgba(20,18,16,.55);cursor:pointer}
.engenty-wizard-bubble-wrap{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:10px}
:where(.engenty-wizard-bubble){display:flex;align-items:center;justify-content:center;width:58px;height:58px;padding:0;border:0;border-radius:50%;color:#fff;background:var(--engenty-bubble,#1c1917);box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;transition:transform .15s}
:where(.engenty-wizard-bubble):hover{transform:scale(1.06)}
:where(.engenty-wizard-bubble-text){font:inherit;font-size:14px;line-height:1.3;max-width:220px;padding:10px 14px;border:0;border-radius:14px;color:#1c1917;background:#fff;box-shadow:0 6px 20px rgba(0,0,0,.15);cursor:pointer;text-align:left}
@media (max-width:640px){.engenty-wizard-dialog{width:100vw;height:100dvh;border-radius:0}.engenty-wizard-bubble-text{display:none}}`;
    document.head.append(style);
  }

  let button;
  if (mode === "bubble") {
    // One bubble a page: a second tag for another wizard stays silent.
    if (document.querySelector(".engenty-wizard-bubble")) {
      return;
    }
    button = document.createElement("button");
    button.className = "engenty-wizard-bubble";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (script.dataset.color) {
      button.style.setProperty("--engenty-bubble", script.dataset.color);
    }
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true"><path d="M4 12a8 8 0 1 1 3.4 6.5L4 20l1.2-3.6A7.9 7.9 0 0 1 4 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 11h7M8.5 14h4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const wrap = document.createElement("div");
    wrap.className = "engenty-wizard-bubble-wrap";
    if (script.dataset.text) {
      const text = document.createElement("button");
      text.type = "button";
      text.className = "engenty-wizard-bubble-text";
      text.textContent = script.dataset.text;
      text.addEventListener("click", () => button.click());
      wrap.append(text);
    }
    wrap.append(button);
    // In the page's <head> the script can run before there is a body to put the bubble in.
    if (document.body) {
      document.body.append(wrap);
    } else {
      addEventListener("DOMContentLoaded", () => document.body.append(wrap));
    }
  } else {
    button = document.createElement("button");
    button.className = "engenty-wizard-button";
    button.textContent = label;
    script.after(button);
  }
  button.type = "button";

  let dialog = null;
  button.addEventListener("click", () => {
    // Built at the first click and kept: closed and opened again, the wizard is where it was.
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "engenty-wizard-dialog";
      const el = frame();
      const close = document.createElement("button");
      close.type = "button";
      close.className = "engenty-wizard-close";
      close.setAttribute("aria-label", "Close");
      close.innerHTML =
        '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      close.addEventListener("click", () => dialog.close());
      listen(el, "close", () => dialog.close());
      // A click beside the window lands on the dialog itself: its backdrop.
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) {
          dialog.close();
        }
      });
      dialog.addEventListener("close", () => {
        document.documentElement.style.overflow = dialog.dataset.overflow ?? "";
      });
      dialog.append(el, close);
      document.body.append(dialog);
    }
    // The page behind stays where it is while the window is open.
    dialog.dataset.overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
  });

  /** The chat button in the corner, and the chat it opens above itself. */
  function popout() {
    if (!document.getElementById("engenty-wizard-popout-style")) {
      const style = document.createElement("style");
      style.id = "engenty-wizard-popout-style";
      style.textContent = `
:where(.engenty-wizard-launcher){position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:.6em;width:60px;height:60px;padding:0;font:inherit;font-weight:600;line-height:1;color:#fff;background:var(--engenty-wizard-color,#1c1917);border:0;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.25);overflow:hidden;cursor:pointer;transition:transform .2s}
:where(.engenty-wizard-launcher.engenty-wizard-labelled){width:auto;padding:0 20px 0 6px}
.engenty-wizard-launcher:hover{transform:scale(1.05)}
.engenty-wizard-launcher svg{flex:none}
.engenty-wizard-avatar{display:block;flex:none;width:100%;height:100%;border-radius:50%;object-fit:cover}
.engenty-wizard-labelled .engenty-wizard-avatar{width:48px;height:48px}
.engenty-wizard-launcher .engenty-wizard-open,.engenty-wizard-launcher .engenty-wizard-shut{display:none}
.engenty-wizard-launcher[data-plain] .engenty-wizard-avatar{display:none}
.engenty-wizard-launcher[data-plain] .engenty-wizard-open{display:block}
.engenty-wizard-launcher[aria-expanded="true"]{width:60px;padding:0}
.engenty-wizard-launcher[aria-expanded="true"] :is(.engenty-wizard-avatar,.engenty-wizard-open,.engenty-wizard-label){display:none}
.engenty-wizard-launcher[aria-expanded="true"] .engenty-wizard-shut{display:block}
.engenty-wizard-panel{position:fixed;right:20px;bottom:92px;z-index:2147483000;width:min(400px,calc(100vw - 40px));height:min(680px,calc(100dvh - 120px));border-radius:16px;overflow:hidden;background:#faf8f5;box-shadow:0 24px 64px rgba(0,0,0,.28);transform-origin:bottom right;opacity:0;transform:translateY(12px) scale(.96);visibility:hidden;transition:opacity .2s,transform .2s,visibility 0s .2s}
.engenty-wizard-panel[data-open]{opacity:1;transform:none;visibility:visible;transition:opacity .2s,transform .2s}
.engenty-wizard-panel iframe{display:block;width:100%;height:100%;border:0}
@media (max-width:640px){.engenty-wizard-panel{inset:0;width:100vw;height:100dvh;border-radius:0}.engenty-wizard-launcher[aria-expanded="true"]{display:none}}
@media (prefers-reduced-motion:reduce){.engenty-wizard-panel,.engenty-wizard-launcher{transition:none}}`;
      document.head.append(style);
    }

    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = `engenty-wizard-launcher${label ? " engenty-wizard-labelled" : ""}`;
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", label || "Chat");
    if (script.dataset.color) {
      launcher.style.setProperty("--engenty-wizard-color", script.dataset.color);
    }
    // The wizard's engenty; the speech bubble stands in where it cannot be loaded.
    const avatar = document.createElement("img");
    avatar.className = "engenty-wizard-avatar";
    avatar.alt = "";
    avatar.draggable = false;
    avatar.src = `${app.href}api/public/wizards/${encodeURIComponent(token)}/avatar.svg`;
    avatar.addEventListener("error", () => launcher.setAttribute("data-plain", ""));
    launcher.innerHTML =
      '<svg class="engenty-wizard-open" viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>' +
      '<svg class="engenty-wizard-shut" viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    launcher.prepend(avatar);
    if (label) {
      const words = document.createElement("span");
      words.className = "engenty-wizard-label";
      words.textContent = label;
      launcher.append(words);
    }
    document.body.append(launcher);

    let panel = null;
    const close = () => {
      panel?.removeAttribute("data-open");
      launcher.setAttribute("aria-expanded", "false");
      launcher.focus();
    };
    launcher.addEventListener("click", () => {
      // Built at the first click and kept: closed and opened again, the chat is where it was.
      if (!panel) {
        panel = document.createElement("div");
        panel.className = "engenty-wizard-panel";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", label || "Chat");
        const el = frame();
        listen(el, "close", close);
        panel.append(el);
        document.body.append(panel);
        // The panel comes in from below once it is in the page.
        panel.getBoundingClientRect();
      }
      if (panel.hasAttribute("data-open")) {
        close();
        return;
      }
      panel.setAttribute("data-open", "");
      launcher.setAttribute("aria-expanded", "true");
      panel.querySelector("iframe")?.focus();
    });
    addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel?.hasAttribute("data-open")) {
        close();
      }
    });
  }
})();
