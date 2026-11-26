import type { Host } from "./grant.js";
import type { AskRow, Battery, WizardFile } from "./types.js";

/**
 * The kernel's batteries on an executor (executor.sh, `@executor-js/sdk`): the tool ask and the
 * tools an agent is handed become calls of the executor's tools. The executor holds the
 * integrations, the accounts and their credentials; a step and the kernel see none of them.
 *
 * Only what this file uses of an executor is named here, so the kernel takes no dependency on it.
 */
export type Executor = {
  execute(address: string, args: unknown, options?: { onElicitation?: Elicit }): Promise<unknown>;
  connections: { list(): Promise<readonly { integration: string; address: string }[]> };
  policies: { resolve(address: string): Promise<{ action: string }> };
};
type Elicit = (ctx: { source?: string }) => Promise<{ action: "accept" | "decline" }>;

/** What a model does with an agent ask: `call` is every tool the ask handed it, and no other. */
export type Model = (
  row: AskRow,
  call: (name: string, input: unknown) => Promise<any>,
) => Promise<unknown>;

/**
 * `bind` says which account stands behind a connection of the file: the file names `gmail`, the
 * executor addresses `tools.gmail.org.me`. That is the binding made where a wizard is installed.
 */
export function executorBatteries(options: {
  executor: Executor;
  bind: Record<string, string>;
  model: Model;
}): Record<string, Battery> {
  const { executor, bind, model } = options;

  const address = (name: string) => {
    const [connection, ...action] = name.split(".");
    if (!bind[connection]) throw new Error(`No account is bound to "${connection}".`);
    return `${bind[connection]}.${action.join(".")}`;
  };

  const call = (name: string, input: unknown) => executorCall(executor, address(name), input, name);

  return {
    tool: (row) => call(String(row.call), row.input),
    agent: (row, run) =>
      model(row, async (name, input) => {
        if (!row.tools?.includes(name)) throw new Error(`The agent was not handed "${name}".`);
        const [connection, ...action] = name.split(".");
        if (run.grant?.connections[connection]?.[action.join(".")] === "ask")
          throw new Error(
            `"${name}" needs the user's leave, which an agent's own turn cannot ask for yet.`,
          );
        return call(name, input);
      }),
  };
}

// The kernel (or the runtime's broker) has asked the user where the file says so, as a row that
// outlives the process. So the executor's own gate for the same call is answered yes, and anything
// a tool asks for itself in the middle of a call is answered no: nobody is there to answer it.
const onElicitation: Elicit = async (ctx) => ({
  action: ctx.source === "policy" ? "accept" : "decline",
});

/**
 * One call of an executor's tool, after whoever decides has decided: its data, or an error that
 * says which action failed and how (`name`, as the file names it).
 */
export async function executorCall(
  executor: Pick<Executor, "execute">,
  address: string,
  input: unknown,
  name = address,
): Promise<unknown> {
  const result = (await executor.execute(address, input, { onElicitation })) as {
    ok?: boolean;
    data?: unknown;
    error?: { message?: string; status?: number };
  };
  if (result?.ok === false)
    throw new Error(
      `${name} failed: ${result.error?.message ?? "unknown"} (${result.error?.status ?? "no status"})`,
    );
  return result?.data ?? result;
}

/** What the executor has, for the kernel's question whether a wizard can run here. */
export async function hostOf(
  executor: Executor,
  rest: Omit<Host, "connections"> = {},
): Promise<Host> {
  const connections = await executor.connections.list();
  return {
    ...rest,
    connections: [...new Set(connections.map((connection) => connection.integration))],
  };
}

/** The actions the file allows outright and the executor's own policy would ask about or block. */
export async function stricterThere(
  file: WizardFile,
  executor: Executor,
  bind: Record<string, string>,
) {
  const found: string[] = [];
  for (const [connection, actions] of Object.entries(file.connections ?? {}))
    for (const [action, policy] of Object.entries(actions)) {
      const there = (await executor.policies.resolve(`${bind[connection]}.${action}`)).action;
      if (policy === "allow" && there !== "approve")
        found.push(`${connection}.${action}: ${there}`);
    }
  return found;
}
