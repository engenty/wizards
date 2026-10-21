/**
 * A classic three-way merge of text, line by line (diff3): what one side changed and the other
 * left as it was is taken; where both changed the same lines differently, the merge is not
 * clean. For prose and code (a page's Markdown, a widget's file), not for JSON: a wizard merges
 * by its structure (sync-merge.ts).
 */

/** Pairs of equal lines `[i in a, j in b]`, in order: a longest common subsequence (Myers). */
function commonLines(a: string[], b: string[], maxEdits: number): [number, number][] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) {
    pairs.push([i, i]);
  }
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0) {
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max && d <= maxEdits; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
            ? v[offset + k + 1]
            : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[start + x] === b[start + y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    if (!found) {
      return null;
    }
    // Back along the trace: each step's diagonal is a run of equal lines.
    const middle: [number, number][] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
      const t = trace[d];
      const k = x - y;
      const prevK = k === -d || (k !== d && t[offset + k - 1] < t[offset + k + 1]) ? k + 1 : k - 1;
      const prevX = d === 0 ? 0 : t[offset + prevK];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x--;
        y--;
        middle.push([start + x, start + y]);
      }
      if (d > 0) {
        x = prevX;
        y = prevY;
      }
    }
    pairs.push(...middle.reverse());
  }
  for (let i = 0; i < a.length - endA; i++) {
    pairs.push([endA + i, endB + i]);
  }
  return pairs;
}

const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

export interface TextMerge {
  /** The merged text; where it is not clean, the local side's lines stand in the conflict's place. */
  text: string;
  clean: boolean;
  /** How many places both sides changed differently. */
  conflicts: number;
}

/** More differing lines than this between two versions: no merge is tried, it is a conflict. */
const MAX_EDITS = 4000;

export function mergeText(base: string, local: string, remote: string): TextMerge {
  if (local === remote || remote === base) {
    return { text: local, clean: true, conflicts: 0 };
  }
  if (local === base) {
    return { text: remote, clean: true, conflicts: 0 };
  }
  const o = base.split("\n");
  const a = local.split("\n");
  const b = remote.split("\n");
  const inA = commonLines(o, a, MAX_EDITS);
  const inB = commonLines(o, b, MAX_EDITS);
  if (!inA || !inB) {
    return { text: local, clean: false, conflicts: 1 };
  }
  const aOf = new Map(inA.map(([i, j]) => [i, j]));
  const bOf = new Map(inB.map(([i, j]) => [i, j]));
  const out: string[] = [];
  let conflicts = 0;
  let i = 0;
  let ia = 0;
  let ib = 0;
  const chunk = (j: number, ja: number, jb: number) => {
    const ob = o.slice(i, j);
    const ac = a.slice(ia, ja);
    const bc = b.slice(ib, jb);
    if (sameLines(ac, ob)) {
      out.push(...bc);
    } else if (sameLines(bc, ob) || sameLines(ac, bc)) {
      out.push(...ac);
    } else {
      conflicts++;
      out.push(...ac);
    }
  };
  for (let j = 0; j < o.length; j++) {
    const ja = aOf.get(j);
    const jb = bOf.get(j);
    // A line both sides kept where it was: everything before it is one chunk.
    if (ja === undefined || jb === undefined || ja < ia || jb < ib) {
      continue;
    }
    chunk(j, ja, jb);
    out.push(o[j]);
    i = j + 1;
    ia = ja + 1;
    ib = jb + 1;
  }
  chunk(o.length, a.length, b.length);
  return { text: out.join("\n"), clean: conflicts === 0, conflicts };
}
