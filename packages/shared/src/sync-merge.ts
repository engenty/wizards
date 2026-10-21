import { mergeText } from "./text-merge.js";

/**
 * A three-way merge of JSON, for what syncs between an install and the cloud
 * (docs/plans/tenant-sync.md): a wizard's definition, a page, a row, the space's details.
 * Objects merge key by key; a list of items that each carry an `id` merges item by item, its
 * order taken from the side that changed it; text that both sides changed merges line by line.
 * Everything else is one value: changed on one side, that side's; changed on both to different
 * values, a conflict, named by where it is. Unlike `mergeDrafts` (merge.ts), which lets the
 * studio's side win, this one says what it could not settle.
 */

/** A step on the way to a value: a key of an object, or the item of a list with that `id`. */
export type MergePathPart = string | { id: string };
export type MergePath = MergePathPart[];

export interface MergeConflict {
  path: MergePath;
  /**
   * `value`: both changed it differently. `removed`: one side removed an item the other changed
   * (the removed side's value is `undefined`). `order`: both reordered a list differently; the
   * values are the lists of ids.
   */
  kind: "value" | "removed" | "order";
  base: unknown;
  local: unknown;
  remote: unknown;
}

export interface JsonMerge<T> {
  /** The merge; at a conflict it holds the local side. */
  value: T;
  conflicts: MergeConflict[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | null => (isObject(v) && typeof v.id === "string" ? v.id : null);
const keyed = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.every((x) => idOf(x) !== null) && new Set(v.map(idOf)).size === v.length;
const multiline = (...values: unknown[]) =>
  values.every((v) => typeof v === "string") && values.some((v) => (v as string).includes("\n"));

export function mergeJson<T>(base: T, local: T, remote: T): JsonMerge<T> {
  const conflicts: MergeConflict[] = [];
  const value = merge(base, local, remote, [], conflicts) as T;
  return { value, conflicts };
}

function merge(
  base: unknown,
  local: unknown,
  remote: unknown,
  path: MergePath,
  conflicts: MergeConflict[],
): unknown {
  if (same(local, remote)) {
    return local;
  }
  if (same(base, local)) {
    return remote;
  }
  if (same(base, remote)) {
    return local;
  }
  if (isObject(local) && isObject(remote)) {
    const b = isObject(base) ? base : {};
    const out: Record<string, unknown> = {};
    // The local side's key order, then keys only the remote side has.
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(b)])) {
      const v = merge(b[key], local[key], remote[key], [...path, key], conflicts);
      if (v !== undefined) {
        out[key] = v;
      }
    }
    return out;
  }
  if (keyed(local) && keyed(remote) && (base === undefined || keyed(base))) {
    return mergeList((base as Record<string, unknown>[]) ?? [], local, remote, path, conflicts);
  }
  if (multiline(base ?? "", local, remote)) {
    const text = mergeText((base as string) ?? "", local as string, remote as string);
    if (text.clean) {
      return text.text;
    }
  }
  conflicts.push({ path, kind: "value", base, local, remote });
  return local;
}

function mergeList(
  base: Record<string, unknown>[],
  local: Record<string, unknown>[],
  remote: Record<string, unknown>[],
  path: MergePath,
  conflicts: MergeConflict[],
): Record<string, unknown>[] {
  const by = (list: Record<string, unknown>[]) => new Map(list.map((x) => [idOf(x) as string, x]));
  const [B, L, R] = [by(base), by(local), by(remote)];
  const items = new Map<string, unknown>();
  for (const id of new Set([...L.keys(), ...R.keys(), ...B.keys()])) {
    const [b, l, r] = [B.get(id), L.get(id), R.get(id)];
    const at = [...path, { id }];
    if (b !== undefined && (l === undefined || r === undefined)) {
      // Removed on one side: gone, unless the other side changed it meanwhile.
      const kept = l ?? r;
      if (kept !== undefined && !same(kept, b)) {
        conflicts.push({ path: at, kind: "removed", base: b, local: l, remote: r });
        if (l !== undefined) {
          items.set(id, l);
        }
      }
      continue;
    }
    const v = merge(b, l, r, at, conflicts);
    if (v !== undefined) {
      items.set(id, v);
    }
  }
  // The order: of the items all three have, the side that moved them wins.
  const common = (list: Record<string, unknown>[]) =>
    list.map((x) => idOf(x) as string).filter((id) => B.has(id) && L.has(id) && R.has(id));
  const [ob, ol, or] = [common(base), common(local), common(remote)];
  const localMoved = !same(ob, ol);
  const remoteMoved = !same(ob, or);
  if (localMoved && remoteMoved && !same(ol, or)) {
    conflicts.push({ path, kind: "order", base: ob, local: ol, remote: or });
  }
  const order = (remoteMoved && !localMoved ? remote : local).map((x) => idOf(x) as string);
  // Items the chosen order lacks: after the item they follow on their own side, and after what
  // the other side added there (the local side's additions come first).
  for (const side of [local, remote]) {
    const own = new Set(side.map((x) => idOf(x) as string));
    side.forEach((x, i) => {
      const id = idOf(x) as string;
      if (order.includes(id)) {
        return;
      }
      const before = side
        .slice(0, i)
        .reverse()
        .find((p) => order.includes(idOf(p) as string));
      let at = before ? order.indexOf(idOf(before) as string) + 1 : 0;
      while (at < order.length && !B.has(order[at]) && !own.has(order[at])) {
        at++;
      }
      order.splice(at, 0, id);
    });
  }
  return order.filter((id) => items.has(id)).map((id) => items.get(id) as Record<string, unknown>);
}

