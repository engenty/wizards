import { useEffect, useRef } from "react";
import { ENGENTY_SVG, type EngentyKind } from "./engenty-shapes";

/**
 * A wizard's engenty, as the studio's `Engenty` draws it (apps/web/src/engenty/engenty.tsx,
 * written out by apps/web/scripts/engenty-shapes.tsx): one eye, its idle morph and blink. In the
 * portal engenties stand only for wizards: on their cards, starters and runs.
 */
export function Engenty({ kind, size = 40 }: { kind: string; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const svg = ENGENTY_SVG[kind as EngentyKind] ?? ENGENTY_SVG.round;
  // SMIL is not CSS: with reduced motion the figure stands still.
  useEffect(() => {
    const el = ref.current?.querySelector("svg");
    if (el && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.pauseAnimations();
      el.setCurrentTime(0);
    }
  }, []);
  return (
    <span
      ref={ref}
      className="engenty"
      style={{ width: size, height: size }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own figures, written by a script
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
