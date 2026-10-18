// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import type { Format, Lang } from "./definition.js";
import type { RunAsk } from "./run.js";
import type { ConnectionView } from "./store.js";

/**
 * Sharing a finished result beyond the link and the downloads: a share target sends or publishes
 * it — by e-mail, into a cloud folder, to a Slack channel, through a connector, on a website.
 */

/** The targets every runtime has. A connector adds `storage:<connector>` or `connector:<connector>`. */
export const SHARE_TARGETS = ["email", "slack", "browser"] as const;

const CONNECTOR_TARGET = /^(storage|connector):[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

/** Whether an id can name a share target at all; which ones a runtime offers it says itself. */
export function isShareTargetId(id: string): boolean {
  return (SHARE_TARGETS as readonly string[]).includes(id) || CONNECTOR_TARGET.test(id);
}

export type ShareLang = Lang;

export type ShareIcon = "mail" | "folder" | "chat" | "plug" | "globe";

/** One input of a target's form. */
export interface ShareField {
  id: string;
  label: string;
  /** `emails`: one or more addresses. `select`: one of `options`, or read from the account. */
  kind: "text" | "textarea" | "emails" | "url" | "select";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: ShareChoice[];
  /** select: the choices come from the connected account (channels, folders) and are loaded then. */
  fromAccount?: boolean;
  /** What the form starts with. */
  value?: string;
}

export interface ShareChoice {
  value: string;
  label: string;
}

/** A ready-made filling of a target's form, e.g. "LinkedIn" for the browser. */
export interface SharePreset {
  label: string;
  values: Record<string, string>;
}

/** A share target as the person picks it on a result. */
export interface ShareTargetView {
  /** Unique among the targets of one result: the target's id, or `<n>:<id>` for one the wizard defines. */
  key: string;
  target: string;
  name: string;
  description: string;
  icon: ShareIcon;
  /** The account it sends with; null = none needed. */
  connection: ConnectionView | null;
  fields: ShareField[];
  /** What of the result it takes: files the person picks, or the link to the result page. */
  takes: "files" | "link";
  /** An agent does the work: it takes a while, may ask for a sign-in, and uses the wizard's credits. */
  agent: boolean;
  presets: SharePreset[];
}

/** One file to send: a deliverable of the result in one of its formats. */
export interface ShareItem {
  /** A step id, or `lists.<id>`. */
  from: string;
  format: Format;
}

/** What the person sends off. */
export interface ShareRequest {
  /** `key` of the target. */
  target: string;
  items: ShareItem[];
  values: Record<string, string>;
  lang?: ShareLang;
}

export type ShareJobStatus = "running" | "done" | "failed" | "cancelled";

/** One result on its way to one target, or arrived there. */
export interface ShareJobView {
  id: string;
  target: string;
  /** The target's name when it was sent. */
  name: string;
  icon: ShareIcon;
  status: ShareJobStatus;
  /** What happened so far, oldest first. */
  events: { at: string; message: string }[];
  /** What the target asks the person right now: a sign-in, or leave to publish. */
  ask: RunAsk | null;
  /** Where it ended up, in words, with a link when there is one. */
  result: { summary: string; url: string | null } | null;
  error: string | null;
  createdAt: string;
}

/** `GET /api/runs/<id>/share/targets`. */
export interface ShareOverview {
  targets: ShareTargetView[];
  /** Earlier jobs of this run, newest first. */
  jobs: ShareJobView[];
}

/** A share target as the editor lists it for a wizard's result: what it is and what its form takes. */
export interface ShareTargetInfo {
  id: string;
  name: string;
  description: string;
  icon: ShareIcon;
  agent: boolean;
  /** Whether it can work on this server right now; a target that is not set up is not offered to people. */
  usable: boolean;
  /** A result that lists no targets offers it. */
  byDefault: boolean;
  fields: Pick<ShareField, "id" | "label" | "kind">[];
}

/** A target as the editor's preview shows it, with the placeholders that came out empty. */
export interface SharePreviewTarget extends ShareTargetView {
  /** Placeholders of its prefilled fields that are empty in the run the preview is filled from. */
  empty: string[];
}

/**
 * `GET /api/studio/wizards/<id>/share-preview`: the draft's result page as a visitor or as the
 * owner gets it, filled from the wizard's last finished test run.
 */
export interface SharePreview {
  /** The test run the texts come from; null when none has finished. */
  run: { id: string; at: string } | null;
  targets: SharePreviewTarget[];
  /** Targets of the result this audience does not get: an agent drives it, or it is not set up. */
  left: { name: string; why: "agent" | "setup" }[];
  /** The start of each written deliverable in that run, by step id. */
  outputs: Record<string, string>;
}
