import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SessionUser } from "../auth/index.js";
import { feature, remoteFeatures } from "../features.js";
import { type LiveEvent, openStreams, subscribe } from "../live/hub.js";
import { itemView } from "../live/views.js";
import { asRole } from "../services/access.js";
import { chatChangesFor } from "../services/work-chats.js";
import { requestLang, say } from "./lang.js";

type Vars = { Variables: { user: SessionUser } };

/** At most this many streams per person and per tenant in one process. */
export const STREAM_LIMITS = { person: 20, tenant: 200 };
/** A stream ends after this long; the browser reconnects, and the session is checked again. */
const LIFETIME_MS = 30 * 60_000;
const PING_MS = 20_000;

const perPerson = new Map<string, number>();

/**
 * What changed in the tenant while the studio is open (docs/plans/live-changes.md, 3): ids, by
 * the feed's numbers. `Last-Event-ID` or `?since=` resumes after a drop.
 */
export const liveRoutes = new Hono<Vars>().get("/", async (c) => {
  if (!feature("liveChanges", await remoteFeatures().catch(() => null))) {
    return c.json({ error: say(c, "notFound"), code: "not_found" }, 404);
  }
  const user = c.get("user");
  const person = `${user.tenantId}|${user.id}`;
  if (
    (perPerson.get(person) ?? 0) >= STREAM_LIMITS.person ||
    openStreams(user.tenantId) >= STREAM_LIMITS.tenant
  ) {
    return c.json({ error: say(c, "tooManyStreams"), code: "too_many_streams" }, 429);
  }
  const raw = c.req.header("last-event-id") ?? c.req.query("since");
  const since = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  c.header("cache-control", "no-cache, no-transform");
  c.header("x-accel-buffering", "no");
  perPerson.set(person, (perPerson.get(person) ?? 0) + 1);
  return streamSSE(c, async (stream) => {
    let closed = false;
    const queue: LiveEvent[] = [];
    let writing = Promise.resolve();
    const send = (e: LiveEvent) => {
      if (closed) {
        return;
      }
      queue.push(e);
      writing = writing.then(async () => {
        const next = queue.shift();
        if (!next || closed) {
          return;
        }
        // A private chat's changes go to its members only (Work's chats).
        if (next.event === "changes" && next.items.some((i) => i.kind === "chat")) {
          next.items = await chatChangesFor(user, next.items);
        }
        const { event, ...data } = next;
        await stream.writeSSE({
          event,
          data: JSON.stringify(data),
          ...("seq" in next ? { id: String(next.seq) } : {}),
        });
      });
    };
    const reader = { userId: user.id, lang: requestLang(c) };
    const unsubscribe = await subscribe(user.tenantId, since, send, {
      key: `${user.role}|${reader.lang}`,
      read: (x) => asRole(user.role, () => itemView(reader, x)),
    });
    const end = () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      const left = (perPerson.get(person) ?? 1) - 1;
      if (left > 0) {
        perPerson.set(person, left);
      } else {
        perPerson.delete(person);
      }
    };
    stream.onAbort(end);
    const until = Date.now() + LIFETIME_MS;
    while (!closed && Date.now() < until) {
      await stream.sleep(Math.min(PING_MS, until - Date.now()));
      if (!closed) {
        await writing;
        await stream.writeSSE({ event: "ping", data: "" });
      }
    }
    end();
  });
});
