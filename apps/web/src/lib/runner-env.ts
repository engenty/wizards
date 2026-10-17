import { configureRunner } from "@engenty-wizards/runner";
import { Mascot } from "../brand";
import { ShareResultButton } from "../share/ShareSheet";
import { appCall, appCan, appDownload, appTell } from "./app";
import { asset, BASE, withBase } from "./base";
import { lang } from "./i18n";
import { report } from "./report";

/**
 * The runner (packages/runner) on this app: the runtime's run routes under the app's base path,
 * the mobile app's bridge, the studio's engenty and the result's share button.
 */
configureRunner({
  lang,
  runBase: (runId) => `/api/runs/${runId}`,
  withBase,
  asset,
  serviceWorker: `${BASE}/sw.js`,
  app: { can: appCan, call: appCall, tell: appTell, download: appDownload },
  Mascot,
  ShareResultButton,
  onServerError: (line) => report("error", line),
});
