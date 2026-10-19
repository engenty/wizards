import {
  api,
  configureRunner,
  type Lang,
  type MascotProps,
  RunnerBody,
} from "@engenty/wizards-runner";
import type { PublicWizard, RunTheme, RunView } from "@engenty/wizards-shared/run";
import { defineComponent } from "@openuidev/react-lang";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type WizardLookProps, wizardLook } from "./look.js";
import { useMessageRun, useReport } from "./message.js";
import { useWizardRun } from "./run.js";
import { WIZARD_COMPONENT, WIZARD_DESCRIPTION, type WizardProps, wizardProps } from "./server.js";

export interface WizardsConfig {
  /**
   * Where the runtime answers, as the browser reaches it: a path the host proxies to it
   * (`/wizards-runtime`, so the runner's cookie stays first-party) or the runtime's address.
   */
  runtime: string;
  /** The language of the runner's own words: `en` unless given. */
  lang?: Lang;
  /** The wizard's mascot above its pages; a plain dot in the wizard's colour unless given. */
  Mascot?: (props: MascotProps) => React.ReactNode;
  /**
   * The wizard's look here: `host` (your page's own `--wizard-*` variables, nothing of the
   * wizard's), `brand`, `default` or the id of a theme the wizard offers. Unless given, or one the
   * wizard does not offer: its first theme.
   */
  theme?: string;
  /** Light or dark, as your page shows; else what the theme prefers. */
  mode?: "light" | "dark";
  /** The effects of the wizard's theme the card may draw (`CARD_EFFECTS`); none unless given. */
  effects?: readonly string[];
}

let shown: Pick<WizardsConfig, "theme" | "mode" | "effects"> = {};

/** A plain stand-in for the studio's engenty. */
function Dot({ size = 64 }: MascotProps) {
  const d = Math.min(size, 72);
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full bg-ember"
      style={{ width: d * 0.6, height: d * 0.6 }}
    />
  );
}

/** Names the runtime the Wizard component talks to. Once, before the first render. */
export function configureWizards(config: WizardsConfig) {
  const base = config.runtime.replace(/\/+$/, "");
  configureRunner({
    lang: config.lang ?? "en",
    runBase: (runId) => `/api/runs/${runId}`,
    withBase: (path) => `${base}${path}`,
    asset: (path) => `${base}/${path.replace(/^\/+/, "")}`,
    Mascot: config.Mascot ?? Dot,
  });
  shown = { theme: config.theme, mode: config.mode, effects: config.effects };
  looks.clear();
}

/** Each wizard's look, asked once a page. */
const looks = new Map<string, Promise<RunTheme | null>>();

function lookOf(token: string): Promise<RunTheme | null> {
  let found = looks.get(token);
  if (!found) {
    const query = shown.theme ? `?theme=${encodeURIComponent(shown.theme)}` : "";
    found = api.get<PublicWizard>(`/api/public/wizards/${encodeURIComponent(token)}${query}`).then(
      (w) => w.brand.theme,
      () => null,
    );
    looks.set(token, found);
  }
  return found;
}

/** The look of the wizard behind `token` on its card; none for `host`, or while it loads. */
function useLook(token: string): WizardLookProps | null {
  const [look, setLook] = useState<RunTheme | null>(null);
  useEffect(() => {
    if (shown.theme === "host") {
      return;
    }
    let live = true;
    void lookOf(token).then((found) => live && setLook(found));
    return () => {
      live = false;
    };
  }, [token]);
  return look ? wizardLook(look, { mode: shown.mode, effects: shown.effects }) : null;
}

/** Starts a run of the published wizard behind `token`, as a visitor of the runtime. */
const startRun = (token: string) =>
  api
    .post<{ runId: string }>(`/api/public/wizards/${encodeURIComponent(token)}/runs`, {})
    .then((started) => started.runId);

/** What the chat hears when a run is done: the result's texts, each cut short. */
function resultContext(view: RunView) {
  const results = Object.entries(view.outputs)
    .filter(([, out]) => typeof out.text === "string" && out.text.trim())
    .map(([step, out]) => ({ step, text: (out.text ?? "").slice(0, 4000) }));
  return { wizard: view.wizard.title, runId: view.id, results };
}

function WizardRun({ props }: { props: WizardProps }) {
  const { runId, failed } = useMessageRun(props.wizard, startRun);
  const run = useWizardRun(runId, props.prefill);
  const report = useReport();
  const look = useLook(props.wizard);

  // The chat hears of a run it saw finish. A message shown again with a done run tells nothing.
  const view = run.view;
  const seenRunning = useRef(false);
  useEffect(() => {
    if (!view) {
      return;
    }
    if (view.status !== "done") {
      seenRunning.current = true;
    } else if (seenRunning.current) {
      seenRunning.current = false;
      report(`The wizard “${view.wizard.title}” finished.`, resultContext(view));
    }
  }, [view, report]);

  return (
    <div
      {...look}
      style={look?.style as CSSProperties | undefined}
      className="engenty-runner overflow-hidden rounded-2xl border border-paper-3 bg-paper"
    >
      {props.note ? <p className="px-5 pt-4 text-[0.9375rem] text-ink-2">{props.note}</p> : null}
      <div className="px-5 pb-6">
        {failed ? (
          <p className="py-10 text-center text-ink-3">{failed}</p>
        ) : (
          <RunnerBody run={run} compact />
        )}
      </div>
    </div>
  );
}

/** The component an OpenUI library gets: `Wizard("<token>", "<note>", {prefill})`. */
export const Wizard = defineComponent({
  name: WIZARD_COMPONENT,
  description: WIZARD_DESCRIPTION,
  props: wizardProps,
  component: ({ props }) => <WizardRun props={props} />,
});
