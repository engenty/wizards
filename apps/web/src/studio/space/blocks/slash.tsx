// The `/` menu: type a slash, pick a block. From peer-it's docs app
// (packages/docs-ui/src/blocks/slash.tsx), which has it from engenty-pro's tiptap-editor.

import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { type Editor, Extension, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import type { ReactNode, Ref } from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";

export interface SlashItem {
  /** When two items share a title: two pages of the same name. */
  key?: string;
  title: string;
  hint: string;
  icon: ReactNode;
  keywords?: string[];
  run: (editor: Editor) => void;
}

export const SlashCommands = Extension.create<{
  items: () => SlashItem[];
  /** Items for what was typed after the slash, after the matching blocks: pages, tables, files. */
  more: (query: string) => SlashItem[];
}>({
  name: "slashCommands",
  addOptions: () => ({ items: () => [], more: () => [] }),
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: "/",
        pluginKey: new PluginKey("slashCommands"),
        // Not inside code or a markdown block, where a slash is just a slash.
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          editor.chain().focus().deleteRange(range).run();
          props.run(editor);
        },
        items: ({ query }) => {
          const q = query.toLowerCase();
          return [
            ...this.options
              .items()
              .filter(
                (i) =>
                  !q ||
                  i.title.toLowerCase().includes(q) ||
                  i.keywords?.some((k) => k.startsWith(q)),
              ),
            ...this.options.more(query),
          ];
        },
        render: renderMenu,
      }),
    ];
  },
});

interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

function SlashMenu({
  items,
  command,
  ref,
}: {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  ref?: Ref<MenuHandle>;
}) {
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts at the top
  useEffect(() => setSelected(0), [items]);
  useEffect(() => {
    (list.current?.children[selected] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowUp") {
        setSelected((i) => (i <= 0 ? items.length - 1 : i - 1));
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelected((i) => (i >= items.length - 1 ? 0 : i + 1));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[selected];
        if (item) {
          command(item);
        }
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return null;
  }
  return (
    <div className="slash-menu" ref={list}>
      {items.map((item, i) => (
        <button
          className={`slash-item${i === selected ? " on" : ""}`}
          key={item.key ?? item.title}
          onClick={() => command(item)}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setSelected(i)}
          type="button"
        >
          <span className="slash-icon">{item.icon}</span>
          <span className="slash-text">
            <span className="slash-title">{item.title}</span>
            <span className="slash-hint">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function renderMenu() {
  let renderer: ReactRenderer<MenuHandle, Parameters<typeof SlashMenu>[0]> | null = null;
  let stop: (() => void) | undefined;
  let rect: (() => DOMRect | null) | null = null;
  const place = () => {
    const el = renderer?.element as HTMLElement | undefined;
    const r = rect?.();
    if (!el || !r) {
      return;
    }
    void computePosition({ getBoundingClientRect: () => r }, el, {
      placement: "bottom-start",
      strategy: "fixed",
      middleware: [offset(4), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) =>
      Object.assign(el.style, { position: "fixed", left: `${x}px`, top: `${y}px` }),
    );
  };
  return {
    onStart: (props: SuggestionProps<SlashItem, SlashItem>) => {
      rect = props.clientRect ?? null;
      renderer = new ReactRenderer(SlashMenu, {
        editor: props.editor,
        props: { items: props.items, command: props.command },
      });
      const el = renderer.element as HTMLElement;
      el.style.zIndex = "40";
      document.body.appendChild(el);
      stop = autoUpdate({ getBoundingClientRect: () => rect?.() ?? new DOMRect() }, el, place);
    },
    onUpdate: (props: SuggestionProps<SlashItem, SlashItem>) => {
      rect = props.clientRect ?? null;
      renderer?.updateProps({ items: props.items, command: props.command });
      place();
    },
    onKeyDown: (props: SuggestionKeyDownProps) =>
      props.event.key === "Escape" ? false : (renderer?.ref?.onKeyDown(props) ?? false),
    onExit: () => {
      stop?.();
      renderer?.element.remove();
      renderer?.destroy();
      renderer = null;
      rect = null;
    },
  };
}
