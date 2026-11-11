import { eq } from "drizzle-orm";
import { db, schema, withTenant } from "../db/client.js";
import type { RunRow } from "../engine/run-store.js";
import {
  type RunClaims,
  type RunTokenFault,
  runToken,
  runTokenClaims,
} from "../secrets/signing.js";
import { holderOf } from "../store/index.js";
import { runOver } from "./over.js";

/*
 * A run's token (docs/plans/runs-on-their-own.md, "Record, state, token"): every request of a run
 * carries it, and the broker reads the run's tenant, the run and where it works from it. The
 * token is signed like the tickets (`env.authSecret`) and never kept: the run keeps its id
 * (`run.token_id`, drawn in `createRun`) and the runtime signs it again from the run.
 *
 * Its expiry is long on purpose, since a run can wait for days: the run's status is the revoke.
 * A run that was stopped, is done or failed opens nothing (`runOver`).
 */

/** How long a token of a run that is kept for good lasts from signing. */
export const RUN_TOKEN_DAYS = 30;

type TokenRun = Pick<
  RunRow,
  | "id"
  | "tenantId"
  | "wizardId"
  | "mode"
  | "userId"
  | "visitorId"
  | "clientSpaceId"
  | "tokenId"
  | "host"
> & { expiresAt: Date | null };

/**
 * When a token signed now ends: when the run is deleted (`expiresAt`, which moves later while the
 * run waits), else `RUN_TOKEN_DAYS` from now.
 */
function expiryOf(run: Pick<TokenRun, "expiresAt">): number {
  const at = run.expiresAt?.getTime() ?? Date.now() + RUN_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  return Math.floor(at / 1000);
}

/** The claims of a run, from its record, in the current tenant: null for a run without a token. */
async function claimsOf(run: TokenRun): Promise<RunClaims | null> {
  if (!run.tokenId) {
    return null;
  }
  const wizard = await db.query.wizard.findFirst({
    columns: { spaceId: true },
    where: eq(schema.wizard.id, run.wizardId),
  });
  if (!wizard) {
    return null;
  }
  return {
    jti: run.tokenId,
    tenant: run.tenantId,
    run: run.id,
    wizard: run.wizardId,
    space: wizard.spaceId,
    dataSpace: run.clientSpaceId ?? wizard.spaceId,
    mode: run.mode,
    holder: holderOf(run),
    host: run.host?.kind ?? "runtime",
    exp: expiryOf(run),
  };
}

/**
 * The token of a run, signed again from its record in the current tenant: the same id, so it
 * reads as the one handed out before. Null for a run from before tokens.
 */
export async function tokenOf(run: TokenRun): Promise<string | null> {
  const claims = await claimsOf(run);
  return claims && runToken(claims);
}

/** Why a token opens nothing: what `runTokenClaims` refuses, or what the run says. */
export type RunTokenRefusal =
  | RunTokenFault
  /** The tenant the token names has no such run. */
  | "no_run"
  /** The run has another token, or none (a run from before tokens). */
  | "not_this_run"
  /** The token says something of the run its record does not. */
  | "claims"
  /** The run was stopped, is done or failed. */
  | "over";

/** Every claim but the expiry, which moves with the run: the record has the last word. */
const CHECKED = [
  "jti",
  "tenant",
  "run",
  "wizard",
  "space",
  "dataSpace",
  "mode",
  "holder",
  "host",
] as const;

/**
 * What a run's token opens: its claims, once the signature, the expiry and the run itself agree,
 * else why not. The tenant comes from the token alone, and its database is opened here. It never
 * throws for a bad token. `ended`: a run that ended opens it too, for what only lets go of the
 * run's things (its resources' release), never for a call that works for it.
 */
export async function readRunToken(
  token: string,
  { ended = false }: { ended?: boolean } = {},
): Promise<{ claims: RunClaims } | { refused: RunTokenRefusal }> {
  const read = runTokenClaims(token);
  if ("refused" in read) {
    return read;
  }
  const { claims } = read;
  return withTenant(claims.tenant, async () => {
    const run = await db.query.run.findFirst({
      columns: {
        id: true,
        tenantId: true,
        wizardId: true,
        mode: true,
        userId: true,
        visitorId: true,
        clientSpaceId: true,
        tokenId: true,
        host: true,
        expiresAt: true,
      },
      where: eq(schema.run.id, claims.run),
    });
    if (!run || run.tenantId !== claims.tenant) {
      return { refused: "no_run" as const };
    }
    if (!run.tokenId || run.tokenId !== claims.jti) {
      return { refused: "not_this_run" as const };
    }
    const record = await claimsOf(run);
    if (!record || CHECKED.some((key) => record[key] !== claims[key])) {
      return { refused: "claims" as const };
    }
    if (!ended && (await runOver({ runId: run.id }))) {
      return { refused: "over" as const };
    }
    return { claims };
  });
}
