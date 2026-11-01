// The block editor for a page's Markdown: blocks (headings, lists, tables, pictures, …) that look
// like the text read, a `/` menu, a handle per block, a bubble over selected text, and uploads.
// From peer-it's docs app (packages/docs-ui/src/blocks/BlockEditor.tsx). The text stays Markdown:
// see markdown.ts for how a small edit stays a small change.
//
// Nothing here knows Wissen: what a page links to comes in as `targets`, a link's address is
// turned into one the browser loads by `resolve`, and a lone link that shows something in its
// place (a table of Wissen) is drawn by `embed`.

import { type Editor, Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold,
  Check,
  Code,
  Divide,
  ExternalLink,
  File,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  ImageUp,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Pilcrow,
  Quote,
  Strikethrough,
  Table,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../lib/i18n";
import { BlockGutter } from "./gutter";
import { type Json, markdownToNodes, type Parsed, parseMarkdown, toMarkdown } from "./markdown";
import { blockExtensions } from "./schema";
import { SlashCommands, type SlashItem } from "./slash";
import {
  matchTargets,
  type Target,
  type TargetKind,
  TargetList,
  type TargetListHandle,
  TargetPicker,
  targetIcon,
} from "./targets";
import "./blocks.css";

/** A heading someone else writes under, marked beside it. */
export interface HeadingMark {
  heading: string;
  color: string;
  title: string;
}

export interface BlockEditorProps {
  text: string;
  onChange: (text: string) => void;
  readOnly?: boolean;
  /** Pages, tables and files the page can link to and show. */
  targets: Target[];
  /** The page's own path: not offered as a link. */
  self?: string;
  /** Files dropped, pasted or picked: kept, and the Markdown that shows them returned. */
  onFiles?: (files: File[]) => Promise<string>;
  /** A picture's address in the text, as the browser loads it. */
  resolve: (src: string) => string;
  /** A link followed: clicked while reading, Cmd/Ctrl+clicked or opened from the bubble. */
  onOpen: (href: string) => void;
  /** What a link alone on its line shows in its place, if anything (a table of Wissen). */
  embed?: { test: (href: string) => boolean; render: (href: string) => ReactNode };
  /** The heading above the caret: where this tab writes. */
  onHeading?: (heading: { id: string; label: string } | null) => void;
  marks?: HeadingMark[];
  placeholder?: string;
  ariaLabel?: string;
  /** Shown at the end of the row above the text, beside the table's tools. */
  tools?: ReactNode;
}

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/** A link alone in its paragraph: its address, or null. */
function loneLink(node: PMNode): string | null {
  const only = node.type.name === "paragraph" && node.childCount === 1 ? node.firstChild : null;
  const link = only?.isText ? only.marks.find((m) => m.type.name === "link") : null;
  return link && !link.attrs.auto ? String(link.attrs.href ?? "") : null;
}

const decoKey = new PluginKey("pageDecorations");

/**
 * Decorations from outside the doc: a lone link that shows something gets a place for it below,
 * a heading someone else writes under gets their colour.
 */
function pageDecorations(
  info: () => {
    embeds: ((href: string) => boolean) | undefined;
    marks: HeadingMark[];
    hosts: EmbedHosts;
  },
) {
  return Extension.create({
    name: "pageDecorations",
    addProseMirrorPlugins: () => [
      new Plugin({
        key: decoKey,
        props: {
          decorations(state) {
            const { embeds, marks, hosts } = info();
            const found: Decoration[] = [];
            const seen = new Map<string, number>();
            state.doc.forEach((node, pos) => {
              const href = loneLink(node);
              if (href && embeds?.(href)) {
                const n = (seen.get(href) ?? 0) + 1;
                seen.set(href, n);
                found.push(
                  Decoration.node(pos, pos + node.nodeSize, { class: "block-embed-link" }),
                );
                found.push(
                  Decoration.widget(pos + node.nodeSize, () => hosts.make(href), {
                    key: `embed:${href}:${n}`,
                    side: -1,
                    ignoreSelection: true,
                    stopEvent: () => true,
                    destroy: (el) => hosts.drop(el as HTMLElement),
                  }),
                );
              }
              if (node.type.name === "heading" && marks.length) {
                const text = node.textContent.trim().toLowerCase();
                const mark = marks.find((m) => m.heading.trim().toLowerCase() === text);
                if (mark) {
                  found.push(
                    Decoration.node(pos, pos + node.nodeSize, {
                      class: "block-heading-mark",
                      style: `--mark: ${mark.color}`,
                      title: mark.title,
                    }),
                  );
                }
              }
            });
            return DecorationSet.create(state.doc, found);
          },
        },
      }),
    ],
  });
}

/** The elements embeds are drawn into (portals), as ProseMirror makes and drops them. */
interface EmbedHosts {
  make: (href: string) => HTMLElement;
  drop: (el: HTMLElement) => void;
}

/**
 * The editor's doc becomes `doc`: only the blocks between the first and the last that differ are
 * replaced, so the caret stays where it was and undo leaves a change from elsewhere alone.
 */
function replaceChanged(editor: Editor, doc: Json) {
  const next = editor.schema.nodeFromJSON(doc);
  const now = editor.state.doc;
  const start = now.content.findDiffStart(next.content);
  if (start === null || start === undefined) {
    return;
  }
  const end = now.content.findDiffEnd(next.content);
  let a = end?.a ?? now.content.size;
  let b = end?.b ?? next.content.size;
  const overlap = start - Math.min(a, b);
  if (overlap > 0) {
    a += overlap;
    b += overlap;
  }
  const tr = editor.state.tr.replace(start, a, next.slice(start, b));
  tr.setMeta("addToHistory", false).setMeta(externalKey, true);
  editor.view.dispatch(tr);
}

const externalKey = "pageFromElsewhere";

const looksLikeMarkdown = (text: string) =>
  /^(#{1,6} |[-*+] |\d+[.)] |> |```|\|.*\|\s*$)/m.test(text) ||
  /\[[^\]\n]+\]\([^)\n]+\)|\*\*[^*\n]+\*\*/.test(text);

