import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { webContext } from "../render/chromium.js";
import { guestRun } from "../safety.js";
import {
  guestSandboxEngine,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxEngine,
  sandboxEngine,
} from "../sandbox/index.js";
import { getSecret, putSecret, type StoreScope } from "../store/index.js";

/** Sign-ins the person asked the wizard to keep, as Playwright storage state. */
const SESSION_SLOT = "browser";
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Someone watching the run's browser: gets each new picture of the page, null when it ends. */
export type BrowserWatcher = (frame: Buffer | null) => void;

/** Who drives the browser: the agent, or the person who took it over. */
export type BrowserSeat = "agent" | "person";

/** A person who took the browser over and does nothing on it this long hands it back. */
const SEAT_IDLE_MS = 3 * 60_000;

/**
 * The sandbox engine of a run: a member's (a `userId`) and a Work chat's is the server's
 * (`SANDBOX`); a guest's – a live run with a visitor and no user, a plugin door's among them –
 * is `SANDBOX_GUESTS`: agentOS when it is ready, else none, never Docker. The one place where a
 * run's engine is picked (docs/plans/capabilities.md, A1).
 */
export function runSandboxEngine(run: {
  mode: string;
  userId: string | null;
}): SandboxEngine | null {
  return guestRun(run) ? guestSandboxEngine() : sandboxEngine();
}

/**
 * What a run holds while an agent works: a browser context and a sandbox, both made on first
 * use and released when the run stops running.
 */
export class RunResources {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sandbox: Sandbox | null = null;
  /** The engine this run's sandbox is made on; null until bound, or when the run has none. */
  private engine: SandboxEngine | null = null;
  private scope: StoreScope | null = null;
  /** Changes the person allowed for the rest of this run, as "<connection>:<action>". */
  readonly allowed = new Set<string>();
  private watchers = new Set<BrowserWatcher>();
  private cast: { page: Page; session: CDPSession } | null = null;
  /** The latest picture of the page, for a watcher who comes in between two changes. */
  private frame: Buffer | null = null;
  private seat: BrowserSeat = "agent";
  private seatBack: (() => void)[] = [];
  private seatIdle: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly runId: string) {}

  /** Whose store kept sign-ins are read from and written to, and whose run this is. */
  bind(scope: StoreScope, run: { mode: string; userId: string | null }) {
    this.scope = scope;
    this.engine = runSandboxEngine(run);
  }

  /** What this run's sandbox runs, or null when the run has none (a guest's, or `SANDBOX=off`). */
  sandboxCapabilities(): SandboxCapabilities | null {
    return this.engine?.capabilities() ?? null;
  }

  async browserContext(): Promise<BrowserContext> {
    if (!this.context) {
      const kept = this.scope
        ? await getSecret<StorageState>(this.scope, SESSION_SLOT).catch(() => null)
        : null;
      this.context = await webContext({
        locale: "de-DE",
        ...(kept ? { storageState: kept.data } : {}),
      });
    }
    return this.context;
  }

  async browserPage(): Promise<Page> {
    const context = await this.browserContext();
    if (!this.page || this.page.isClosed()) {
      this.page = await context.newPage();
      void this.recast();
    }
    return this.page;
  }

  /** The page the agent has open, if any — without opening a browser for the question. */
  openPage(): Page | null {
    return this.page && !this.page.isClosed() ? this.page : null;
  }

  /** A link opened a new tab: the agent goes on there. */
  adopt(page: Page) {
    this.page = page;
    void this.recast();
  }

  /**
   * Watches the browser as it works: the page's pictures as Chromium paints them, on whichever
   * page the agent is on. Ends (null) when the run lets the browser go.
   */
  watchBrowser(watcher: BrowserWatcher): () => void {
    this.watchers.add(watcher);
    if (this.frame) {
      watcher(this.frame);
    }
    void this.recast();
    return () => {
      this.watchers.delete(watcher);
      if (!this.watchers.size) {
        void this.stopCast();
      }
    };
  }

  seatHolder(): BrowserSeat {
    return this.seat;
  }

  /**
   * The person takes the browser over, or hands it back. While they hold it the agent's browser
   * steps wait; a person who does nothing for a while hands it back by themselves.
   */
  setSeat(to: BrowserSeat) {
    this.seat = to;
    if (this.seatIdle) {
      clearTimeout(this.seatIdle);
      this.seatIdle = null;
    }
    if (to === "person") {
      this.seatIdle = setTimeout(() => this.setSeat("agent"), SEAT_IDLE_MS);
      return;
    }
    const waiting = this.seatBack;
    this.seatBack = [];
    for (const resume of waiting) {
      resume();
    }
  }

  /** The person did something on the page: their seat stays theirs a while longer. */
  touchSeat() {
    if (this.seat === "person") {
      this.setSeat("person");
    }
  }

  /** Waits while the person holds the browser; true when it had to. */
  async agentTurn(signal?: AbortSignal): Promise<boolean> {
    if (this.seat === "agent") {
      return false;
    }
    await new Promise<void>((resume) => {
      this.seatBack.push(resume);
      signal?.addEventListener("abort", () => resume(), { once: true });
    });
    return true;
  }

  /** Points the screencast at the agent's current page, while anyone watches. */
  private async recast() {
    const page = this.openPage();
    if (!(page && this.watchers.size) || this.cast?.page === page) {
      return;
    }
    await this.stopCast();
    const session = await page
      .context()
      .newCDPSession(page)
      .catch(() => null);
    if (!session) {
      return;
    }
    this.cast = { page, session };
    session.on("Page.screencastFrame", ({ data, sessionId }) => {
      session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      if (this.cast?.session !== session) {
        return;
      }
      this.frame = Buffer.from(data, "base64");
      for (const watcher of this.watchers) {
        watcher(this.frame);
      }
    });
    await session
      .send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 960, maxHeight: 720 })
      .catch(() => undefined);
  }

  private async stopCast() {
    const cast = this.cast;
    this.cast = null;
    await cast?.session.detach().catch(() => undefined);
  }

  /** Keeps the browser's sign-ins for the person's next run (they ticked "remember"). */
  async keepSession() {
    if (this.context && this.scope) {
      await putSecret(
        this.scope,
        SESSION_SLOT,
        "browser",
        "Browser-Anmeldungen",
        await this.context.storageState(),
      );
    }
  }

  sandboxHandle(): Sandbox {
    if (!this.engine) {
      throw new Error("This run has no sandbox.");
    }
    this.sandbox ??= this.engine.create(this.runId);
    return this.sandbox;
  }

  async release() {
    const context = this.context;
    const sandbox = this.sandbox;
    this.context = null;
    this.page = null;
    this.sandbox = null;
    this.frame = null;
    this.setSeat("agent");
    await this.stopCast();
    for (const watcher of this.watchers) {
      watcher(null);
    }
    this.watchers.clear();
    await context?.close().catch(() => undefined);
    await sandbox?.destroy().catch(() => undefined);
  }
}

const live = new Map<string, RunResources>();

export function resourcesFor(runId: string): RunResources {
  let r = live.get(runId);
  if (!r) {
    r = new RunResources(runId);
    live.set(runId, r);
  }
  return r;
}

/** The resources of a run that is working right now, if it has any. */
export function liveResources(runId: string): RunResources | null {
  return live.get(runId) ?? null;
}

export async function releaseResources(runId: string) {
  const r = live.get(runId);
  live.delete(runId);
  await r?.release();
}
