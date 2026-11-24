// SPDX-License-Identifier: MIT
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import { cn } from "./ui.js";

/** Markdown a model or an author wrote, as HTML that DOMPurify cleaned. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text],
  );
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: model output, sanitised by DOMPurify above
    <div className={cn("prose-zen", className)} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