/** The heading above `pos`, among the doc's top-level blocks. */
function headingAbove(doc: PMNode, pos: number): { id: string; label: string } | null {
  let found: string | null = null;
  doc.forEach((node, at) => {
    if (at < pos && node.type.name === "heading" && node.textContent.trim()) {
      found = node.textContent.trim();
    }
  });
  const label = found as string | null;
  return label ? { id: `h:${label.toLowerCase()}`, label } : null;
}

export function BlockEditor(props: BlockEditorProps) {
  const {
    text,
    readOnly = false,
    targets,
    self,
    resolve,
    embed,
    marks = [],
    placeholder,
    ariaLabel,
    tools,
  } = props;
  const live = useRef(props);
  live.current = props;

  // The text as it was opened (or last came from elsewhere): blocks the editor leaves alone are
  // written back from it. `keys` are its blocks as the editor held them then.
  const parsed = useRef<Parsed | null>(null);
  if (!parsed.current) {
    parsed.current = parseMarkdown(text);
  }
  const keys = useRef<string[]>([]);
  /** The text this editor last handed out or took in: anything else is a change from elsewhere. */
  const known = useRef(text);
  const json = useRef(new WeakMap<PMNode, { json: Json; key: string }>());
  const of = (node: PMNode) => {
    let entry = json.current.get(node);
    if (!entry) {
      const j = node.toJSON() as Json;
      entry = { json: j, key: JSON.stringify(j) };
      json.current.set(node, entry);
    }
    return entry;
  };
  const topLevel = (doc: PMNode) => {
    const nodes: PMNode[] = [];
    doc.forEach((n) => {
      nodes.push(n);
    });
    return nodes;
  };
  const markdownOf = (doc: PMNode) => {
    const nodes = topLevel(doc);
    return toMarkdown(
      nodes.map((n) => of(n).json),
      { parsed: parsed.current as Parsed, keys: keys.current },
      (_, i) => of(nodes[i] as PMNode).key,
    );
  };
  const takeKeys = (doc: PMNode) => {
    keys.current = topLevel(doc)
      .slice(0, parsed.current?.blocks.length ?? 0)
      .map((n) => of(n).key);
  };

  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);

  // Embeds are drawn by React into the elements ProseMirror places below their links.
  const [embedHosts, setEmbedHosts] = useState<Map<HTMLElement, string>>(() => new Map());
  const hosts = useRef<EmbedHosts>({
    make: (href) => {
      const el = document.createElement("div");
      el.className = "block-embed";
      el.contentEditable = "false";
      queueMicrotask(() => setEmbedHosts((m) => new Map(m).set(el, href)));
      return el;
    },
    drop: (el) =>
      queueMicrotask(() =>
        setEmbedHosts((m) => {
          const next = new Map(m);
          next.delete(el);
          return next;
        }),
      ),
  });

  /** Puts Markdown blocks at `at`: after its block, or in place of an empty line. */
  const insertBlocks = (md: string, at?: number) => {
    const ed = editorRef.current;
    if (!ed || !md) {
      return;
    }
    const $pos = ed.state.doc.resolve(
      Math.min(at ?? ed.state.selection.from, ed.state.doc.content.size),
    );
    const empty = $pos.parent.type.name === "paragraph" && $pos.parent.content.size === 0;
    const where =
      $pos.depth === 0
        ? $pos.pos
        : empty
          ? { from: $pos.before(), to: $pos.after() }
          : $pos.after(1);
    ed.chain().focus().insertContentAt(where, markdownToNodes(md)).run();
  };

  const upload = async (files: File[], at?: number) => {
    const onFiles = live.current.onFiles;
    if (files.length === 0 || !onFiles) {
      return;
    }
    insertBlocks(await onFiles(files), at);
  };

  /** A target: a picture shows, a table and a file stand on their own line, a page is a link. */
  const insertTarget = (target: Target) => {
    const ed = editorRef.current;
    if (!ed) {
      return;
    }
    const words = target.title.replace(/[[\]]/g, "\\$&");
    if (target.kind !== "page") {
      insertBlocks(`${target.kind === "image" ? "!" : ""}[${words}](${target.path})`);
      return;
    }
    ed.chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: target.title,
          marks: [{ type: "link", attrs: { href: target.path } }],
        },
        { type: "text", text: " " },
      ])
      .run();
  };

  const [picking, setPicking] = useState<{ kinds: TargetKind[]; placeholder: string } | null>(null);
  const pick = (
    title: string,
    hint: string,
    icon: ReactNode,
    kinds: TargetKind[],
    keywords: string[],
  ): SlashItem => ({
    title,
    hint,
    icon,
    keywords,
    run: () => setPicking({ kinds, placeholder: t("blocks.pickSearch", { what: title }) }),
  });
  const icon = (I: typeof Bold) => <I className="size-3.5" />;

  const slash = useRef<SlashItem[]>([]);
  slash.current = [
    {
      title: t("blocks.text"),
      hint: t("blocks.textHint"),
      icon: icon(Pilcrow),
      keywords: ["paragraph", "text"],
      run: (e) => e.chain().focus().setParagraph().run(),
    },
    {
      title: t("blocks.h1"),
      hint: t("blocks.h1Hint"),
      icon: icon(Heading1),
      keywords: ["h1", "title", "heading"],
      run: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
    },
    {
      title: t("blocks.h2"),
      hint: t("blocks.h2Hint"),
      icon: icon(Heading2),
      keywords: ["h2", "heading"],
      run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
    },
    {
      title: t("blocks.h3"),
      hint: t("blocks.h3Hint"),
      icon: icon(Heading3),
      keywords: ["h3", "heading"],
      run: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
    },
    {
      title: t("blocks.bullets"),
      hint: "- …",
      icon: icon(List),
      keywords: ["ul", "list"],
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      title: t("blocks.numbered"),
      hint: "1. …",
      icon: icon(ListOrdered),
      keywords: ["ol", "ordered", "list"],
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      title: t("blocks.tasks"),
      hint: "- [ ] …",
      icon: icon(ListChecks),
      keywords: ["todo", "task", "check"],
      run: (e) => e.chain().focus().toggleTaskList().run(),
    },
    {
      title: t("blocks.quote"),
      hint: "> …",
      icon: icon(Quote),
      keywords: ["blockquote", "quote"],
      run: (e) => e.chain().focus().setBlockquote().run(),
    },
    {
      title: t("blocks.code"),
      hint: t("blocks.codeHint"),
      icon: icon(Code),
      keywords: ["pre", "fence", "code"],
      run: (e) => e.chain().focus().setCodeBlock().run(),
    },
    {
      title: t("blocks.table"),
      hint: t("blocks.tableHint"),
      icon: icon(Table),
      keywords: ["grid", "table"],
      run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      title: t("blocks.divider"),
      hint: "---",
      icon: icon(Divide),
      keywords: ["hr", "rule", "line"],
      run: (e) => e.chain().focus().setHorizontalRule().run(),
    },
    pick(
      t("blocks.linkPage"),
      t("blocks.linkPageHint"),
      icon(FileText),
      ["page"],
      ["page", "link"],
    ),
    pick(
      t("blocks.tableFrom"),
      t("blocks.tableFromHint"),
      icon(Table),
      ["table"],
      ["table", "data"],
    ),
    pick(
      t("blocks.fileFrom"),
      t("blocks.fileFromHint"),
      icon(File),
      ["file", "image"],
      ["file", "pdf", "image"],
    ),
    ...(props.onFiles
      ? [
          {
            title: t("blocks.uploadImage"),
            hint: t("blocks.uploadImageHint"),
            icon: icon(ImageUp),
            keywords: ["image", "upload"],
            run: () => imageInput.current?.click(),
          },
          {
            title: t("blocks.uploadFile"),
            hint: t("blocks.uploadFileHint"),
            icon: icon(Upload),
            keywords: ["upload", "pdf", "file"],
            run: () => fileInput.current?.click(),
          },
        ]
      : []),
  ];

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      ...blockExtensions({ resolve: (src) => live.current.resolve(src) }),
      Placeholder.configure({ placeholder: placeholder ?? t("blocks.placeholder") }),
      SlashCommands.configure({
        items: () => slash.current,
        // Typing a page's name after the slash offers the page itself.
        more: (query) =>
          query.trim().length < 2
            ? []
            : matchTargets(live.current.targets, query, { self: live.current.self, limit: 6 }).map(
                (target) => {
                  const I = targetIcon(target.kind);
                  return {
                    key: target.path,
                    title: target.title,
                    hint: target.path,
                    icon: <I className="size-3.5" />,
                    run: () => insertTarget(target),
                  };
                },
              ),
      }),
      pageDecorations(() => ({
        embeds: live.current.embed?.test,
        marks: live.current.marks ?? [],
        hosts: hosts.current,
      })),
    ],
    content: parsed.current.doc,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: "prose-zen block-doc",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
      handleClick(view, _pos, event) {
        const a = (event.target as HTMLElement).closest("a");
        const href = a?.getAttribute("href");
        if (!href || (view.editable && !(event.metaKey || event.ctrlKey))) {
          return false;
        }
        event.preventDefault();
        follow(href);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (moved || files.length === 0 || !live.current.onFiles) {
          return false;
        }
        event.preventDefault();
        void upload(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
      handlePaste(view, event) {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length && live.current.onFiles) {
          void upload(files);
          return true;
        }
        const plain = event.clipboardData?.getData("text/plain") ?? "";
        const inCode = view.state.selection.$from.parent.type.spec.code;
        if (!inCode && !event.clipboardData?.getData("text/html") && looksLikeMarkdown(plain)) {
          editorRef.current?.chain().focus().insertContent(markdownToNodes(plain)).run();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: e }) => takeKeys(e.state.doc),
    onUpdate: ({ editor: e, transaction }: { editor: Editor; transaction: Transaction }) => {
      if (transaction.getMeta(externalKey)) {
        return;
      }
      const next = markdownOf(e.state.doc);
      known.current = next;
      live.current.onChange(next);
    },
    onSelectionUpdate: ({ editor: e }) =>
      live.current.onHeading?.(headingAbove(e.state.doc, e.state.selection.from)),
  });
  editorRef.current = editor;

  const follow = (href: string) => {
    if (isExternal(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
    } else {
      live.current.onOpen(href);
    }
  };

  // A change from elsewhere: the blocks it touched are replaced, the rest stay as they are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the only input
  useEffect(() => {
    if (!editor || editor.isDestroyed || text === known.current) {
      return;
    }
    known.current = text;
    parsed.current = parseMarkdown(text);
    replaceChanged(editor, parsed.current.doc);
    takeKeys(editor.state.doc);
  }, [text, editor]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Marks and embeds come from outside the doc: drawn again when they change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the marks' text stands for them
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(decoKey, true));
    }
  }, [editor, JSON.stringify(marks), Boolean(embed)]);

  // The view exists once EditorContent has mounted it; the handle and the bubble need it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!editor) {
      return;
    }
    const on = () => setMounted(true);
    const off = () => setMounted(false);
    try {
      if (editor.view.dom.isConnected) {
        on();
      }
    } catch {
      // Not mounted yet: the event comes.
    }
    editor.on("mount", on);
    editor.on("unmount", off);
    return () => {
      editor.off("mount", on);
      editor.off("unmount", off);
    };
  }, [editor]);

  // A picture added a moment ago resolves once its file is known: shown from there.
  useEffect(() => {
    if (!editor || !mounted || editor.isDestroyed) {
      return;
    }
    for (const img of editor.view.dom.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      const src = resolve(img.dataset.src ?? "");
      if (img.getAttribute("src") !== src) {
        img.src = src;
      }
    }
  }, [editor, mounted, resolve]);

  if (!editor) {
    return null;
  }

  const c = () => editor.chain().focus();
  const tool = (title: string, run: () => void, label: ReactNode) => (
    <button
      className="block-tool"
      key={title}
      onClick={run}
      onMouseDown={(e) => e.preventDefault()}
      title={title}
      type="button"
    >
      {label}
    </button>
  );
  const tableTools =
    !readOnly && editor.isActive("table") ? (
      <span className="flex items-center gap-0.5">
        {tool(t("blocks.rowBelow"), () => c().addRowAfter().run(), t("blocks.row"))}
        {tool(t("blocks.columnRight"), () => c().addColumnAfter().run(), t("blocks.column"))}
        {tool(t("blocks.deleteRow"), () => c().deleteRow().run(), `− ${t("blocks.rowWord")}`)}
        {tool(
          t("blocks.deleteColumn"),
          () => c().deleteColumn().run(),
          `− ${t("blocks.columnWord")}`,
        )}
        {tool(t("blocks.deleteTable"), () => c().deleteTable().run(), <X className="size-3.5" />)}
      </span>
    ) : null;

  return (
    <div className={`block-editor${readOnly ? " read-only" : ""}`}>
      {tableTools || tools ? (
        <div className="block-tools">
          {tableTools}
          {tools}
        </div>
      ) : null}
      <div className="block-page">
        <EditorContent editor={editor} />
        {[...embedHosts].map(([el, href]) => createPortal(embed?.render(href) ?? null, el))}
        {mounted && !readOnly ? (
          <>
            <BlockGutter editor={editor} />
            <LinkBubble editor={editor} onOpen={follow} self={self} targets={targets} />
            {picking ? (
              <TargetPicker
                editor={editor}
                kinds={picking.kinds}
                onClose={() => {
                  setPicking(null);
                  editor.commands.focus();
                }}
                onPick={(target) => {
                  setPicking(null);
                  insertTarget(target);
                }}
                placeholder={picking.placeholder}
                self={self}
                targets={targets}
              />
            ) : null}
          </>
        ) : null}
      </div>
      <input
        accept="image/*"
        hidden
        multiple
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void upload(files);
        }}
        ref={imageInput}
        type="file"
      />
      <input
        hidden
        multiple
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void upload(files);
        }}
        ref={fileInput}
        type="file"
      />
    </div>
  );
}

