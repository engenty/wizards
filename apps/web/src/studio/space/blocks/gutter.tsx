// The handle beside each block: + adds a paragraph below, ⋮⋮ drags the block or opens its menu
// (turn into, duplicate, delete). From peer-it's docs app (packages/docs-ui/src/blocks/gutter.tsx),
// which has it from engenty-pro's tiptap-editor; a block is a top-level node (a whole list or
// table), and "turn into" goes through the editor's commands so lists convert too.

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { Copy, Plus, Trash2 } from "lucide-react";
import type { DragEvent as ReactDragEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";

interface BlockRange {
  from: number;
  to: number;
  node: PMNode;
}

/** The top-level block at `pos`. */
function blockAt(doc: PMNode, pos: number): BlockRange | null {
  if (doc.content.size <= 0) {
    return null;
  }
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.depth === 0) {
    const node = $pos.nodeAfter ?? $pos.nodeBefore;
    if (!node) {
      return null;
    }
    const from = $pos.nodeAfter ? $pos.pos : $pos.pos - node.nodeSize;
    return { from, to: from + node.nodeSize, node };
  }
  return { from: $pos.before(1), to: $pos.after(1), node: $pos.node(1) };
}

const DRAG_MIME = "application/x-wizards-block";

const same = (a: BlockRange | null, b: BlockRange | null) =>
  a === b || (a !== null && b !== null && a.from === b.from && a.node === b.node);

/** The editor's element, or null while the view is not mounted (React remounts it in dev). */
const domOf = (editor: Editor) => {
  try {
    return editor.view.dom;
  } catch {
    return null;
  }
};

const TURN_INTO = [
  { id: "paragraph", label: "blocks.text", glyph: "¶" },
  { id: "h1", label: "blocks.h1", glyph: "H1" },
  { id: "h2", label: "blocks.h2", glyph: "H2" },
  { id: "h3", label: "blocks.h3", glyph: "H3" },
  { id: "bulletList", label: "blocks.bullets", glyph: "•" },
  { id: "orderedList", label: "blocks.numbered", glyph: "1." },
  { id: "taskList", label: "blocks.tasks", glyph: "☑" },
  { id: "blockquote", label: "blocks.quote", glyph: "❝" },
  { id: "codeBlock", label: "blocks.code", glyph: "<>" },
] as const;

type TurnInto = (typeof TURN_INTO)[number]["id"];

/** Blocks whose text can become another kind of block. */
const TEXT_BLOCKS = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
]);

function turnInto(editor: Editor, block: BlockRange, id: TurnInto) {
  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setSelection(TextSelection.between(tr.doc.resolve(block.from), tr.doc.resolve(block.to)));
      return true;
    })
    .clearNodes();
  switch (id) {
    case "paragraph":
      return chain.run();
    case "h1":
    case "h2":
    case "h3":
      return chain.setHeading({ level: Number(id[1]) as 1 | 2 | 3 }).run();
    case "bulletList":
      return chain.toggleBulletList().run();
    case "orderedList":
      return chain.toggleOrderedList().run();
    case "taskList":
      return chain.toggleTaskList().run();
    case "blockquote":
      return chain.setBlockquote().run();
    case "codeBlock":
      return chain.setCodeBlock().run();
  }
}

function moveBlock(editor: Editor, from: number, to: number, insertPos: number) {
  const { state, dispatch } = editor.view;
  if (insertPos >= from && insertPos <= to) {
    return;
  }
  const slice = state.doc.slice(from, to);
  const tr = state.tr.delete(from, to);
  tr.insert(tr.mapping.map(insertPos), slice.content);
  dispatch(tr);
}

