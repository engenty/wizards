import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { PublicApp, StudioApp } from "./App";
import { BASE, STUDIO } from "./lib/base";
import { watchErrors } from "./lib/report";
import { Crashed } from "./report/Crashed";
import { keepConsole } from "./report/log";
import { ReportHost } from "./report/ReportDialog";
import "./lib/runner-env";
import "./lib/theme";
import "./styles/app.css";

watchErrors();
keepConsole();

// A page loaded before a deploy asks for its build's files, which the new build no longer has:
// it loads anew, once. A second failure within a minute is a real one and stays an error.
const RELOADED_KEY = "wizards.reloadedForBuild";
window.addEventListener("vite:preloadError", (event) => {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOADED_KEY)) || 0;
    if (Date.now() - last < 60_000) {
      return;
    }
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    // Without session storage there is no guard against a loop: leave the error as it is.
    return;
  }
  event.preventDefault();
  window.location.reload();
});

// The desktop app's window is marked: there, what can be clicked keeps the arrow, as apps do.
if ("engentyDesktop" in window) {
  document.documentElement.dataset.desktop = "";
}

// The studio has its own router below `/studio`; the public pages (`/w`, `/s`) have theirs at the
// root. A page never moves from one to the other without loading.
const path = window.location.pathname;
const studio = path === STUDIO || path.startsWith(`${STUDIO}/`);

// The studio installs as an app on a phone with a service worker behind it; this one caches
// nothing (public/sw.js), so every request still goes to the runtime.
if (studio && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${BASE}/sw.js`).catch(() => undefined);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={studio ? STUDIO : BASE}>
        <Crashed where={studio ? "studio" : "run"}>
          {studio ? <StudioApp /> : <PublicApp />}
          <ReportHost />
        </Crashed>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
