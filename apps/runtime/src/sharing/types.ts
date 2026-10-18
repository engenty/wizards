import type { AskInput } from "@engenty/wizards-shared/run";
import type {
  ShareChoice,
  ShareField,
  ShareIcon,
  ShareLang,
} from "@engenty/wizards-shared/sharing";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import type { Gap } from "@engenty/wizards-shared/texts";
import type {
  ConnectorActionContext,
  ConnectorDefinition,
} from "../engenty/connections-sdk/types.js";
import type { AskResult } from "../engine/asks.js";
import type { RunRow, StepContext } from "../engine/types.js";
import { NotedError, type ServerLine } from "../model-errors.js";
import { type ServerKey, serverText } from "../texts.js";

/**
 * A share target is a place a finished result can be sent or published to: by e-mail, into a
 * cloud folder, to a Slack channel, through a connector, on a website. Each one is a file in
 * `./targets` that says what it needs — an account, a form — and how it sends. The share sheet
 * walks the person through it: pick the target, connect the account, say what and where, send.
 *
 * A new target is one object of this shape, added to the list in `./index.ts`.
 */
export interface ShareTarget {
  /** "email", "slack", "browser", "storage:<connector>", "connector:<connector>". */
  id: string;
  name: Said;
  /** One line under the name: what happens. */
  description: Said;
  icon: ShareIcon;
  /** What of the result it takes: files the person picks, or the link to the result page. */
  takes: "files" | "link";
  /** It cannot send without at least one file. */
  needsFiles?: boolean;
  /**
   * An agent does the work. That runs a model on the wizard's credits, so people without an
   * account get such a target only where the wizard's result names it.
   */
  agent?: boolean;
  /** Whether a result offers it without the wizard naming it; default true. */
  byDefault?: boolean;
  /** Whether this runtime can offer it at all: a browser to drive, a connector that is set up. */
  available?(): boolean | Promise<boolean>;
  /** The account it sends with; null or left out = none needed. */
  connection?(): ConnectionDef | null;
  fields: TargetField[];
  presets?: { label: string; values: Record<string, Said> }[];
  /** What the form starts with for this run. */
  defaults?(scope: TargetScope): Record<string, string> | Promise<Record<string, string>>;
  /** The choices of a `fromAccount` field, read from the connected account. */
  choices?(field: string, ctx: ShareContext): Promise<ShareChoice[]>;
  send(input: ShareInput, ctx: ShareContext): Promise<ShareOutcome>;
}

/**
 * Words the person reads: a line of the server's table (`texts.ts`), said in their language, or
 * text that is the same in every language (a name, an address).
 */
export type Said = string | ServerLine;

export const line = (server: ServerKey, params?: Record<string, Gap | undefined>): Said => ({
  server,
  params,
});

/** What is said, in a language. */
export function sayIn(lang: ShareLang, said: Said): string {
  return typeof said === "string" ? said : serverText(lang, said.server, said.params);
}

export interface TargetField extends Omit<ShareField, "label" | "placeholder" | "help" | "value"> {
  label: Said;
  placeholder?: Said;
  help?: Said;
}

/** What a target knows about the run it is offered on. */
export interface TargetScope {
  run: RunRow;
  projectId: string;
  lang: ShareLang;
  /** The result's title with the wizard's, as a subject line. */
  title: string;
  /** The result step's closing message. */
  message: string | null;
  /** The first written deliverable, as text — what a post or a message can start from. */
  text: string | null;
}

/** One file of the result, rendered in the format the person picked. */
export interface ShareFile {
  name: string;
  mime: string;
  data: Uint8Array;
  /** The deliverable's label. */
  label: string;
  /** How an agent names it in a tool call: `result:<step>.<format>`. */
  ref: string;
}

export interface ShareInput {
  values: Record<string, string>;
  files: ShareFile[];
}

/** Where the result ended up. */
export interface ShareOutcome {
  summary: Said;
  url?: string | null;
}

export interface ShareContext extends TargetScope {
  signal: AbortSignal;
  /** Signed in to the studio: the wizard is their own. */
  member: boolean;
  /** How often this target has sent for this run before. */
  sentBefore: number;
  /** One line of progress the person reads while it works. */
  emit(message: Said): Promise<void>;
  /** Asks the person (a sign-in, leave to publish) and waits; null when nobody is there. */
  ask(ask: AskInput): Promise<AskResult | null>;
  /** The account the person connected for this target, with a fresh token; null = none. */
  account(): Promise<{
    connector: ConnectorDefinition;
    ctx: ConnectorActionContext;
    label: string;
  } | null>;
  /** The link to the result page, if people elsewhere can open it; shares the run if needed. */
  link(): Promise<string | null>;
  /** What an agent works with: the run's browser, store and asks. For targets with `agent`. */
  step(): Promise<StepContext>;
}

/** A failure the person can read and act on; anything else is reported as "did not work". */
export class ShareError extends NotedError {}
