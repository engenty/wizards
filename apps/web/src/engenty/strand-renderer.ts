// A closed body is drawn before depth-tested hair and separate accessories.
// The face belongs to the body surface, so the fur can overlap its outer rim.
import { createAccentGeometry } from "./accent-geometry";
import { ACCENT_FRAGMENT_SHADER, ACCENT_VERTEX_SHADER } from "./accent-shaders";
import { createCostumeGeometry } from "./costume-geometry";
import { COSTUME_FRAGMENT_SHADER, COSTUME_VERTEX_SHADER } from "./costume-shaders";
import { createFurRenderer, type FurRenderer } from "./fur-renderer";
import type { EngentyCoat } from "./fur-stage";
import { createGooseHelmetGeometry, type GooseHelmetPart } from "./goose-helmet-geometry";
import {
  GOOSE_HELMET_FRAGMENT_SHADER,
  GOOSE_HELMET_VERTEX_SHADER,
} from "./goose-helmet-shaders";
import { JELLY_FRAGMENT_SHADER } from "./jelly-shader";
import { createStrandGeometry } from "./strand-geometry";
import { STRAND_FRAGMENT_SHADER, STRAND_VERTEX_SHADER } from "./strand-shaders";
import { createBodyGeometry } from "./volume-geometry";
import { BODY_VERTEX_SHADER, FUR_BODY_SHADER } from "./volume-shaders";

export function createStrandRenderer(
  canvas: HTMLCanvasElement,
  coat: EngentyCoat
): FurRenderer | null {
  const body = createFurRenderer(
    canvas,
    coat === "fur" ? FUR_BODY_SHADER : JELLY_FRAGMENT_SHADER,
    {
      vertex:
        coat === "fur"
          ? BODY_VERTEX_SHADER
          : BODY_VERTEX_SHADER.replace(
              "#version 300 es",
              "#version 300 es\n#define JELLY_COAT"
            ),
      geometry: createBodyGeometry,
    }
  );
  if (!body) {
    return null;
  }
  const passes = [body];
  // Goose's helmet: the shell right after the body, so fur in front of its rim draws over it,
  // and the see-through visor last.
  const createHelmetPass = (part: GooseHelmetPart) =>
    createFurRenderer(canvas, GOOSE_HELMET_FRAGMENT_SHADER, {
      vertex:
        coat === "jelly"
          ? GOOSE_HELMET_VERTEX_SHADER.replace(
              "#version 300 es",
              "#version 300 es\n#define JELLY_COAT"
            )
          : GOOSE_HELMET_VERTEX_SHADER,
      geometry: (gl, program) => createGooseHelmetGeometry(gl, program, coat, part),
      clear: false,
      doubleSided: true,
      depthWrite: part === "shell",
    });
  const shell = createHelmetPass("shell");
  if (!shell) {
    body.dispose();
    return null;
  }
  passes.push(shell);
  // The Halloween costume, like the shell: opaque and before the fur, so strands cross its edges.
  const costume = createFurRenderer(canvas, COSTUME_FRAGMENT_SHADER, {
    vertex:
      coat === "jelly"
        ? COSTUME_VERTEX_SHADER.replace("#version 300 es", "#version 300 es\n#define JELLY_COAT")
        : COSTUME_VERTEX_SHADER,
    geometry: (gl, program) => createCostumeGeometry(gl, program, coat),
    clear: false,
    doubleSided: true,
  });
  if (!costume) {
    for (const pass of passes) {
      pass.dispose();
    }
    return null;
  }
  passes.push(costume);
  if (coat === "fur") {
    const hair = createFurRenderer(canvas, STRAND_FRAGMENT_SHADER, {
      vertex: STRAND_VERTEX_SHADER,
      geometry: createStrandGeometry,
      clear: false,
      doubleSided: true,
      depthWrite: false,
    });
    if (!hair) {
      for (const pass of passes) {
        pass.dispose();
      }
      return null;
    }
    passes.push(hair);
  }
  const accents = createFurRenderer(canvas, ACCENT_FRAGMENT_SHADER, {
    vertex: ACCENT_VERTEX_SHADER,
    geometry: createAccentGeometry,
    clear: false,
  });
  if (!accents) {
    for (const pass of passes) {
      pass.dispose();
    }
    return null;
  }
  passes.push(accents);
  const visor = createHelmetPass("visor");
  if (!visor) {
    for (const pass of passes) {
      pass.dispose();
    }
    return null;
  }
  passes.push(visor);
  return {
    render(u) {
      for (const pass of passes) {
        pass.render(u);
      }
    },
    viewport(px) {
      for (const pass of passes) {
        pass.viewport(px);
      }
    },
    dispose() {
      for (const pass of passes) {
        pass.dispose();
      }
    },
  };
}
