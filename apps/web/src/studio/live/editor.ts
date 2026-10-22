import type { LiveKind } from "@engenty/wizards-shared/live";
import { useCallback, useEffect, useRef, useState } from "react";
import { registerLiveEditor } from "./patch";

/**
 * An open editor that takes changes from elsewhere (docs/plans/live-changes.md, 6). Nothing
 * unsaved: the change shows at once. Something typed: the change waits, nothing moves under the
 * caret, and the next autosave merges it in first. A save that still meets a newer version gets
 * a 409 and merges the same way. When both changed the same place, the person chooses.
 */

/** A version of what the editor edits, and its stamp (`updatedAt`). */
export interface Version<T> {
  value: T;
  at: string;
}

/** The editor's text, whatever draws it: a textarea today, CodeMirror later. */
export interface TextSurface<T> {
  /** Shows a value that came from elsewhere; it counts as saved. */
  apply: (value: T) => void;
  /** Something is typed and not saved yet, or a save is under way. */
  hasUnsavedEdits: () => boolean;
  /** Saves what is there now. */
  saveNow: () => void;
}

/** The server refused a save: the item changed after `baseAt`. `theirs` is how it is now. */
export class LiveConflict<T> extends Error {
  constructor(readonly theirs: Version<T>) {
    super("changed elsewhere");
  }
}

export type LiveNotice = "merged" | "conflict" | null;

export interface LiveEditor<T> {
  save: (mine: T) => Promise<void>;
  notice: LiveNotice;
  keepMine: () => void;
  takeTheirs: () => void;
}

const newer = (a: string, b: string) => Date.parse(a) > Date.parse(b);

export function useLiveEditor<T>(options: {
  kind: LiveKind;
  id: string;
  initial: Version<T>;
  fromView: (view: unknown) => Version<T> | null;
  merge: (base: T, mine: T, theirs: T) => { value: T; clean: boolean };
  same: (a: T, b: T) => boolean;
  surface: TextSurface<T>;
  /** Saves `value` over the version stamped `baseAt`; resolves with the new stamp. */
  send: (value: T, baseAt: string) => Promise<string>;
}): LiveEditor<T> {
  const opts = useRef(options);
  opts.current = options;
  const base = useRef(options.initial);
  const held = useRef<Version<T> | null>(null);
  const clash = useRef<Version<T> | null>(null);
  const [notice, setNotice] = useState<LiveNotice>(null);

  const take = useCallback((v: Version<T>) => {
    base.current = v;
    opts.current.surface.apply(v.value);
  }, []);

  useEffect(
    () =>
      registerLiveEditor(options.kind, options.id, (change) => {
        const v = change.view === undefined ? null : opts.current.fromView(change.view);
        if (!v || !newer(v.at, base.current.at)) {
          return;
        }
        if (clash.current) {
          clash.current = v;
        } else if (opts.current.surface.hasUnsavedEdits()) {
          held.current = v;
        } else {
          take(v);
        }
      }),
    [options.kind, options.id, take],
  );

  useEffect(() => {
    if (notice !== "merged") {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** The autosave's save: merges what came meanwhile, then sends. */
  const save = useCallback(async (mine: T, again = 1): Promise<void> => {
    const o = opts.current;
    if (clash.current) {
      // The person decides first; until then nothing is sent over the other version.
      return;
    }
    let value = mine;
    let baseAt = base.current.at;
    const theirs = held.current;
    held.current = null;
    if (theirs) {
      const merged = o.merge(base.current.value, mine, theirs.value);
      if (!merged.clean) {
        clash.current = theirs;
        setNotice("conflict");
        return;
      }
      value = merged.value;
      baseAt = theirs.at;
      if (!o.same(value, mine)) {
        o.surface.apply(value);
      }
      setNotice("merged");
    }
    try {
      const at = await o.send(value, baseAt);
      base.current = { value, at };
    } catch (err) {
      if (err instanceof LiveConflict && again > 0) {
        held.current = err.theirs;
        return save(value, again - 1);
      }
      throw err;
    }
  }, []);

  /** The clash: the person's text stays and goes over the other version. */
  const keepMine = useCallback(() => {
    const theirs = clash.current;
    clash.current = null;
    setNotice(null);
    if (theirs) {
      base.current = { value: base.current.value, at: theirs.at };
    }
    opts.current.surface.saveNow();
  }, []);

  /** The clash: the other version replaces what was typed here. */
  const takeTheirs = useCallback(() => {
    const theirs = clash.current;
    clash.current = null;
    setNotice(null);
    if (theirs) {
      take(theirs);
    }
  }, [take]);

  return { save: (mine: T) => save(mine), notice, keepMine, takeTheirs };
}
