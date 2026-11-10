const ID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** A short random id, as a turn's. */
export function randomId(size = 12): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(size))) {
    id += ID_ALPHABET[byte & 63];
  }
  return id;
}

/**
 * A fixed step's effect id, `<run>:<step>:<visit>`, for what it does once per visit (the
 * runtime's broker/effect.ts). The visit is counted on the run before the step acts (advance's
 * `enterVisit`); null where nothing counted it.
 */
export function visitEffect(ctx: {
  runId: string;
  stepId: string;
  state: { visits?: Record<string, number> };
  durable: boolean;
}): string | null {
  const visit = ctx.state.visits?.[ctx.stepId];
  return ctx.durable && visit ? `${ctx.runId}:${ctx.stepId}:${visit}` : null;
}
