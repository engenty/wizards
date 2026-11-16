import type { AskRow, Row, Spec, WizardFile } from "./types.js";

/** What a run may reach. Made once from the file when the run starts, and kept on the run. */
export type Grant = {
  models: string[];
  tools: string[];
  roles: string[];
  hosts: string[];
  connections: Record<string, Record<string, "allow" | "ask">>;
};

/** What a host has to offer, for the question whether a wizard can run on it at all. */
export type Host = {
  models?: string[];
  tools?: string[];
  /** The kinds of connection that are there to be bound. */
  connections?: string[];
  /** The roles someone stands behind. */
  roles?: string[];
};

export const grantOf = (file: WizardFile): Grant => ({
  models: file.requires?.models ?? [],
  tools: file.requires?.tools ?? [],
  roles: ["user", "operator", ...Object.keys(file.requires?.roles ?? {})],
  hosts: file.requires?.hosts ?? [],
  connections: file.connections ?? {},
});

/** `gmail.send` as a connection and its action, when the grant has that connection. */
const action = (grant: Grant, name: string) => {
  const [connection, ...rest] = name.split(".");
  return grant.connections[connection] ? grant.connections[connection][rest.join(".")] : undefined;
};

const named = (spec: Spec): string[] => [
  ...(spec.tools ?? []),
  ...(typeof spec.call === "string" ? [spec.call] : []),
];

/** The first thing an ask names that the grant does not have. */
export function outside(grant: Grant, spec: Spec): string | undefined {
  const role = [spec.role, spec.asks].find((name) => name && !grant.roles.includes(name));
  if (role) return role;
  if (typeof spec.model === "string" && !grant.models.includes(spec.model)) return spec.model;
  const tool = named(spec).find((name) => !action(grant, name) && !grant.tools.includes(name));
  if (tool) return tool;
  const url = (spec.input as { url?: unknown } | undefined)?.url;
  if (spec.call === "http.request" && typeof url === "string") {
    const host = new URL(url).hostname;
    if (!grant.hosts.includes(host)) return host;
  }
}

/** Whether the one action a tool ask calls needs the user's leave first. */
export const needsLeave = (grant: Grant, spec: Spec) =>
  typeof spec.call === "string" && action(grant, spec.call) === "ask";

/** What a wizard requires and the host does not have. Only what the host says of itself is checked. */
export function lacking(file: WizardFile, has: Host): string[] {
  const lacks = (kind: string, wanted: string[], there?: string[]) =>
    there ? wanted.filter((name) => !there.includes(name)).map((name) => `${kind} "${name}"`) : [];
  return [
    ...lacks("the model class", file.requires?.models ?? [], has.models),
    ...lacks("the tool", file.requires?.tools ?? [], has.tools),
    ...lacks("someone for the role", Object.keys(file.requires?.roles ?? {}), has.roles),
    ...lacks("the connection", Object.keys(file.connections ?? {}), has.connections),
  ];
}

/** What the file declares and none of these rows asked for. */
export function unused(file: WizardFile, rows: Row[]): string[] {
  const asks = rows.filter((row): row is AskRow => !("left" in row));
  const tools = new Set(asks.flatMap(named));
  const roles = new Set(asks.flatMap((row) => [row.role, row.asks]));
  const models = new Set(asks.map((row) => row.model));
  return [
    ...(file.requires?.models ?? [])
      .filter((name) => !models.has(name))
      .map((name) => `requires.models: ${name}`),
    ...(file.requires?.tools ?? [])
      .filter((name) => !tools.has(name))
      .map((name) => `requires.tools: ${name}`),
    ...Object.keys(file.requires?.roles ?? {})
      .filter((name) => !roles.has(name))
      .map((name) => `requires.roles: ${name}`),
    ...Object.entries(file.connections ?? {}).flatMap(([connection, actions]) =>
      Object.keys(actions)
        .filter((name) => !tools.has(`${connection}.${name}`))
        .map((name) => `connections: ${connection}.${name}`),
    ),
  ];
}
