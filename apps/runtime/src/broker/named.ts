import { connectorFetch } from "../connectors/builtin.js";
import { refreshConnector } from "../connectors/external.js";
import { sendAsAccount } from "../connectors/smtp.js";
import type { StreamPullResult } from "../engenty/connections-sdk/types.js";
import { managed } from "../manage.js";
import type { Account } from "./account.js";

/*
 * What a call does with the account beyond one of the connector's actions, named, so it travels
 * to the broker as data (docs/plans/runs-on-their-own.md, 7.5b): the broker knows each by its
 * name and runs it with the account it opened. Bytes travel as base64.
 */
export type NamedCall =
  /** Asks an MCP server for its tools with the account, and keeps them as the connector's. */
  | { name: "refresh_tools"; spaceId: string; connectorId: string }
  /** The next items of the connector's stream from `cursor` (a mailbox). */
  | { name: "pull_stream"; cursor: string | null; since: string; limit: number }
  /** One item of the stream by its id. */
  | { name: "read_message"; message: string }
  /** A mail sent as the account. */
  | { name: "send_mail"; message: MailWire }
  /** A plugin's own request to the service, signed with the account. */
  | { name: "request"; request: RequestWire }
  /** Files saved into a folder of the account's storage (a share); answers the first's link. */
  | {
      name: "upload";
      folder: string;
      files: { name: string; mime: string; data: string }[];
    };

export interface MailWire {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachments?: { name: string; mime: string; data: string }[];
}

export interface RequestWire {
  url: string;
  method: string;
  headers: [string, string][];
  /** base64; null: none. */
  body: string | null;
}

/** A plugin's request's answer, as it travels: the plugin makes a `Response` of it again. */
export interface ResponseWire {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));
const base64Of = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes as Uint8Array).toString("base64");

/** What a plugin hands its connection to send, as it travels. */
export async function requestWire(request: {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
}): Promise<RequestWire> {
  const body =
    request.body == null
      ? null
      : base64Of(await new Response(request.body as BodyInit).arrayBuffer());
  return {
    url: request.url,
    method: request.method ?? "GET",
    headers: [...new Headers(request.headers).entries()],
    body,
  };
}

export function responseOf(wire: ResponseWire): Response {
  const empty = wire.status === 204 || wire.status === 304;
  return new Response(empty ? null : bytesOf(wire.body), {
    status: wire.status,
    statusText: wire.statusText,
    headers: wire.headers,
  });
}

/** A mail as it travels: its attachments as base64. */
export function mailWire(message: {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachments?: { name: string; mime: string; data: Uint8Array }[];
}): MailWire {
  return {
    ...message,
    attachments: message.attachments?.map((a) => ({ ...a, data: base64Of(a.data) })),
  };
}

const pluginFetch: typeof fetch = managed ? connectorFetch : (input, init) => fetch(input, init);

/** A pull that found nothing leaves no line: one runs every minute. */
export function quietOf(named: NamedCall | undefined): ((result: unknown) => boolean) | undefined {
  return named?.name === "pull_stream"
    ? (result) => (result as StreamPullResult).items.length === 0
    : undefined;
}

/** Runs the named call with the account the broker opened. */
export async function runNamed(named: NamedCall, account: Account): Promise<unknown> {
  const { connector, ctx } = account;
  switch (named.name) {
    case "refresh_tools":
      return refreshConnector(named.spaceId, named.connectorId, ctx.accessToken);
    case "pull_stream":
      if (!connector.stream) {
        throw new Error(`${connector.name} has no stream.`);
      }
      return connector.stream.pull(
        { ...ctx, since: named.since, limit: named.limit },
        named.cursor,
      );
    case "read_message":
      if (!connector.stream?.read) {
        throw new Error(`${connector.name} can't read one message.`);
      }
      return connector.stream.read(
        { ...ctx, since: new Date(0).toISOString(), limit: 1 },
        named.message,
      );
    case "send_mail": {
      const { attachments, ...message } = named.message;
      return sendAsAccount(connector, ctx, {
        ...message,
        ...(attachments
          ? { attachments: attachments.map((a) => ({ ...a, data: bytesOf(a.data) })) }
          : {}),
      });
    }
    case "request":
      return request(account, named.request);
    case "upload":
      return (await import("../sharing/targets/storage.js")).uploadWith(
        account,
        named.folder,
        named.files.map((f) => ({ ...f, data: bytesOf(f.data) })),
      );
  }
}

async function request(account: Account, wire: RequestWire): Promise<ResponseWire> {
  const { connector, ctx } = account;
  const capability = connector.request;
  if (!capability) {
    throw new Error(`${connector.name} takes no requests of a plugin.`);
  }
  const url = new URL(wire.url);
  if (!capability.origins(ctx).includes(url.origin)) {
    throw new Error(`${connector.name} takes no requests to ${url.origin}.`);
  }
  const body = wire.body === null ? undefined : bytesOf(wire.body);
  const unsigned = new Request(url, { method: wire.method, headers: wire.headers, body });
  if (!capability.sign) {
    unsigned.headers.set("authorization", `Bearer ${ctx.accessToken}`);
  }
  const signed = capability.sign ? await capability.sign(ctx, unsigned) : unsigned;
  const res = await pluginFetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body,
  });
  // The service turned the sign-in down: the broker hears of it, as of an action's.
  if (res.status === 401) {
    throw Object.assign(new Error(`${connector.name} refused the sign-in (401).`), {
      status: 401,
    });
  }
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()],
    body: base64Of(await res.arrayBuffer()),
  };
}
