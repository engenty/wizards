/**
 * The Worker as a test's build has it with `clock` (local-edge.ts): its objects' clock can be
 * moved on, or held still, which workerd cannot do itself. Only tests build it; the Worker that
 * ships is `src/worker.ts` as it is.
 *
 * The clock is the isolate's, so every object of this Worker shares it: `Date.now()` is workerd's
 * moved on by `ahead`, or held at `heldAt`. An object's alarm is kept in workerd's own time, so
 * the objects set and read it through the moved clock; moving the clock on moves an object's
 * pending alarm back by as much, as if that time had gone by.
 *
 * `POST /__test/clock/<run>` `{ advance?: ms, hold?: true }` moves the clock (and that run's
 * object's alarm), `GET` the same path reads it: `{ now, alarm }`, both on the moved clock.
 */
import type { EdgeEnv } from "../src/run-object.js";
import worker, { RunObject as ShippedRunObject } from "../src/worker.js";
import { CLOCK_PATH } from "./clock-path.js";

const workerdNow = Date.now.bind(Date);
let ahead = 0;
let heldAt: number | null = null;
Date.now = () => heldAt ?? workerdNow() + ahead;

/** How far the objects' clock is from workerd's. */
const skew = () => Date.now() - workerdNow();

/** The object's state, its alarm set and read on the moved clock. */
function onMovedClock(ctx: DurableObjectState): DurableObjectState {
  const own = <T extends object>(target: T, key: string | symbol) => {
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  const storage = new Proxy(ctx.storage, {
    get(target, key) {
      if (key === "setAlarm") {
        return (at: number | Date) => target.setAlarm(Number(at) - skew());
      }
      if (key === "getAlarm") {
        return async () => {
          const at = await target.getAlarm();
          return at === null ? null : at + skew();
        };
      }
      return own(target, key);
    },
  });
  return new Proxy(ctx, {
    get: (target, key) => (key === "storage" ? storage : own(target, key)),
  });
}

export class RunObject extends ShippedRunObject {
  private readonly workerdStorage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: EdgeEnv) {
    super(onMovedClock(ctx), env);
    this.workerdStorage = ctx.storage;
  }

  override async fetch(request: Request): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith(CLOCK_PATH)) {
      return super.fetch(request);
    }
    if (request.method === "POST") {
      const { advance = 0, hold = false } = (await request.json()) as {
        advance?: number;
        hold?: boolean;
      };
      const alarm = await this.workerdStorage.getAlarm();
      ahead += advance;
      if (hold) {
        heldAt = Date.now();
      }
      // The time went by for this object's alarm too: what was due within it is due now.
      if (alarm !== null && advance > 0) {
        await this.workerdStorage.setAlarm(Math.max(workerdNow(), alarm - advance));
      }
    }
    const alarm = await this.workerdStorage.getAlarm();
    return Response.json({ now: Date.now(), alarm: alarm === null ? null : alarm + skew() });
  }
}

export default {
  fetch(request: Request, env: EdgeEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(CLOCK_PATH)) {
      const runId = decodeURIComponent(pathname.slice(CLOCK_PATH.length));
      return env.RUN.get(env.RUN.idFromName(runId)).fetch(request);
    }
    return worker.fetch(request, env);
  },
};
