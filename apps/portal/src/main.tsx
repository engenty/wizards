import { configureRunner, type MascotProps } from "@engenty/wizards-runner";
import "@engenty/wizards-runner/runner.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { runBase } from "./api";
import { lang } from "./i18n";
import "./portal.css";

/** A plain mark where the runner shows the wizard's figure. */
function Mark({ size = 64 }: MascotProps) {
  const d = Math.min(size, 72) * 0.6;
  return <span aria-hidden="true" className="mark" style={{ width: d, height: d }} />;
}

// The runner talks to a run through the portal server, with the ticket the contract gave for it.
configureRunner({
  lang,
  runBase,
  withBase: (path) => `/portal${path}`,
  asset: (path) => `/portal/${path.replace(/^\/+/, "")}`,
  Mascot: Mark,
});

document.documentElement.lang = lang;

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
