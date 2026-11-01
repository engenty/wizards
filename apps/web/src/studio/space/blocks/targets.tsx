// What a page can link to or show: suggestions for the link field, the `/` menu's „aus Wissen“
// items, and the picker they open. From peer-it's docs app (packages/docs-ui/src/blocks/files.tsx);
// a target is anything with a path, so Dateien can hand its own files in.

import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import { File, FileText, Image, type LucideIcon, Table } from "lucide-react";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";

export type TargetKind = "page" | "table" | "image" | "file";

export interface Target {
  /** What the text links to: `pages/handbuch/montage`, `tables/preise`, `files/plan.pdf`. */
  path: string;
  title: string;
  kind: TargetKind;
}

const ICON: Record<TargetKind, LucideIcon> = {
  page: FileText,
  table: Table,
  image: Image,
  file: File,
};
export const targetIcon = (kind: TargetKind) => ICON[kind];

/** Targets whose title or path has every word of `query`: titles that start with it first. */
export function matchTargets(
  targets: Target[],
  query: string,
  opts: { self?: string; kinds?: TargetKind[]; limit?: number },
): Target[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { target: Target; score: number }[] = [];
  for (const target of targets) {
    if (target.path === opts.self || (opts.kinds && !opts.kinds.includes(target.kind))) {
      continue;
    }
    const title = target.title.toLowerCase();
    const all = `${title} ${target.path.toLowerCase()}`;
    if (!words.every((w) => all.includes(w))) {
      continue;
    }
    const last = words[words.length - 1];
    const score = !last ? 0 : title.startsWith(last) ? 0 : title.includes(last) ? 1 : 2;
    scored.push({ target, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.target.title.length - b.target.title.length ||
      a.target.title.localeCompare(b.target.title),
  );
  return scored.slice(0, opts.limit ?? 8).map((s) => s.target);
}

export interface TargetListHandle {
  /** Arrows move, Enter or Tab picks; true when the key was used. */
  onKey: (key: string) => boolean;
}

export function TargetList({
  targets,
  onPick,
  ref,
}: {
  targets: Target[];
  onPick: (target: Target) => void;
  ref?: Ref<TargetListHandle>;
}) {
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts at the top
  useEffect(() => setSelected(0), [targets.map((x) => x.path).join("\n")]);
  useEffect(() => {
    (list.current?.children[selected] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKey: (key) => {
      if (targets.length === 0) {
        return false;
      }
      if (key === "ArrowUp") {
        setSelected((i) => (i <= 0 ? targets.length - 1 : i - 1));
        return true;
      }
      if (key === "ArrowDown") {
        setSelected((i) => (i >= targets.length - 1 ? 0 : i + 1));
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        const target = targets[selected];
        if (target) {
          onPick(target);
        }
        return true;
      }
      return false;
    },
  }));

  if (targets.length === 0) {
    return null;
  }
  return (
    <div className="target-list" ref={list}>
      {targets.map((target, i) => {
        const Icon = targetIcon(target.kind);
        return (
          <button
            className={`target-opt${i === selected ? " on" : ""}`}
            key={target.path}
            onClick={() => onPick(target)}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setSelected(i)}
            type="button"
          >
            <Icon className="size-3.5 shrink-0 text-ink-3" />
            <span className="target-opt-name">{target.title}</span>
            <span className="target-opt-path">{target.path}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A search over the targets at the caret, for the `/` menu's „aus Wissen“ items. */
export function TargetPicker({
  editor,
  targets,
  self,
  kinds,
  placeholder,
  onPick,
  onClose,
}: {
  editor: Editor;
  targets: Target[];
  self?: string;
  kinds?: TargetKind[];
  placeholder: string;
  onPick: (target: Target) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<TargetListHandle>(null);
  const matches = matchTargets(targets, query, { self, kinds, limit: 12 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const at = editor.view.coordsAtPos(editor.state.selection.from);
    const rect = new DOMRect(at.left, at.top, 1, at.bottom - at.top);
    void computePosition({ getBoundingClientRect: () => rect }, el, {
      placement: "bottom-start",
      strategy: "fixed",
      middleware: [offset(4), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => Object.assign(el.style, { left: `${x}px`, top: `${y}px` }));
  }, [editor]);

  return (
    <div
      aria-label={placeholder}
      className="target-picker"
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null)) {
          onClose();
        }
      }}
      ref={box}
      role="dialog"
    >
      <input
        autoFocus
        className="target-picker-input"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (list.current?.onKey(e.key)) {
            e.preventDefault();
          }
        }}
        placeholder={placeholder}
        value={query}
      />
      <TargetList onPick={onPick} ref={list} targets={matches} />
      {matches.length === 0 ? (
        <p className="target-picker-none">{t("blocks.nothingFound")}</p>
      ) : null}
    </div>
  );
}
