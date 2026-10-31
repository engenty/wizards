import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { note, type RunNote } from "@engenty/wizards-shared/run";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { ActionKind } from "./call.js";

/*
 * A run's grant (docs/plans/capabilities.md, A3): what the run may reach outside, fixed when it
 * starts from the definition it runs on — the published one for a live run, the draft for a test
 * run — and kept on the run's row. An edit to the wizard never widens a run that is under way,
 * and the AI cannot steer a step to an action its definition did not give it: the broker refuses
 * what is not in the grant before any rule is asked.
 */

export interface Grant {
  /**
   * The wizard's connections a step lists, each with what may be called through it: action ids
   * where the connection names them, else the kind `read` — every action that only reads, as the
   * connector tools have always offered; and the action a fixed `call` step names on its
   * connection.
   */
  connections: Record<string, string[]>;
  /**
   * Hosts `http_request` may reach, as the steps list them: names, or `*.example.org` for every
   * host below. A guest's run reaches no other host; a member's every public one until the
   * `broker` switch is on (A6).
   */
  hosts: string[];
  /** The tools any step of the run names. */
  tools: string[];
}

/** The grant a definition gives its runs. Pure: the same definition, the same grant. */
export function grantOf(definition: WizardDefinition): Grant {
  const connections: Record<string, string[]> = {};
  const tools = new Set<string>();
  const hosts = new Set<string>();
  const defs = new Map((definition.connections ?? []).map((c) => [c.id, c]));
  for (const step of definition.steps) {
    if (step.type !== "agent") {
      continue;
    }
    for (const tool of step.tools) {
      tools.add(tool);
    }
    if (step.call && "connection" in step.call && defs.has(step.call.connection)) {
      const have = new Set(connections[step.call.connection] ?? []);
      have.add(step.call.action);
      connections[step.call.connection] = [...have].sort();
    }
    for (const host of step.hosts ?? []) {
      hosts.add(host.trim().toLowerCase());
    }
    for (const id of step.connections ?? []) {
      const def = defs.get(id);
      if (!def) {
        continue;
      }
      const have = new Set(connections[id] ?? []);
      for (const action of def.actions ?? ["read"]) {
        have.add(action);
      }
      connections[id] = [...have].sort();
    }
  }
  return { connections, hosts: [...hosts].sort(), tools: [...tools].sort() };
}

/**
 * Whether the grant lets `http_request` reach this host: named as it is, or below a `*.` entry
 * (`*.example.org` takes `api.example.org`, not `example.org` itself).
 */
export function hostInGrant(grant: Grant, hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  return grant.hosts.some((entry) =>
    entry.startsWith("*.")
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : entry === host,
  );
}

/**
 * Whether the grant lets this action run through this connection: the action by its id, or by
 * its kind where the grant names kinds. A connection in the grant may always list its connector's
 * tools (`list_tools`): that reads the connector, not the account's data.
 */
export function inGrant(
  grant: Grant,
  connectionId: string,
  actionId: string,
  kind: ActionKind,
): boolean {
  const allowed = grant.connections[connectionId];
  if (!allowed) {
    return false;
  }
  return actionId === "list_tools" || allowed.includes(actionId) || allowed.includes(kind);
}

/**
 * The grant a run holds. A run from before grants were kept gets one from the definition it
 * started on, written once on first use; null for a run this tenant does not have.
 */
export async function runGrant(runId: string): Promise<Grant | null> {
  const run = await db.query.run.findFirst({
    where: eq(schema.run.id, runId),
    columns: { grant: true, definition: true },
  });
  if (!run) {
    return null;
  }
  if (run.grant) {
    return run.grant;
  }
  const grant = grantOf(run.definition);
  await db.update(schema.run).set({ grant }).where(eq(schema.run.id, runId));
  return grant;
}

/** What a built-in tool lets a run do, in the run's log. */
const TOOL_NOTES: Record<string, RunNote> = {
  web_search: note("grantSearchesWeb"),
  web_fetch: note("grantReadsWeb"),
  browser: note("grantBrowser"),
  sandbox: note("grantRunsCode"),
  code: note("grantRunsCode"),
  image: note("grantDrawsImages"),
  http: note("grantCallsApis"),
  pages: note("grantWritesPages"),
};

/** What is known of a connection's connector when the run starts: its name, its actions' kinds. */
export interface KnownConnector {
  name: string;
  kinds: Record<string, ActionKind>;
}

/**
 * The line the run's log opens with: what the run may do, in words. `connectors` says, by
 * connection id, what the connector is called and what kind each of its actions is, where the
 * space has it; an unknown connector's actions are named as they are. Null when the run reaches
 * nothing outside.
 */
export function grantNote(
  grant: Grant,
  definition: WizardDefinition,
  connectors: Record<string, KnownConnector> = {},
): RunNote | null {
  const what: RunNote[] = [];
  const defs = new Map((definition.connections ?? []).map((c) => [c.id, c]));
  for (const [id, actions] of Object.entries(grant.connections)) {
    const def = defs.get(id);
    const name = def?.title ?? connectors[id]?.name ?? def?.connector ?? def?.kind ?? id;
    const known = connectors[id]?.kinds ?? {};
    const byKind = new Set<ActionKind>();
    const unknown: string[] = [];
    for (const action of actions) {
      if (action === "read" || action === "write" || action === "destructive") {
        byKind.add(action);
      } else if (known[action]) {
        byKind.add(known[action]);
      } else {
        unknown.push(action);
      }
    }
    if (byKind.has("read")) {
      what.push(note("grantReads", { name }));
    }
    if (byKind.has("write")) {
      what.push(note("grantWrites", { name }));
    }
    if (byKind.has("destructive")) {
      what.push(note("grantDeletes", { name }));
    }
    if (unknown.length) {
      what.push(note("grantCalls", { name, actions: unknown }));
    }
  }
  for (const [tool, own] of Object.entries(TOOL_NOTES)) {
    if (grant.tools.includes(tool) && !what.some((w) => w.code === own.code)) {
      // With hosts listed the run calls those, not "APIs on the web".
      what.push(
        tool === "http" && grant.hosts.length
          ? note("grantCallsHosts", { hosts: grant.hosts })
          : own,
      );
    }
  }
  const plugins = new Set(
    grant.tools.filter((tool) => !TOOL_NOTES[tool]).map((tool) => tool.split(".")[0]),
  );
  for (const plugin of plugins) {
    what.push(note("grantPlugin", { name: plugin }));
  }
  return what.length ? note("grant", { what }) : null;
}
