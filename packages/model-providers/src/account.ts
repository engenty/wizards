import { createGateway } from "@ai-sdk/gateway";

/**
 * The wizards account: the model gateway of a Manage-App, paid with the credits of whoever the
 * key names. It speaks the AI SDK's gateway protocol at `<url>/v4/ai`.
 */
export interface Account {
  /** The Manage-App's gateway, without `/v4/ai`. */
  url: string;
  key: string;
  /** Another fetch, such as a test's, or one that reads what the gateway says beside its answer. */
  fetch?: typeof fetch;
  /** What every call says of itself beside the key: the run it belongs to, the organization. */
  headers?: Record<string, string>;
}

/**
 * The account's gateway as the AI SDK's gateway client: `gateway(model)` for text,
 * `gateway.embeddingModel(model)`, `gateway.imageModel(model)` and the rest for what else it serves.
 * A class of the account is named `wizards/<class>`; the gateway binds it to a model.
 */
export function accountGateway(account: Account): ReturnType<typeof createGateway> {
  return createGateway({
    baseURL: `${account.url.replace(/\/+$/, "")}/v4/ai`,
    apiKey: account.key,
    ...(account.fetch ? { fetch: account.fetch } : {}),
    ...(account.headers ? { headers: account.headers } : {}),
  });
}
