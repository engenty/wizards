import { randomBytes } from "node:crypto";
import {
  signalMissing,
  signalNameOpen,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { signalRun } from "../engine/runner.js";
import {
  type SentSignal,
  SIGNAL_DATA_BYTES,
  SPACE_SCOPE,
  sendSignal,
  signalKey,
} from "../engine/signals.js";
import { env } from "../env.js";
import { feature, remoteFeatures } from "../features.js";
import { seal } from "../secrets/crypto.js";
import { dropLinks, putLink } from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedWizard, writableWizard } from "./wizards.js";

/** Signals behind the release switch; off, every way in answers as if there were none. */
export async function signalsOn() {
  return feature("durableRuns", await remoteFeatures().catch(() => null));
}

async function requireSignals() {
  if (!(await signalsOn())) {
    throw notFound();
  }
}

export const signalUrl = (token: string) => `${env.publicUrl}/api/public/signals/${token}`;

/** Whether the wizard has an address for other services. The token and secret are shown only once. */
export async function signalAddress(userId: string, wizardId: string) {
  await requireSignals();
  const w = await ownedWizard(userId, wizardId);
  return { on: Boolean(w.signalToken), signed: Boolean(w.signalSecret) };
}

/**
 * The wizard's address for other services: a new one replaces the old, and the old stops
 * answering. The token belongs to this wizard and matches only its runs.
 */
export async function makeSignalAddress(
  userId: string,
  wizardId: string,
  options: { signed: boolean },
) {
  await requireSignals();
  const w = await writableWizard(userId, wizardId);
  const token = nanoid(24);
  const secret = options.signed ? `sig_${randomBytes(24).toString("base64url")}` : null;
  await db
    .update(schema.wizard)
    .set({ signalToken: token, signalSecret: secret ? seal(secret) : null })
    .where(eq(schema.wizard.id, w.id));
  if (w.signalToken) {
    await dropLinks([w.signalToken]);
  }
  await putLink(token, "signal", w.id);
  return { url: signalUrl(token), secret };
}

export async function dropSignalAddress(userId: string, wizardId: string) {
  await requireSignals();
  const w = await writableWizard(userId, wizardId);
  await db
    .update(schema.wizard)
    .set({ signalToken: null, signalSecret: null })
    .where(eq(schema.wizard.id, w.id));
  if (w.signalToken) {
    await dropLinks([w.signalToken]);
  }
}

/** The wait steps of a definition that listen for this name. */
const waitsOf = (def: WizardDefinition | null | undefined, name: string) =>
  (def?.steps ?? []).flatMap((s) =>
    s.type === "wait" && s.signal?.name === name ? [s.signal] : [],
  );

export type SignalMisfit =
  /** Its wizard has no wait for this name: `names` are the ones it has. */
  | { names: string[] }
  /** The data lacks what its waits list. */
  | { fields: string[] };

/**
 * Whether a signal for this wizard fits: a wait of the draft, of the published version or of a run
 * that waits on an older one takes this name, and one of them takes this data.
 */
export async function signalMisfit(
  w: typeof schema.wizard.$inferSelect,
  name: string,
  data: Record<string, unknown> | undefined,
): Promise<SignalMisfit | null> {
  const published =
    w.publishedVersion === null
      ? null
      : await db.query.wizardVersion.findFirst({
          where: and(
            eq(schema.wizardVersion.wizardId, w.id),
            eq(schema.wizardVersion.version, w.publishedVersion),
          ),
        });
  const defs = [w.draft, published?.definition];
  const waits = defs.flatMap((def) => waitsOf(def, name));
  const running = await db.query.runWait.findMany({
    where: and(eq(schema.runWait.wizardId, w.id), eq(schema.runWait.name, name)),
    columns: { fields: true },
    limit: 200,
  });
  const lists = [...waits.map((s) => s.fields ?? null), ...running.map((r) => r.fields)];
  if (!lists.length) {
    const names = defs.flatMap((def) =>
      (def?.steps ?? []).flatMap((s) => (s.type === "wait" && s.signal ? [s.signal.name] : [])),
    );
    return { names: [...new Set(names)].filter(signalNameOpen) };
  }
  if (lists.some((fields) => !signalMissing(data, fields).length)) {
    return null;
  }
  return { fields: [...new Set(lists.flatMap((fields) => fields ?? []))] };
}

