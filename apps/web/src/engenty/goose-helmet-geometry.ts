// Goose's flight helmet, exported from the Blender study by scripts/export-goose-helmet.py.
// The mesh and livery load on the first frame that wears the helmet, so other engenties never
// fetch them. The shell draws before the fur, so strands in front of its rim stay visible; the
// smoke visor draws last, over the fur in the face opening.
import meshUrl from "./assets/goose-helmet.bin?url";
import liveryUrl from "./assets/goose-helmet-livery.webp?url";
import type { FurGeometry, FurUniforms } from "./fur-renderer";
import type { EngentyCoat } from "./fur-stage";
import { GOOSE_HELMET_FIT } from "./goose-helmet-fit";

export type GooseHelmetPart = "shell" | "visor";

interface HelmetAsset {
  vertices: ArrayBuffer;
  indices: Uint16Array;
  opaqueCount: number;
  positionScale: number;
  livery: HTMLImageElement;
}

interface Uploaded {
  vertex: WebGLBuffer;
  index: WebGLBuffer;
  texture: WebGLTexture;
  opaqueCount: number;
  totalCount: number;
  positionScale: number;
  users: number;
}

const VERTEX_BYTES = 18;
let asset: Promise<HelmetAsset> | null = null;
// Both passes of a canvas share one context, so they share one upload.
const uploads = new WeakMap<WebGL2RenderingContext, Uploaded>();

async function loadLivery(): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = liveryUrl;
  await image.decode();
  return image;
}

function loadHelmet(): Promise<HelmetAsset> {
  asset ??= Promise.all([fetch(meshUrl).then((r) => r.arrayBuffer()), loadLivery()]).then(
    ([buffer, livery]) => {
      const header = new DataView(buffer, 0, 20);
      const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
      if (magic !== "GHLM") throw new Error("engenty: helmet mesh is not a GHLM file");
      const vertexCount = header.getUint32(4, true);
      const indexCount = header.getUint32(8, true);
      const vertexEnd = 20 + vertexCount * VERTEX_BYTES;
      return {
        vertices: buffer.slice(20, vertexEnd),
        indices: new Uint16Array(buffer.slice(vertexEnd, vertexEnd + indexCount * 2)),
        opaqueCount: header.getUint32(12, true),
        positionScale: header.getFloat32(16, true),
        livery,
      };
    }
  );
  return asset;
}

function upload(gl: WebGL2RenderingContext, a: HelmetAsset): Uploaded {
  const existing = uploads.get(gl);
  if (existing) return existing;
  const vertex = gl.createBuffer();
  const index = gl.createBuffer();
  const texture = gl.createTexture();
  if (!(vertex && index && texture)) throw new Error("engenty: helmet allocation failed");
  gl.bindBuffer(gl.ARRAY_BUFFER, vertex);
  gl.bufferData(gl.ARRAY_BUFFER, a.vertices, gl.STATIC_DRAW);
  // An index buffer binds to the current vertex array, so fill it outside any pass's array.
  const previous = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, a.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(previous);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, a.livery);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const anisotropic = gl.getExtension("EXT_texture_filter_anisotropic");
  if (anisotropic) gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  const uploaded = {
    vertex,
    index,
    texture,
    opaqueCount: a.opaqueCount,
    totalCount: a.indices.length,
    positionScale: a.positionScale,
    users: 0,
  };
  uploads.set(gl, uploaded);
  return uploaded;
}

export function createGooseHelmetGeometry(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  coat: EngentyCoat,
  part: GooseHelmetPart
): FurGeometry {
  let uploaded: Uploaded | null = null;
  let loading = false;
  let disposed = false;
  const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
  const fit = gl.getUniformLocation(program, "uHelmetFit");
  const aspect = gl.getUniformLocation(program, "uHelmetAspect");
  const livery = gl.getUniformLocation(program, "uLivery");
  const headUnit = gl.getUniformLocation(program, "uHeadUnit");

  const bind = (shared: Uploaded) => {
    const previous = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, shared.vertex);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, shared.index);
    const attribute = (
      name: string,
      size: number,
      type: number,
      normalized: boolean,
      offset: number
    ) => {
      const location = gl.getAttribLocation(program, name);
      if (location < 0) return;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, type, normalized, VERTEX_BYTES, offset);
    };
    attribute("aPosition", 3, gl.SHORT, false, 0);
    attribute("aNormal", 3, gl.SHORT, true, 6);
    attribute("aUv", 2, gl.UNSIGNED_SHORT, true, 12);
    attribute("aMaterial", 1, gl.UNSIGNED_SHORT, false, 16);
    gl.bindVertexArray(previous);
    shared.users++;
    uploaded = shared;
  };

  return {
    draw(u: FurUniforms) {
      if (!(u.gooseHelmet && u.helmetKind)) return;
      if (!uploaded) {
        if (!loading) {
          loading = true;
          loadHelmet().then(
            (a) => {
              if (!disposed) bind(upload(gl, a));
            },
            // biome-ignore lint/suspicious/noConsole: a missing helmet is otherwise invisible.
            (error) => console.error(error)
          );
        }
        return;
      }
      const f = GOOSE_HELMET_FIT[u.helmetKind][coat];
      gl.uniform4f(fit, f.scale / uploaded.positionScale, f.x, f.y, f.z);
      gl.uniform3f(aspect, f.width, f.height, f.depth);
      gl.uniform1f(headUnit, 1 / uploaded.positionScale);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, uploaded.texture);
      gl.uniform1i(livery, 0);
      gl.bindVertexArray(vao);
      if (part === "shell") {
        gl.drawElements(gl.TRIANGLES, uploaded.opaqueCount, gl.UNSIGNED_SHORT, 0);
      } else {
        gl.drawElements(
          gl.TRIANGLES,
          uploaded.totalCount - uploaded.opaqueCount,
          gl.UNSIGNED_SHORT,
          uploaded.opaqueCount * 2
        );
      }
    },
    dispose() {
      disposed = true;
      if (!uploaded) return;
      uploaded.users--;
      if (uploaded.users > 0) return;
      uploads.delete(gl);
      gl.deleteBuffer(uploaded.vertex);
      gl.deleteBuffer(uploaded.index);
      gl.deleteTexture(uploaded.texture);
    },
  };
}
