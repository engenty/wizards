import type { WizardsPluginFactory } from "@engenty/wizards/plugin";

/**
 * A plugin of one file: it posts a line to NOTIFY_URL whenever a shared wizard was run to its
 * end. Put it into a folder of `PLUGINS_DIR` and set NOTIFY_URL in the install's `.env`.
 */
const plugin: WizardsPluginFactory = (wizards) => {
  const url = wizards.config.get("NOTIFY_URL");
  if (!url) {
    wizards.log.warn("NOTIFY_URL is not set: nothing will be sent.");
    return;
  }
  wizards.server.on("run.done", async ({ run, wizard }) => {
    if (run.mode !== "live") {
      return;
    }
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wizard: wizard.title, run: run.id }),
      signal: AbortSignal.timeout(10_000),
    });
  });
};

export default plugin;
