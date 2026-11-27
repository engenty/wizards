import { createKernel } from "./kernel.js";
import type { Battery, Run, Store, Wizard } from "./types.js";

/** The part of a Durable Object's state this host uses. */
type ObjectState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
};

export type EdgeOptions = {
  wizards: (id: string) => Wizard | Promise<Wizard>;
  batteries?: Record<string, Battery>;
};

/**
 * A run as a Durable Object: one object per run, the run in the object's own storage, its alarm
 * as the wake. The object handles one request at a time, which is the fence a database gives
 * with `rev`. Between two requests nothing runs and nothing is kept in memory.
 *
 *   POST /start   { wizard, input }
 *   POST /answer  { row, value, by? }
 *   POST /rewind  { row, value? }
 *   POST /judge
 *   GET  /        the run
 */
export function runObject({ wizards, batteries }: EdgeOptions) {
  return class RunObject {
    kernel;
    constructor(readonly state: ObjectState) {
      const store: Store = {
        load: () => state.storage.get<Run>("run"),
        save: async (run) => {
          run.rev++;
          await state.storage.put("run", run);
        },
      };
      this.kernel = createKernel({ store, wizards, batteries });
    }

    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      const body = request.method === "POST" ? ((await request.json()) as Record<string, any>) : {};
      try {
        const run =
          pathname === "/start"
            ? await this.kernel.start(body.wizard, body.input, "run")
            : pathname === "/answer"
              ? await this.kernel.answer("run", body.row, body.value, body.by)
              : pathname === "/rewind"
                ? await this.kernel.rewind("run", body.row, body.value)
                : pathname === "/judge"
                  ? await this.kernel.judge("run")
                  : await this.kernel.read("run");
        await this.sleep(run);
        return Response.json(run);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    }

    async alarm(): Promise<void> {
      await this.sleep(await this.kernel.wake("run"));
    }

    async sleep(run: Run): Promise<void> {
      if (run.wakeAt) await this.state.storage.setAlarm(run.wakeAt);
      else await this.state.storage.deleteAlarm();
    }
  };
}
