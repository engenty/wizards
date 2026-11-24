import type { ClientAuth } from "@engenty/local-models/clients";

/** A client on this computer: what the setup and the settings show of it. */
export interface ClientSetupStatus<Id extends string = string> {
  id: Id;
  name: string;
  /** How to install it in a terminal; the setup runs the same command. */
  install: string;
  /** The vendor's desktop app on this computer ("Claude"): the subscription is most likely there. */
  app: string | null;
  /** Null: not installed. */
  version: string | null;
  auth: ClientAuth;
  /** The sign-in opens the client's own app, which the person ends. */
  interactiveLogin: boolean;
  /** It makes images on the sign-in as well (Codex); video and audio no client makes. */
  images: boolean;
}

/** What a terminal says to the page that shows it. */
export type TerminalEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "done" };
