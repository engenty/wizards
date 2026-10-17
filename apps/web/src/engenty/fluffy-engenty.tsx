"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EngentyKind } from "./colors";
import { Engenty } from "./engenty";
import {
  ENGENTY_FORMS,
  formScale,
  packFormBlobs,
  packFormExtras,
} from "./forms";
import { furPalette } from "./fur-palette";
import { FUR_ORIGIN, FUR_VIEW } from "./fur-shader";
import { acquireFurStage, type EngentyCoat } from "./fur-stage";
import { GOOSE_HAIR, isGooseHelmetKind } from "./goose-helmet-fit";
import { headTurn, MAX_HEAD_TURN } from "./head-turn";
import { JELLY_DEFAULTS } from "./jelly-defaults";
import { bindJellyDrag } from "./jelly-drag";
import { stepJellySpring } from "./jelly-motion";
import { pointerPosition, subscribePointer } from "./pointer";

export type FurQuality = "low" | "medium" | "high";

// Density controls the number of continuous hairs; DPR caps the fragment cost.
const QUALITY: Record<
  FurQuality,
  { density: number; dprCap: number; thick: number }
> = {
  high: { density: 68, dprCap: 2, thick: 1 },
  low: { density: 40, dprCap: 1, thick: 1.15 },
  medium: { density: 55, dprCap: 1.5, thick: 1.05 },
};

/**
 * Smallest strand cell worth drawing, in rendered pixels. Below roughly this,
 * neighbouring pixels land on unrelated cells and the coat reads as noise
 * however well each strand is antialiased — so density is capped by the buffer
 * rather than by taste, and a small engenty simply gets fewer, larger strands.
 */
const MIN_CELL_PIXELS = 1.7;

/**
 * Every engenty runs the same idle cycle off its own clock, so a row of them
 * mounted together would breathe and blink in lockstep — which reads as a
 * screensaver, not a cast. Each instance takes the next offset off this
 * counter; the step is deliberately irrational relative to the blink and morph
 * periods so nearby instances never land in phase, and it stays deterministic
 * (no `Math.random`) so a remount does not make an engenty jump.
 */
let phaseCounter = 0;
const PHASE_STEP = 2.399_963;

/** Key light direction, in the shader's (x, y-down, toward-camera) space. */
const KEY_LIGHT: [number, number, number] = [-0.42, -0.72, 0.75];

/** How far the silhouette bulges toward the camera, in form units. */
const DEFAULT_INFLATE = 30;
const DEFAULT_WIND = 0.5;

export interface FluffyEngentyOverrides {
  /** Jelly only: transparency from 0 (opaque) to 1 (maximum). */
  clarity?: number;
  density?: number;
  fur?: number;
  inflate?: number;
  /** Jelly only: elastic deformation, from rigid (0) to extra soft (1.5). */
  softness?: number;
  thick?: number;
  wind?: number;
}

export interface FluffyEngentyProps {
  /** Idle animation speed; gaze remains responsive at slow playback speeds. */
  animationSpeed?: number;
  className?: string;
  /** Continuous strand fur (default) or a translucent jelly over the same body. */
  coat?: EngentyCoat;
  /** Old-school pilot goggles over the eye: the copilot's look. */
  goggles?: boolean;
  /** Rigid red Goose flight helmet for round, dome or drop. */
  gooseHelmet?: boolean;
  /** Pointer-driven lean and gaze. Off for purely decorative instances. */
  interactive?: boolean;
  kind?: EngentyKind;
  /**
   * Where to turn the head instead of following the pointer: a direction,
   * each axis −1..1 (x right, y down). Leans and gazes there the same way.
   */
  look?: { x: number; y: number } | null;
  /** Auto respects reduced motion; play is an explicit user-initiated preview. */
  motion?: "auto" | "play" | "pause";
  /** Live tuning — the styleguide playground drives these. */
  overrides?: FluffyEngentyOverrides;
  quality?: FurQuality;
  /** Rendered width/height in CSS pixels. Meant to be large: 200px and up. */
  size?: number;
  /** Body yaw/pitch in radians, limited to ten degrees. Follows gaze if omitted. */
  turn?: { yaw: number; pitch: number };
}

/** Percentage of the padded canvas at a given coordinate in 0..120 form space. */
const viewPercent = (value: number) => ((value - FUR_ORIGIN) / FUR_VIEW) * 100;

