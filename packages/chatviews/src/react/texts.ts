// SPDX-License-Identifier: MIT

/**
 * The few words the views say themselves (a sheet's close, a checklist's count, a file's open)
 * and the language their numbers are written in. A host that has a dictionary of its own (the
 * runner, with the translations of a wizard) hands it in with `configureViews`; without one the
 * views speak English.
 */

export type ViewTextKey = keyof typeof EN;

const EN = {
  "common.close": "Close",
  "run.less": "Less",
  "run.more": "More",
  "run.share": "Share",
  "share.copied": "Copied",
  "run.yes": "Yes",
  "run.no": "No",
  "surface.allDone": "All done",
  "surface.close": "Close",
  "surface.done": "{done} of {total}",
  "surface.file": "File",
  "surface.files": "{n} files",
  "surface.foundIn": "Found in",
  "surface.openFile": "Open",
  "surface.required": "This one is still empty.",
  "surface.sentBy": "Sent by {name}",
};

type Vars = Record<string, string | number>;

const fill = (line: string, vars?: Vars) =>
  vars ? line.replace(/\{(\w+)\}/g, (whole, name: string) => String(vars[name] ?? whole)) : line;

let text: (key: ViewTextKey, vars?: Vars) => string = (key, vars) => fill(EN[key], vars);
let langOf: () => string = () => "en";

/**
 * Where the views take their words and their language from: `text` gets the keys above (the
 * runner's own keys, so its translations apply), `lang` the code numbers are written for.
 */
export function configureViews(host: {
  text?: (key: ViewTextKey, vars?: Vars) => string;
  lang?: () => string;
}) {
  if (host.text) {
    text = host.text;
  }
  if (host.lang) {
    langOf = host.lang;
  }
}

/** A line of the views in the host's language. */
export function t(key: ViewTextKey, vars?: Vars): string {
  return text(key, vars);
}

/** The language the views write numbers in. */
export function viewLang(): string {
  return langOf();
}