export function BlockGutter({ editor }: { editor: Editor }) {
  const wrap = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const gripDown = useRef<{ x: number; y: number } | null>(null);
  /** Hover tracking pauses while text is being selected. */
  const selecting = useRef(false);
  /** Set between dragstart and dragend (Safari hides custom types during dragover). */
  const dragging = useRef(false);
  const dropAt = useRef<number | null>(null);
  const [hovered, setHoveredRaw] = useState<BlockRange | null>(null);
  const [atCursor, setAtCursorRaw] = useState<BlockRange | null>(null);
  const setHovered = useCallback(
    (b: BlockRange | null) => setHoveredRaw((prev) => (same(prev, b) ? prev : b)),
    [],
  );
  const setAtCursor = useCallback(
    (b: BlockRange | null) => setAtCursorRaw((prev) => (same(prev, b) ? prev : b)),
    [],
  );
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const [top, setTop] = useState(0);
  const [indicator, setIndicator] = useState<number | null>(null);

  const active = hovered ?? atCursor;

  const syncCursor = useCallback(
    () => setAtCursor(blockAt(editor.state.doc, editor.state.selection.from)),
    [editor, setAtCursor],
  );

  useEffect(() => {
    syncCursor();
    editor.on("selectionUpdate", syncCursor);
    editor.on("transaction", syncCursor);
    return () => {
      editor.off("selectionUpdate", syncCursor);
      editor.off("transaction", syncCursor);
    };
  }, [editor, syncCursor]);

  useEffect(() => {
    const dom = domOf(editor);
    if (!dom) {
      return;
    }
    /** The strip left of the text that still counts as the block: where the handle sits. */
    const PAD = 64;
    const onDown = (e: MouseEvent) => {
      if (e.button === 0) {
        selecting.current = true;
      }
    };
    const onUp = () => {
      selecting.current = false;
    };
    const onMove = (e: MouseEvent) => {
      if (menu || selecting.current) {
        return;
      }
      const r = dom.getBoundingClientRect();
      if (
        e.clientX < r.left - PAD ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      ) {
        setHovered(null);
        return;
      }
      const at = editor.view.posAtCoords({ left: Math.max(e.clientX, r.left + 8), top: e.clientY });
      setHovered(at ? blockAt(editor.state.doc, at.inside >= 0 ? at.inside : at.pos) : null);
    };
    dom.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      dom.removeEventListener("mousedown", onDown);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [editor, menu, setHovered]);

  useEffect(() => {
    const dom = domOf(editor);
    if (!dom) {
      return;
    }
    const snap = (x: number, y: number) => {
      const at = editor.view.posAtCoords({ left: x, top: y });
      const block = at ? blockAt(editor.state.doc, at.inside >= 0 ? at.inside : at.pos) : null;
      if (!block) {
        return null;
      }
      const el = editor.view.nodeDOM(block.from) as HTMLElement | null;
      const rect = el?.getBoundingClientRect();
      if (!rect) {
        return null;
      }
      const above = y < (rect.top + rect.bottom) / 2;
      return { pos: above ? block.from : block.to, y: above ? rect.top : rect.bottom };
    };
    const onOver = (e: DragEvent) => {
      if (!dragging.current) {
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "move";
      }
      const s = snap(e.clientX, e.clientY);
      dropAt.current = s?.pos ?? null;
      const box = wrap.current?.parentElement?.getBoundingClientRect();
      setIndicator(s && box ? s.y - box.top : null);
    };
    const onDrop = (e: DragEvent) => {
      if (!dragging.current) {
        return;
      }
      e.preventDefault();
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      const target = dropAt.current ?? snap(e.clientX, e.clientY)?.pos ?? null;
      dragging.current = false;
      dropAt.current = null;
      setIndicator(null);
      if (raw && target !== null) {
        const { from, to } = JSON.parse(raw) as { from: number; to: number };
        moveBlock(editor, from, to, target);
      }
    };
    dom.addEventListener("dragenter", onOver);
    dom.addEventListener("dragover", onOver);
    dom.addEventListener("drop", onDrop);
    return () => {
      dom.removeEventListener("dragenter", onOver);
      dom.removeEventListener("dragover", onOver);
      dom.removeEventListener("drop", onDrop);
    };
  }, [editor]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !wrap.current?.contains(t)) {
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menu]);

  // The block moves with every change of the doc.
  useEffect(() => {
    const box = wrap.current?.parentElement;
    if (!active || !box || !domOf(editor)) {
      return;
    }
    // Centred on the block's first line, so it lines up with headings and paragraphs alike.
    const first = editor.view.coordsAtPos(Math.min(active.from + 1, active.to));
    const el = editor.view.nodeDOM(active.from) as HTMLElement | null;
    const lineTop = active.node.isTextblock
      ? first.top
      : (el?.getBoundingClientRect().top ?? first.top);
    const lineBottom = active.node.isTextblock ? first.bottom : lineTop + 24;
    setTop((lineTop + lineBottom) / 2 - box.getBoundingClientRect().top - 12);
  }, [active, editor, editor.state]);

  const onDragStart = (e: ReactDragEvent<HTMLButtonElement>) => {
    if (!active) {
      return;
    }
    dragging.current = true;
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ from: active.from, to: active.to }));
    e.dataTransfer.effectAllowed = "move";
    // A small label to the right of the pointer rather than the whole block.
    const preview = document.createElement("div");
    preview.className = "block-drag-preview";
    preview.textContent = active.node.textContent.trim().slice(0, 60) || active.node.type.name;
    document.body.appendChild(preview);
    e.dataTransfer.setDragImage(preview, 0, preview.getBoundingClientRect().height / 2);
    requestAnimationFrame(() => preview.remove());
  };

  const block = active;
  const canTurn = block ? TEXT_BLOCKS.has(block.node.type.name) : false;
  const done = () => setMenu(null);

  return (
    <>
      <div className={`block-gutter${active ? " on" : ""}`} ref={wrap} style={{ top }}>
        <button
          className="block-gutter-btn"
          onClick={() => {
            if (active) {
              editor
                .chain()
                .insertContentAt(active.to, { type: "paragraph" })
                .setTextSelection(active.to + 1)
                .focus()
                .run();
            }
          }}
          onMouseDown={(e) => e.preventDefault()}
          title={t("blocks.addBelow")}
          aria-label={t("blocks.addBelow")}
          type="button"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          className="block-gutter-btn grip"
          draggable
          onClick={(e) => {
            const p = gripDown.current;
            if (p && (Math.abs(e.clientX - p.x) > 6 || Math.abs(e.clientY - p.y) > 6)) {
              return;
            }
            const r = wrap.current?.getBoundingClientRect();
            if (r && active) {
              setAtCursor(active);
              setMenu({ left: r.left, top: r.bottom + 4 });
            }
          }}
          onDragEnd={() => {
            dragging.current = false;
            dropAt.current = null;
            setIndicator(null);
          }}
          onDragStart={onDragStart}
          onPointerDown={(e) => {
            gripDown.current = { x: e.clientX, y: e.clientY };
          }}
          title={t("blocks.grip")}
          aria-label={t("blocks.grip")}
          type="button"
        >
          <svg aria-hidden="true" height="14" viewBox="0 0 10 14" width="10">
            <circle cx="2.5" cy="2.5" fill="currentColor" r="1.25" />
            <circle cx="7.5" cy="2.5" fill="currentColor" r="1.25" />
            <circle cx="2.5" cy="7" fill="currentColor" r="1.25" />
            <circle cx="7.5" cy="7" fill="currentColor" r="1.25" />
            <circle cx="2.5" cy="11.5" fill="currentColor" r="1.25" />
            <circle cx="7.5" cy="11.5" fill="currentColor" r="1.25" />
          </svg>
        </button>
      </div>
      {indicator === null ? null : <div className="block-drop-line" style={{ top: indicator }} />}
      {menu && block ? (
        <div className="block-menu" ref={menuRef} style={{ left: menu.left, top: menu.top }}>
          {canTurn ? (
            <>
              <div className="block-menu-label">{t("blocks.turnInto")}</div>
              {TURN_INTO.map((item) => (
                <button
                  className="block-menu-item"
                  key={item.id}
                  onClick={() => {
                    turnInto(editor, block, item.id);
                    done();
                  }}
                  type="button"
                >
                  <span className="block-menu-glyph">{item.glyph}</span>
                  {t(item.label)}
                </button>
              ))}
              <div className="block-menu-sep" />
            </>
          ) : null}
          <button
            className="block-menu-item"
            onClick={() => {
              editor.view.dispatch(
                editor.state.tr.insert(
                  block.to,
                  editor.state.doc.slice(block.from, block.to).content,
                ),
              );
              done();
            }}
            type="button"
          >
            <span className="block-menu-glyph">
              <Copy className="size-3.5" />
            </span>
            {t("blocks.duplicate")}
          </button>
          <button
            className="block-menu-item danger"
            onClick={() => {
              editor.chain().focus().deleteRange({ from: block.from, to: block.to }).run();
              done();
            }}
            type="button"
          >
            <span className="block-menu-glyph">
              <Trash2 className="size-3.5" />
            </span>
            {t("blocks.delete")}
          </button>
        </div>
      ) : null}
    </>
  );
}