/** A signal's data, if it is small enough to keep. */
export function dataTooLarge(data: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(data ?? null)) > SIGNAL_DATA_BYTES;
}

/**
 * A signal from inside the space (a plugin, MCP): it may match across its wizards. Refused when
 * every wait that hears this name and key lists fields it lacks: no run would ever take it.
 */
export async function sendInsideSpace(
  spaceId: string,
  input: {
    name: string;
    key: string;
    data?: Record<string, unknown>;
    delivery?: string;
    source: string;
  },
): Promise<SentSignal> {
  await requireSignals();
  if (!signalNameOpen(input.name)) {
    throw new ServiceError("refused", `"${input.name}" is sent by the runtime itself.`);
  }
  if (!signalKey(input.key)) {
    throw new ServiceError("invalid", "A signal has a key.");
  }
  if (dataTooLarge(input.data)) {
    throw new ServiceError("invalid", `A signal's data holds at most ${SIGNAL_DATA_BYTES} bytes.`);
  }
  const waiting = await db.query.runWait.findMany({
    where: and(
      eq(schema.runWait.spaceId, spaceId),
      eq(schema.runWait.name, input.name),
      eq(schema.runWait.key, signalKey(input.key)),
    ),
    columns: { fields: true },
  });
  if (waiting.length && waiting.every((w) => signalMissing(input.data, w.fields).length)) {
    const fields = [...new Set(waiting.flatMap((w) => w.fields ?? []))];
    throw new ServiceError("invalid", `The data lacks what the waits list: ${fields.join(", ")}.`);
  }
  return sendSignal({ ...input, spaceId, scope: SPACE_SCOPE });
}

/** `send_signal`: from an MCP client, in the space of a wizard it may reach. */
export async function sendSignalForWizard(
  userId: string,
  wizardId: string,
  input: { name: string; key: string; data?: Record<string, unknown>; delivery?: string },
) {
  const w = await ownedWizard(userId, wizardId);
  return sendInsideSpace(w.spaceId, { ...input, source: "mcp" });
}

/** `server.signals.send`: from a plugin, in a space of its tenant. */
export async function sendSignalFromPlugin(
  pluginId: string,
  input: {
    spaceId: string;
    name: string;
    key: string;
    data?: Record<string, unknown>;
    delivery?: string;
  },
) {
  const space = await db.query.space.findFirst({
    where: and(eq(schema.space.id, input.spaceId), eq(schema.space.tenantId, currentTenant())),
    columns: { id: true },
  });
  if (!space) {
    throw notFound();
  }
  const { spaceId, ...rest } = input;
  return sendInsideSpace(spaceId, { ...rest, source: `plugin:${pluginId}` });
}

/**
 * "Testereignis senden": wakes one test run at the wait it stands at, and no other; what its wait
 * lists is filled with a placeholder. A live run hears only real signals.
 */
export async function sendTestSignal(userId: string, wizardId: string, runId: string) {
  await requireSignals();
  const w = await writableWizard(userId, wizardId);
  const run = await db.query.run.findFirst({
    where: and(eq(schema.run.id, runId), eq(schema.run.wizardId, w.id)),
  });
  if (!run) {
    throw notFound();
  }
  if (run.mode !== "test") {
    throw new ServiceError("refused", "Only a test run takes a test event.");
  }
  const step = run.definition.steps.find((s) => s.id === run.cursor);
  const fields = step?.type === "wait" ? (step.signal?.fields ?? []) : [];
  const sent = await signalRun(runId, {
    data: Object.fromEntries(fields.map((id) => [id, "Test"])),
    source: "test",
  });
  if (!sent) {
    throw new ServiceError("refused", "This run does not wait for an event.");
  }
  return sent;
}