// --- settling the conflicts ------------------------------------------------------------

/** What the person chose for one conflict: a side, or a value of their own. */
export type MergeChoice = { take: "local" | "remote" } | { value: unknown };

/** The value at `path`, or `undefined`. */
export function valueAt(root: unknown, path: MergePath): unknown {
  let at: unknown = root;
  for (const part of path) {
    if (typeof part === "string") {
      at = isObject(at) ? at[part] : undefined;
    } else {
      at = Array.isArray(at) ? at.find((x) => idOf(x) === part.id) : undefined;
    }
  }
  return at;
}

/**
 * `root` with `value` at `path` (`undefined` removes it). An item that is not in its list goes
 * where it stands in `hint`, the side it came from.
 */
export function withValueAt(
  root: unknown,
  path: MergePath,
  value: unknown,
  hint?: unknown,
): unknown {
  if (!path.length) {
    return value;
  }
  const [part, ...rest] = path;
  if (typeof part === "string") {
    const obj = isObject(root) ? { ...root } : {};
    const next = withValueAt(obj[part], rest, value, valueAt(hint, [part]));
    if (next === undefined) {
      delete obj[part];
    } else {
      obj[part] = next;
    }
    return obj;
  }
  const list = Array.isArray(root) ? [...root] : [];
  const at = list.findIndex((x) => idOf(x) === part.id);
  const hintList = Array.isArray(hint) ? hint : [];
  const next = withValueAt(
    at === -1 ? undefined : list[at],
    rest,
    value,
    hintList.find((x) => idOf(x) === part.id),
  );
  if (at !== -1) {
    if (next === undefined) {
      list.splice(at, 1);
    } else {
      list[at] = next;
    }
    return list;
  }
  if (next === undefined) {
    return list;
  }
  // Where it stands on its own side: after the item it follows there.
  const i = hintList.findIndex((x) => idOf(x) === part.id);
  const before = hintList
    .slice(0, Math.max(0, i))
    .reverse()
    .map(idOf)
    .find((id) => list.some((x) => idOf(x) === id));
  list.splice(before ? list.findIndex((x) => idOf(x) === before) + 1 : 0, 0, next);
  return list;
}

/** A list in the order of `ids`; items not named keep their place after the one they follow. */
function reordered(list: unknown, ids: string[]): unknown {
  if (!Array.isArray(list)) {
    return list;
  }
  const named = ids.map((id) => list.find((x) => idOf(x) === id)).filter((x) => x !== undefined);
  const rest = list.filter((x) => !ids.includes(idOf(x) ?? ""));
  const out = [...named];
  for (const x of rest) {
    const i = list.indexOf(x);
    const before = list
      .slice(0, i)
      .reverse()
      .find((p) => out.includes(p));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, x);
  }
  return out;
}

/**
 * The merge with each conflict settled as chosen, in order. A conflict without a choice keeps
 * the local side, which the merge already holds.
 */
export function settleConflicts<T>(
  merged: T,
  conflicts: MergeConflict[],
  choices: (MergeChoice | null | undefined)[],
  sides: { local: T; remote: T },
): T {
  let out: unknown = merged;
  conflicts.forEach((c, i) => {
    const choice = choices[i];
    if (!choice) {
      return;
    }
    const pick = "take" in choice ? (choice.take === "local" ? c.local : c.remote) : choice.value;
    const from = "take" in choice ? (choice.take === "local" ? sides.local : sides.remote) : merged;
    if (c.kind === "order") {
      out = withValueAt(out, c.path, reordered(valueAt(out, c.path), pick as string[]));
      return;
    }
    out = withValueAt(out, c.path, pick, from);
  });
  return out as T;
}

/** A path as people read it, given the names of its items: `Steps › “File the report” › title`. */
export function pathLabel(
  path: MergePath,
  root: unknown,
  nameOf?: (item: unknown) => string | null,
) {
  const parts: string[] = [];
  let at: unknown = root;
  for (const part of path) {
    if (typeof part === "string") {
      parts.push(part);
      at = isObject(at) ? at[part] : undefined;
    } else {
      at = Array.isArray(at) ? at.find((x) => idOf(x) === part.id) : undefined;
      const name = (at !== undefined && nameOf?.(at)) || part.id;
      parts.push(`“${name}”`);
    }
  }
  return parts.join(" › ");
}
