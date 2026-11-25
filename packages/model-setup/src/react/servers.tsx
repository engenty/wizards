import type { ServerStatus } from "../types.js";
import type { SetupChoice } from "./columns.js";
import { useText } from "./host.js";

/** The servers for open models as rows of the list; one that is not on this computer is among the rest. */
export function useServerChoices(servers: readonly ServerStatus[]): SetupChoice[] {
  const t = useText();
  return servers.map((server) => ({
    id: server.id,
    title: server.name,
    description: t("server.desc"),
    ...(server.installed
      ? { note: t("server.here") }
      : { note: t("harness.notInstalled"), more: true }),
  }));
}
