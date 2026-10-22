import { LIVE_KINDS, type LiveChange } from "@engenty/wizards-shared/live";
import type { SpaceTable } from "@engenty/wizards-shared/space-data";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { keys } from "../../lib/keys";
import type { WizardSummary } from "../../lib/session";
import { createPatcher, liveBindings, registerLiveBindings, registerLiveEditor } from "./patch";
import "./index";

// Live changes into the cache (docs/plans/live-changes.md, 5): patched where the cache holds the
// item, fetched again where it can't be, never an older state over a newer one.

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const row = (id: string, name: string, at: string) => ({
  id,
  cells: { name },
  updatedAt: at,
});

const table = (rows: ReturnType<typeof row>[]): SpaceTable =>
  ({
    id: "t1",
    projectId: "s1",
    wizardId: null,
    list: false,
    title: "Leads",
    format: null,
    columns: [],
    rows,
    readOnly: false,
    knowledge: null,
  }) as unknown as SpaceTable;

const card = (id: string, revision: number, title = "Report") =>
  ({
    id,
    projectId: "s1",
    title,
    revision,
    updatedAt: "2026-10-22T00:00:00.000Z",
  }) as WizardSummary;

describe("live bindings", () => {
  it("cover every kind", () => {
    const covered = new Set(liveBindings().flatMap((b) => b.kinds));
    expect([...LIVE_KINDS].filter((k) => !covered.has(k))).toEqual([]);
  });
});

describe("the patcher", () => {
  it("puts rows into an open table, last, without a request", async () => {
    const qc = fresh();
    const fetches = vi.fn(async () => table([]));
    await qc.prefetchQuery({ queryKey: keys.table("t1"), queryFn: fetches });
    const apply = createPatcher(qc);
    const changes: LiveChange[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "row",
      op: "put",
      item: `r${i}`,
      projectId: "s1",
      parent: "t1",
      view: { ...row(`r${i}`, `Lead ${i}`, "2026-10-22T10:00:00.000Z"), tableId: "t1" },
    }));
    await apply(changes);
    const rows = qc.getQueryData<SpaceTable>(keys.table("t1"))?.rows ?? [];
    expect(rows).toHaveLength(200);
    expect(rows[199]).toEqual(row("r199", "Lead 199", "2026-10-22T10:00:00.000Z"));
    expect(fetches).toHaveBeenCalledTimes(1);
    await apply([{ kind: "row", op: "del", item: "r0", projectId: "s1", parent: "t1" }]);
    expect(qc.getQueryData<SpaceTable>(keys.table("t1"))?.rows).toHaveLength(199);
  });

  it("never puts an older version over a newer one, nor the echo of an own save", async () => {
    const qc = fresh();
    qc.setQueryData(keys.table("t1"), table([row("r1", "New", "2026-10-22T10:00:05.000Z")]));
    const apply = createPatcher(qc);
    const before = qc.getQueryData(keys.table("t1"));
    for (const at of ["2026-10-22T10:00:01.000Z", "2026-10-22T10:00:05.000Z"]) {
      await apply([
        {
          kind: "row",
          op: "put",
          item: "r1",
          projectId: "s1",
          parent: "t1",
          view: { ...row("r1", "Old", at), tableId: "t1" },
        },
      ]);
    }
    expect(qc.getQueryData(keys.table("t1"))).toBe(before);
  });

  it("cancels a GET in flight, so its older answer can't land after the patch", async () => {
    const qc = fresh();
    qc.setQueryData(keys.table("t1"), table([]));
    let answer!: (t: SpaceTable) => void;
    const slow = new Promise<SpaceTable>((r) => {
      answer = r;
    });
    let calls = 0;
    const running = qc.fetchQuery({
      queryKey: keys.table("t1"),
      queryFn: () =>
        calls++ === 0
          ? slow
          : Promise.resolve(table([row("r1", "New", "2026-10-22T10:00:05.000Z")])),
      staleTime: 0,
    });
    await tick();
    await createPatcher(qc)([
      {
        kind: "row",
        op: "put",
        item: "r1",
        projectId: "s1",
        parent: "t1",
        view: { ...row("r1", "New", "2026-10-22T10:00:05.000Z"), tableId: "t1" },
      },
    ]);
    answer(table([]));
    await running.catch(() => undefined);
    await tick(10);
    expect(qc.getQueryData<SpaceTable>(keys.table("t1"))?.rows.map((r) => r.id)).toEqual(["r1"]);
  });

  it("adds a new wizard first to every list of the space and updates a known one in place", async () => {
    const qc = fresh();
    qc.setQueryData(["wizards", "s1", false], [card("w1", 1)]);
    qc.setQueryData(["wizards", "s1", "similar"], [card("w1", 1)]);
    const apply = createPatcher(qc);
    await apply([
      {
        kind: "wizard",
        op: "put",
        item: "w2",
        projectId: "s1",
        parent: null,
        view: { summary: card("w2", 1, "Offer"), detail: card("w2", 1, "Offer") },
      },
      {
        kind: "wizard",
        op: "put",
        item: "w1",
        projectId: "s1",
        parent: null,
        view: { summary: card("w1", 2, "Report, renamed"), detail: card("w1", 2) },
      },
    ]);
    for (const key of [
      ["wizards", "s1", false],
      ["wizards", "s1", "similar"],
    ]) {
      expect(qc.getQueryData<WizardSummary[]>(key)?.map((w) => [w.id, w.title])).toEqual([
        ["w2", "Offer"],
        ["w1", "Report, renamed"],
      ]);
    }
  });

  it("hands an open editor its item instead of writing the cache", async () => {
    const qc = fresh();
    const page = {
      id: "p1",
      projectId: "s1",
      title: "About",
      markdown: "Mine",
      updatedAt: "2026-10-22T10:00:00.000Z",
    };
    qc.setQueryData(keys.page("p1"), page);
    const heard: LiveChange[] = [];
    const stop = registerLiveEditor("page", "p1", (c) => heard.push(c));
    await createPatcher(qc)([
      {
        kind: "page",
        op: "put",
        item: "p1",
        projectId: "s1",
        parent: null,
        view: { ...page, markdown: "Theirs", updatedAt: "2026-10-22T10:00:09.000Z" },
      },
    ]);
    stop();
    expect(heard).toHaveLength(1);
    expect(qc.getQueryData(keys.page("p1"))).toBe(page);
  });

  it("fetches again what came without a view, and what a failing patcher left", async () => {
    const qc = fresh();
    const spy = vi.spyOn(qc, "invalidateQueries");
    registerLiveBindings([
      {
        id: "test-broken",
        kinds: ["connector"],
        patch: () => {
          throw new Error("broken");
        },
        fallback: () => [["test-broken"]],
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const apply = createPatcher(qc);
    await apply([{ kind: "page", op: "put", item: "p9", projectId: "s1", parent: null }]);
    await apply([
      { kind: "connector", op: "put", item: "s1:c1", projectId: "s1", parent: null, view: {} },
    ]);
    await tick(200);
    const fetched = spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    expect(fetched).toContain(JSON.stringify(keys.page("p9")));
    expect(fetched).toContain(JSON.stringify(["test-broken"]));
    warn.mockRestore();
  });
});
