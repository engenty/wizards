import { configureRunner, type MascotProps } from "@engenty/wizards-runner";
import "@engenty/wizards-runner/runner.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { runBase } from "./api";
import { Engenty } from "./engenty";
import { lang } from "./i18n";
import "./portal.css";

/** The wizard's engenty where the runner shows its figure. */
function Mascot({ kind, size = 64 }: MascotProps) {
  return <Engenty kind={kind} size={Math.min(size, 72)} />;
}

// The runner talks to a run through the portal server, with the ticket the contract gave for it.
configureRunner({
  lang,
  runBase,
  withBase: (path) => `/portal${path}`,
  asset: (path) => `/portal/${path.replace(/^\/+/, "")}`,
  Mascot,
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
