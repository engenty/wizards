import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { PublicApp, StudioApp } from "./App";
import { BASE, STUDIO } from "./lib/base";
import { watchErrors } from "./lib/report";
import "./lib/runner-env";
import "./lib/theme";
import "./styles/app.css";

watchErrors();

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
        {studio ? <StudioApp /> : <PublicApp />}
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
