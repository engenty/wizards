"use client";

import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";

/**
 * Renders Mermaid diagrams from fenced ```mermaid blocks (via remarkMdxMermaid).
 * @see https://www.fumadocs.dev/docs/markdown/mermaid
 */
export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return <MermaidBody chart={chart} />;
}

/**
 * A colour of the page as hex. Mermaid derives its shades from the colours it is given and reads
 * no oklch, so the page's own (app/global.css) go through a canvas pixel first.
 */
function pageColor(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return "#888888";
  }
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** The diagram in the page's colours, light or dark. */
function pageTheme() {
  const card = pageColor("--card");
  const ink = pageColor("--ink");
  const line = pageColor("--border");
  const tint = pageColor("--paper-2");
  return {
    background: pageColor("--paper"),
    primaryColor: card,
    primaryTextColor: ink,
    primaryBorderColor: line,
    secondaryColor: tint,
    secondaryTextColor: ink,
    secondaryBorderColor: line,
    tertiaryColor: tint,
    tertiaryTextColor: ink,
    tertiaryBorderColor: line,
    lineColor: pageColor("--ink-3"),
    textColor: ink,
    edgeLabelBackground: pageColor("--paper"),
  };
}

function MermaidBody({ chart }: { chart: string }) {
  const reactId = useId();
  const domId = `mermaid-${reactId.replaceAll(":", "")}`;
  const { resolvedTheme } = useTheme();
  const [rendered, setRendered] = useState<{
    bindFunctions?: (element: Element) => void;
    svg: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          fontFamily: "inherit",
          themeCSS: "margin: 1.5rem auto 0;",
          // dagre and the classic look: flat strokes in the page's colours, the docs' diagrams
          // laid out as they were written for (Mermaid's defaults are ELK and the gradient "neo").
          layout: "dagre",
          look: "classic",
          // "base" is the one theme that takes colours; they are read anew when the theme changes.
          theme: "base",
          themeVariables: { ...pageTheme(), darkMode: resolvedTheme === "dark" },
        });
        const normalized = chart.replaceAll("\\n", "\n");
        const { bindFunctions, svg: out } = await mermaid.render(domId, normalized);
        if (!cancelled) {
          setRendered({ bindFunctions, svg: out });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Mermaid render failed");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, domId, resolvedTheme]);

  if (error) {
    return (
      <pre className="bg-fd-muted text-fd-muted-foreground border-fd-border my-4 overflow-x-auto rounded-lg border p-4 text-sm">
        {error}
        {"\n\n"}
        {chart}
      </pre>
    );
  }

  if (!rendered) {
    return (
      <div
        className="bg-fd-muted/50 border-fd-border my-6 h-24 animate-pulse rounded-lg border"
        aria-hidden
      />
    );
  }

  return (
    <div
      ref={(container) => {
        if (container) {
          rendered.bindFunctions?.(container);
        }
      }}
      className="my-6 flex justify-center overflow-x-auto [&_svg]:max-h-none [&_svg]:max-w-full"
      // SVG is produced by Mermaid's own parser/renderer, not arbitrary HTML from authors.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid render output only
      dangerouslySetInnerHTML={{ __html: rendered.svg }}
    />
  );
}
