import { createGuardedFetch } from "../engenty/connections-external/net/guarded-fetch.js";
import { githubConnector } from "../engenty/connections-github/connector.js";
import { googleConnectors } from "../engenty/connections-google/definitions.js";
import { GOOGLE_OAUTH2 } from "../engenty/connections-google/shared.js";
import { hubspotConnector } from "../engenty/connections-hubspot/connector.js";
import { microsoftOneDriveConnector } from "../engenty/connections-microsoft/onedrive.js";
import { microsoftOutlookConnector } from "../engenty/connections-microsoft/outlook.js";
import { s3Connector } from "../engenty/connections-s3/s3.js";
import {
  type ClientEnvResolver,
  hasOAuth2ClientCredentials,
} from "../engenty/connections-sdk/oauth2.js";
import { registerConnectorDefinition } from "../engenty/connections-sdk/registry.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { slackConnector } from "../engenty/connections-slack/connector.js";
import { managed } from "../manage.js";
import { gmailConnector as mailGmail } from "./gmail.js";
import { imapConnector } from "./imap.js";
import { outlookConnector as mailOutlook } from "./outlook.js";
import { smtpConnector } from "./smtp.js";
import { googleThroughAccount } from "./via-account.js";

/**
 * engenty's own connectors, as engenty ships them: Gmail, Drive, Calendar, Contacts, Outlook,
 * OneDrive, Slack, GitHub, HubSpot, S3 — and SMTP, for sending from any mailbox. Every project
 * has them; an OAuth one can be connected once its client is configured.
 */
export const BUILTIN_CONNECTORS: ConnectorDefinition[] = [
  ...googleConnectors,
  microsoftOutlookConnector,
  microsoftOneDriveConnector,
  slackConnector,
  githubConnector,
  hubspotConnector,
  s3Connector,
  smtpConnector,
];

/** The connectors behind a connection of kind "mail": one read-only shape for any mailbox. */
export const MAIL_CONNECTORS: ConnectorDefinition[] = [mailGmail, mailOutlook, imapConnector];

// One registry for all of them, so an imported connector can never take a built-in's id.
for (const connector of [...BUILTIN_CONNECTORS, ...MAIL_CONNECTORS]) {
  registerConnectorDefinition(connector);
}

export function builtinConnector(id: string): ConnectorDefinition | undefined {
  return BUILTIN_CONNECTORS.find((c) => c.id === id);
}

/**
 * engenty names OAuth clients `<VENDOR>_OAUTH_CLIENT_ID`. Google and Microsoft allow one client
 * several redirect addresses, so the client this product signs people in with (`<VENDOR>_CLIENT_ID`)
 * serves connections too. GitHub and Slack tie a client to one address: they need their own.
 */
export const resolveEnv: ClientEnvResolver = async (key) => {
  const own = process.env[key]?.trim();
  if (own || !/^(GOOGLE|MICROSOFT)_OAUTH_/.test(key)) {
    return own || undefined;
  }
  return process.env[key.replace("_OAUTH_", "_")]?.trim() || undefined;
};

/** Whether a person can connect an account with this connector right now. */
export async function usable(connector: ConnectorDefinition): Promise<boolean> {
  if (connector.auth.kind !== "oauth2") {
    return connector.auth.kind === "api_key";
  }
  // A connector that registers its own OAuth client needs none configured.
  return (
    connector.auth.oauth2.dynamicClientRegistration === true ||
    (await hasOAuth2ClientCredentials(connector.auth.oauth2, resolveEnv)) ||
    viaAccount(connector)
  );
}

/**
 * A Google connector on a local install without a Google client of its own: it connects through
 * the Manage-App of the linked account, when that one offers it. Offered before an account is
 * linked too; connecting then asks to link it first.
 */
export async function viaAccount(connector: ConnectorDefinition): Promise<boolean> {
  return (
    !managed &&
    connector.auth.kind === "oauth2" &&
    connector.auth.oauth2 === GOOGLE_OAUTH2 &&
    !(await hasOAuth2ClientCredentials(connector.auth.oauth2, resolveEnv)) &&
    (await googleThroughAccount())
  );
}

/** What the server's owner has to set for an OAuth connector that is not usable yet. */
export function missingSetup(connector: ConnectorDefinition): string | null {
  if (connector.auth.kind !== "oauth2") {
    return null;
  }
  const { clientIdEnv, clientSecretEnv } = connector.auth.oauth2;
  return clientIdEnv && clientSecretEnv ? `${clientIdEnv}, ${clientSecretEnv}` : null;
}

/**
 * Connector actions reach addresses that come from a person or a spec (an S3 endpoint, an API's
 * base URL): every request is checked to stay on the public internet.
 */
export const connectorFetch = createGuardedFetch();