const bubbleOptions = { placement: "top", offset: 8 } as const;

/** Over selected text: bold, italic, strike, code, link. In a link: its address. */
function LinkBubble({
  editor,
  targets,
  self,
  onOpen,
}: {
  editor: Editor;
  targets: Target[];
  self?: string;
  onOpen: (href: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [href, setHref] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const current = String(editor.getAttributes("link").href ?? "");

  useEffect(() => {
    const onSel = () => setEditing(false);
    editor.on("selectionUpdate", onSel);
    return () => {
      editor.off("selectionUpdate", onSel);
    };
  }, [editor]);

  // Stays the same function: the menu dispatches a transaction when it changes.
  const shouldShow = useCallback(
    ({ editor: e, state }: { editor: Editor; state: Editor["state"] }) => {
      const { selection } = state;
      if (!e.isEditable || selection.$from.parent.type.spec.code || "node" in selection) {
        return false;
      }
      return editingRef.current || !selection.empty || e.isActive("link");
    },
    [],
  );

  const list = useRef<TargetListHandle>(null);
  const matches =
    editing && !isExternal(href) && !href.startsWith("#")
      ? matchTargets(targets, href, { self, limit: 8 })
      : [];

  const apply = (value = href) => {
    const chain = editor.chain().focus().extendMarkRange("link");
    if (value.trim()) {
      chain.setLink({ href: value.trim() }).run();
    } else {
      chain.unsetLink().run();
    }
    setEditing(false);
  };
  const btn = (title: string, label: ReactNode, run: () => void, on = false) => (
    <button
      className={`block-tool${on ? " on" : ""}`}
      onClick={run}
      onMouseDown={(e) => e.preventDefault()}
      title={title}
      aria-label={title}
      aria-pressed={on}
      type="button"
    >
      {label}
    </button>
  );
  const ic = "size-3.5";

  return (
    <BubbleMenu
      className="block-bubble"
      editor={editor}
      options={bubbleOptions}
      shouldShow={shouldShow}
    >
      {editing ? (
        <div className="grid gap-1">
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
          >
            <input
              className="block-bubble-input"
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(false);
                  editor.commands.focus();
                } else if (list.current?.onKey(e.key)) {
                  e.preventDefault();
                }
              }}
              placeholder={t("blocks.linkSearch")}
              ref={input}
              value={href}
            />
            {btn(t("blocks.apply"), <Check className={ic} />, () => apply())}
          </form>
          <TargetList onPick={(target) => apply(target.path)} ref={list} targets={matches} />
        </div>
      ) : (
        <>
          {editor.state.selection.empty ? null : (
            <>
              {btn(
                t("blocks.bold"),
                <Bold className={ic} />,
                () => editor.chain().focus().toggleBold().run(),
                editor.isActive("bold"),
              )}
              {btn(
                t("blocks.italic"),
                <Italic className={ic} />,
                () => editor.chain().focus().toggleItalic().run(),
                editor.isActive("italic"),
              )}
              {btn(
                t("blocks.strike"),
                <Strikethrough className={ic} />,
                () => editor.chain().focus().toggleStrike().run(),
                editor.isActive("strike"),
              )}
              {btn(
                t("blocks.inlineCode"),
                <Code className={ic} />,
                () => editor.chain().focus().toggleCode().run(),
                editor.isActive("code"),
              )}
            </>
          )}
          {btn(
            t("blocks.link"),
            <Link className={ic} />,
            () => {
              setHref(current);
              setEditing(true);
              setTimeout(() => input.current?.focus());
            },
            editor.isActive("link"),
          )}
          {current ? (
            <>
              <span className="block-bubble-href" title={current}>
                {current}
              </span>
              {btn(t("blocks.openLink"), <ExternalLink className={ic} />, () => onOpen(current))}
              {btn(t("blocks.removeLink"), <X className={ic} />, () =>
                editor.chain().focus().extendMarkRange("link").unsetLink().run(),
              )}
            </>
          ) : null}
        </>
      )}
    </BubbleMenu>
  );
}