/**
 * Large, fur-shaded engenty for landing pages and hero surfaces.
 *
 * Same five silhouettes as the flat `Engenty`, but rendered as continuous curved
 * strands (see `strand-renderer.ts`) instead of a filled path. There is no model and no
 * texture: the coat is generated from the kind's metaball form, so adding a
 * form to `forms.ts` makes it fluffy for free.
 *
 * Falls back to the flat engenty wherever WebGL2 is unavailable.
 */
export function FluffyEngenty({
  className,
  motion = "auto",
  animationSpeed = 1,
  turn,
  coat = "fur",
  goggles = false,
  gooseHelmet = false,
  interactive = true,
  look = null,
  kind = "round",
  overrides,
  quality = "high",
  size = 260,
}: FluffyEngentyProps) {
  const requestDraw = useRef<(() => void) | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0);
  if (phase.current === 0) {
    phaseCounter += 1;
    phase.current = phaseCounter * PHASE_STEP;
  }
  const wrapRef = useRef<HTMLDivElement>(null);
  const [supported, setSupported] = useState(true);

  const helmetKind = gooseHelmet && isGooseHelmetKind(kind) ? kind : undefined;
  const form = ENGENTY_FORMS[kind];
  const blobs = useMemo(() => packFormBlobs(form), [form]);
  const extras = useMemo(() => packFormExtras(form), [form]);
  const scale = useMemo(() => formScale(form), [form]);
  // The render loop reads props through a ref so playground sliders retune the
  // running frame instead of tearing down the GL context on every keystroke.
  const live = useRef({
    animationSpeed,
    motion,
    turn,
    goggles,
    helmetKind,
    blobs,
    extras,
    form,
    interactive,
    kind,
    look,
    overrides,
    quality,
    scale,
    size,
  });
  live.current = {
    animationSpeed,
    motion,
    turn,
    goggles,
    helmetKind,
    blobs,
    extras,
    form,
    interactive,
    kind,
    look,
    overrides,
    quality,
    scale,
    size,
  };

  // A static (reduced-motion) preview still redraws when a builder control changes.
  useEffect(() => {
    requestDraw.current?.();
  }, [
    kind,
    overrides,
    quality,
    size,
    interactive,
    look,
    goggles,
    helmetKind,
    motion,
    animationSpeed,
    turn,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!(canvas && wrap)) {
      return;
    }

    const context = canvas.getContext("2d");
    const stage = context ? acquireFurStage(coat) : null;
    if (!(context && stage)) {
      setSupported(false);
      return;
    }

    const phaseOffset = phase.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const lean = { x: 0, y: 0 };
    const gaze = { x: 0, y: 0 };
    // A soft body chasing the lean on an under-damped spring. The lean itself
    // is what the fur uses; the jelly reads the overshoot past it as wobble.
    const gel = { vx: 0, vy: 0, x: 0, y: 0 };
    let frame = 0;
    let visible = true;
    // Clock is accumulated rather than read from `now`, so pausing off-screen
    // resumes the coat where it left off instead of jumping.
    let clock = 0;
    let last = 0;
    const drag =
      coat === "jelly"
        ? bindJellyDrag(
            wrap,
            () =>
              live.current.interactive &&
              live.current.motion !== "pause" &&
              (live.current.motion === "play" || !reduced.matches)
          )
        : null;

    const draw = (now: number) => {
      frame = 0;
      const current = live.current;
      const preset = QUALITY[current.quality];
      const still =
        current.motion === "pause" ||
        (current.motion === "auto" && reduced.matches);

      const dt = still ? 0 : Math.min((now - (last || now)) / 1000, 0.1);
      clock += dt * Math.max(0.1, Math.min(2, current.animationSpeed));
      last = now;

      const dpr = Math.min(window.devicePixelRatio || 1, preset.dprCap);
      const px = Math.max(1, Math.round(current.size * dpr));
      if (canvas.width !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      // 120 form units of body span (120 / FUR_VIEW) of the rendered square.
      const maxDensity = (120 * px) / (MIN_CELL_PIXELS * FUR_VIEW);
      // Goose's coat under the helmet is shorter, denser and thicker than an engenty's own.
      const goose = current.helmetKind ? GOOSE_HAIR : null;
      const fur = current.overrides?.fur ?? current.form.fur * (goose?.length ?? 1);
      if ((current.interactive || current.look) && !still) {
        let dx: number;
        let dy: number;
        let dist: number;
        let look: number;
        if (current.look) {
          dx = current.look.x;
          dy = current.look.y;
          dist = Math.hypot(dx, dy) || 1;
          look = Math.min(1, dist);
        } else {
          const rect = wrap.getBoundingClientRect();
          const pointer = pointerPosition();
          dx = pointer.x - (rect.left + rect.width * 0.5);
          dy = pointer.y - (rect.top + rect.height * 0.48);
          dist = Math.hypot(dx, dy) || 1;
          look = 0.35 + Math.min(1, dist / (rect.width * 2.4 || 1)) * 0.65;
        }
        // Same easing constants as the flat engenty's gaze rig, so a row that
        // mixes flat and fluffy engenties leans as one.
        lean.x += ((dx / dist) * 5.5 * look - lean.x) * 0.16;
        lean.y += ((dy / dist) * 3.5 * look - lean.y) * 0.16;
        // The pupil tracks harder than the body does, as it does on the flat
        // engenty, so a small head tilt still reads as a deliberate look.
        gaze.x += ((dx / dist) * look - gaze.x) * 0.24;
        gaze.y += ((dy / dist) * 0.9 * look - gaze.y) * 0.24;
      }
      stepJellySpring(
        gel,
        [lean.x, lean.y],
        dt * Math.max(0.1, Math.min(2, current.animationSpeed))
      );

      const palette = furPalette(wrap, current.kind);
      stage.drawInto(context, px, {
        blobs: current.blobs,
        clarity: current.overrides?.clarity ?? JELLY_DEFAULTS.clarity,
        softness: current.overrides?.softness ?? JELLY_DEFAULTS.softness,
        pull: drag?.step(
          dt * Math.max(0.1, Math.min(2, current.animationSpeed))
        ),
        body: palette.body,
        deep: palette.deep,
        density: Math.min(
          current.overrides?.density ?? preset.density * (goose?.density ?? 1),
          maxDensity
        ),
        extraMeta: current.extras.meta,
        extras: current.extras.geometry,
        eye: [current.form.eye.x, current.form.eye.y, current.form.eye.r],
        gaze: [gaze.x, gaze.y],
        goggles: current.goggles && !current.helmetKind,
        gooseHelmet: Boolean(current.helmetKind),
        helmetKind: current.helmetKind,
        turn: current.turn
          ? headTurn(
              current.turn.yaw / MAX_HEAD_TURN,
              current.turn.pitch / MAX_HEAD_TURN
            )
          : headTurn(gaze.x, gaze.y),
        fur,
        inflate:
          current.overrides?.inflate ??
          (coat === "jelly" ? JELLY_DEFAULTS.inflate : (goose?.inflate ?? DEFAULT_INFLATE)),
        lean: [lean.x, lean.y],
        light: KEY_LIGHT,
        period: current.form.period,
        scale: current.scale,
        falloff: current.form.falloff,
        thick: current.overrides?.thick ?? preset.thick * (goose?.thick ?? 1),
        time: clock + phaseOffset,
        tip: palette.tip,
        wind: current.overrides?.wind ?? DEFAULT_WIND,
        wobble: [gel.x - lean.x, gel.y - lean.y],
      });
      if (visible && !still) {
        frame = requestAnimationFrame(draw);
      }
    };

    const kick = () => {
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(draw);
      }
    };

    // A hero engenty is usually below the fold or scrolled past; an off-screen
    // canvas must not hold a rAF open.
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? true;
        if (visible) {
          kick();
        } else if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      },
      { rootMargin: "120px" }
    );
    observer.observe(wrap);
    requestDraw.current = kick;

    const unsubscribe = subscribePointer(kick);
    reduced.addEventListener("change", kick);
    kick();

    return () => {
      requestDraw.current = null;
      observer.disconnect();
      drag?.dispose();
      unsubscribe();
      reduced.removeEventListener("change", kick);
      if (frame) {
        cancelAnimationFrame(frame);
      }
      stage.release();
    };
  }, [coat]);

  if (!supported) {
    return (
      <Engenty
        className={className}
        goggles={goggles && !helmetKind}
        kind={kind}
        size={size}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className={className}
      ref={wrapRef}
      style={{ height: size, position: "relative", width: size }}
    >
      <div
        style={{
          background:
            "radial-gradient(closest-side, rgb(0 0 0 / 0.2), transparent)",
          filter: "blur(4px)",
          height: `${(form.shadowRx * 50) / FUR_VIEW}%`,
          left: "50%",
          position: "absolute",
          top: `${viewPercent(110)}%`,
          transform: "translate(-50%, -50%)",
          width: `${(form.shadowRx * 2.5 * 100) / FUR_VIEW}%`,
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          height: size,
          width: size,
          touchAction:
            coat === "jelly" && interactive && motion !== "pause"
              ? "none"
              : undefined,
          cursor: coat === "jelly" && interactive ? "grab" : undefined,
        }}
      />
    </div>
  );
}
