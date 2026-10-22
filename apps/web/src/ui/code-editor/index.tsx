import { lazy, Suspense } from "react";
import { cn } from "../index";
import type { CodeEditorProps } from "./CodeEditor";

export type { CodeEditorHandle, CodeEditorProps, LineMark, LinkTarget } from "./CodeEditor";

/**
 * CodeMirror is its own chunk, and each language another: loaded when an editor opens, not with
 * the studio. The view's JSON doesn't load Markdown, a page doesn't load JSON.
 */
const Markdown = lazy(async () => {
  const [{ default: Editor }, { markdownParts }] = await Promise.all([
    import("./CodeEditor"),
    import("./markdown"),
  ]);
  const parts = markdownParts();
  return { default: (p: CodeEditorProps) => <Editor {...p} languageParts={parts} /> };
});
const Json = lazy(async () => {
  const [{ default: Editor }, { jsonParts }] = await Promise.all([
    import("./CodeEditor"),
    import("./json"),
  ]);
  const parts = jsonParts();
  return { default: (p: CodeEditorProps) => <Editor {...p} languageParts={parts} /> };
});

/**
 * The studio's editor for Markdown and JSON (docs/plans/page-editor-codemirror.md). While its
 * chunk loads, a plain textarea with the same text stands in, so nothing is hidden meanwhile.
 */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense
      fallback={
        <textarea
          value={props.value}
          readOnly={props.readOnly}
          onChange={(e) => props.onChange(e.target.value)}
          aria-label={props.ariaLabel}
          placeholder={props.placeholder}
          className={cn(
            "field-sizing-content block w-full resize-none bg-transparent px-4 py-4 outline-none",
            props.language === "json"
              ? "font-mono text-[0.75rem]"
              : "text-[0.9375rem] leading-[1.65]",
            props.className,
          )}
        />
      }
    >
      {props.language === "json" ? <Json {...props} /> : <Markdown {...props} />}
    </Suspense>
  );
}

/** For what applies changes from elsewhere without React (studio/live): loaded on use. */
export const loadApplyText = () => import("./CodeEditor").then((m) => m.applyText);
