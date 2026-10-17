import type { PluginEvents, PluginRunEvent, PluginSpaceFileEvent } from "@engenty/wizards/plugin";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";
import { pluginsOf } from "./registry.js";

/**
 * Tells the current tenant's plugins what happened. A plugin cannot fail what the runtime does:
 * what a listener throws is logged and nothing more.
 */
export async function emitPluginEvent<E extends keyof PluginEvents>(
  event: E,
  payload: PluginEvents[E] | (() => Promise<PluginEvents[E] | null>),
): Promise<void> {
  try {
    const listening = (await pluginsOf(currentTenant())).filter((p) => p.listeners[event]?.length);
    if (!listening.length) {
      return;
    }
    // What is costly to gather is gathered only when someone listens.
    const told = typeof payload === "function" ? await payload() : payload;
    if (!told) {
      return;
    }
    for (const plugin of listening) {
      for (const listener of plugin.listeners[event] ?? []) {
        try {
          await listener(told);
        } catch (err) {
          console.error(`[plugin ${plugin.source.id}] ${event}:`, err);
        }
      }
    }
  } catch (err) {
    console.error(`[plugins] ${event}:`, err);
  }
}

/** A run reached its end. */
export function runEnded(runId: string, status: PluginRunEvent["run"]["status"]): Promise<void> {
  return emitPluginEvent(`run.${status}`, async () => {
    const run = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
    const wizard =
      run && (await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) }));
    if (!run || !wizard) {
      return null;
    }
    return {
      run: { id: run.id, wizardId: run.wizardId, mode: run.mode, status },
      wizard: { id: wizard.id, title: run.definition.title, projectId: wizard.projectId },
      values: run.state.values,
    };
  });
}

/**
 * A space was made, changed or deleted. Not waited for: the request that changed the space
 * answers without its plugins.
 */
export function spaceChanged(
  event: "space.created" | "space.updated" | "space.deleted",
  spaceId: string,
) {
  void emitPluginEvent(event, { space: { id: spaceId } });
}

/** A file of a space was read and is ready, or was removed. Not waited for either. */
export function spaceFileChanged(
  event: "space.file.ready" | "space.file.removed",
  file: {
    id: string;
    projectId: string;
    name: string;
    kind: PluginSpaceFileEvent["file"]["kind"];
    mime: string;
  },
) {
  void emitPluginEvent(event, {
    space: { id: file.projectId },
    file: { id: file.id, name: file.name, kind: file.kind, mime: file.mime },
  });
}
