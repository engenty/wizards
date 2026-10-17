// Shared WebGL lifecycle for depth-tested body, fur and accessory passes.

import type { GooseHelmetKind } from "./goose-helmet-fit";
import { JELLY_DEFAULTS } from "./jelly-defaults";
export interface FurUniforms {
  blobs: Float32Array;
  body: [number, number, number];
  /** How see-through the jelly coat is: 1 maximum, 0 opaque. */
  clarity: number;
  deep: [number, number, number];
  density: number;
  extraMeta: Float32Array;
  /** Decal geometry and meta, from `packFormExtras`. */
  extras: Float32Array;
  eye: [number, number, number];
  falloff: number;
  fur: number;
  gaze: [number, number];
  goggles?: boolean;
  gooseHelmet?: boolean;
  helmetKind?: GooseHelmetKind;
  inflate: number;
  lean: [number, number];
  light: [number, number, number];
  period: number;
  pull?: [number, number, number, number];
  scale: number;
  softness?: number;
  thick: number;
  time: number;
  tip: [number, number, number];
  turn?: [number, number];
  wind: number;
  /** Spring overshoot past the lean, form units; the jelly coat's jiggle. */
  wobble: [number, number];
}

export interface FurRenderer {
  dispose: () => void;
  render: (uniforms: FurUniforms) => void;
  /** Draws the next `render` into a `px` square at the buffer's origin. */
  viewport: (px: number) => void;
}

const UNIFORM_NAMES = [
  "uResolution",
  "uTime",
  "uBlobs",
  "uFalloff",
  "uScale",
  "uFur",
  "uPeriod",
  "uInflate",
  "uDensity",
  "uThick",
  "uLean",
  "uLight",
  "uBody",
  "uDeep",
  "uTip",
  "uEye",
  "uWind",
  "uGaze",
  "uTurn",
  "uGoggles",
  "uExtras",
  "uExtraMeta",
  "uWobble",
  "uClarity",
  "uSoftness",
  "uPull",
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("engenty fur: could not create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`engenty fur: shader compile failed — ${log}`);
  }
  return shader;
}

/**
 * Returns `null` when WebGL2 is unavailable (older Safari, blocklisted GPUs,
 * headless test runners) so callers can fall back to the flat engenty.
 */
export interface FurGeometry {
  dispose: () => void;
  draw: (uniforms: FurUniforms) => void;
}

interface FurPass {
  clear?: boolean;
  depthWrite?: boolean;
  doubleSided?: boolean;
  geometry: (gl: WebGL2RenderingContext, program: WebGLProgram) => FurGeometry;
  vertex: string;
}

export function createFurRenderer(
  canvas: HTMLCanvasElement,
  fragment: string,
  pass: FurPass
): FurRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    depth: true,
    premultipliedAlpha: true,
    // The canvas is redrawn every frame; not preserving it lets the driver
    // skip a copy, and lets a paused rAF keep the last frame on screen anyway.
    preserveDrawingBuffer: false,
    stencil: false,
  });
  if (!gl) {
    return null;
  }

  let program: WebGLProgram | null = null;
  try {
    const vert = compile(gl, gl.VERTEX_SHADER, pass.vertex);
    const frag = compile(gl, gl.FRAGMENT_SHADER, fragment);
    program = gl.createProgram();
    if (!program) {
      throw new Error("engenty fur: could not create program");
    }
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        `engenty fur: link failed — ${gl.getProgramInfoLog(program)}`
      );
    }
  } catch (error) {
    if (program) {
      gl.deleteProgram(program);
    }
    // Falling back silently would hide a broken shader behind a plausible flat
    // engenty, so say what went wrong even though the render still degrades.
    // biome-ignore lint/suspicious/noConsole: the fallback is otherwise invisible.
    console.error(error);
    return null;
  }

  const loc = {} as Record<UniformName, WebGLUniformLocation | null>;
  for (const name of UNIFORM_NAMES) {
    loc[name] = gl.getUniformLocation(program, name);
  }

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const geometry = pass.geometry(gl, program);

  // `gl.useProgram` matches the React hook naming rule, which then objects to
  // it being called inside a branch. Alias it once, here at the top level.
  const bindProgram = gl.useProgram.bind(gl);

  gl.enable(gl.BLEND);
  // Shader output is premultiplied (see the front-to-back accumulation).
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let disposed = false;
  let viewportPx = 1;

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      geometry.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      // Deliberately NOT `loseContext()`: `getContext` hands back the *same*
      // context object for a canvas, so poisoning it here would leave any
      // later renderer on that canvas permanently broken — which is exactly
      // what React StrictMode's mount/unmount/mount does in development.
    },
    render(u) {
      if (!disposed) {
        bindProgram(program);
        gl.bindVertexArray(vao);
        gl.uniform2f(loc.uResolution, viewportPx, viewportPx);
        gl.uniform1f(loc.uTime, u.time);
        gl.uniform4fv(loc.uBlobs, u.blobs);
        gl.uniform1f(loc.uFalloff, u.falloff);
        gl.uniform1f(loc.uScale, u.scale);
        gl.uniform1f(loc.uFur, u.fur);
        gl.uniform1f(loc.uPeriod, u.period);
        gl.uniform1f(loc.uInflate, u.inflate);
        gl.uniform1f(loc.uDensity, u.density);
        gl.uniform1f(loc.uThick, u.thick);
        gl.uniform1f(loc.uClarity, u.clarity);
        gl.uniform1f(loc.uSoftness, u.softness ?? JELLY_DEFAULTS.softness);
        gl.uniform4fv(loc.uPull, u.pull ?? [60, 60, 0, 0]);
        gl.uniform2fv(loc.uLean, u.lean);
        gl.uniform3fv(loc.uLight, u.light);
        gl.uniform3fv(loc.uBody, u.body);
        gl.uniform3fv(loc.uDeep, u.deep);
        gl.uniform3fv(loc.uTip, u.tip);
        gl.uniform3fv(loc.uEye, u.eye);
        gl.uniform1f(loc.uWind, u.wind);
        gl.uniform2fv(loc.uGaze, u.gaze);
        gl.uniform2fv(loc.uTurn, u.turn ?? [0, 0]);
        gl.uniform1f(loc.uGoggles, u.goggles ? 1 : 0);
        gl.uniform4fv(loc.uExtras, u.extras);
        gl.uniform4fv(loc.uExtraMeta, u.extraMeta);
        gl.uniform2fv(loc.uWobble, u.wobble);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, viewportPx, viewportPx);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.frontFace(gl.CW);
        if (pass.doubleSided) {
          gl.disable(gl.CULL_FACE);
        } else {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.BACK);
        }
        if (pass.clear !== false) {
          gl.clearColor(0, 0, 0, 0);
          // biome-ignore lint/suspicious/noBitwiseOperators: WebGL clear accepts a bit mask.
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        }
        gl.depthMask(pass.depthWrite !== false);
        geometry.draw(u);
      }
    },
    viewport(px) {
      if (!disposed) {
        viewportPx = px;
        gl.viewport(0, 0, px, px);
      }
    },
  };
}
