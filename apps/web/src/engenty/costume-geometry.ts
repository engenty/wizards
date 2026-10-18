// Uploads the worn costume's procedural mesh; one buffer per form, costume and coat.
import { COSTUME_FLOATS, costumeMesh } from "./costume-mesh";
import type { FurGeometry, FurUniforms } from "./fur-renderer";
import type { EngentyCoat } from "./fur-stage";

const ATTRIBUTES = [
  ["aPosition", 3, 0],
  ["aNormal", 3, 12],
  ["aOrigin", 3, 24],
  ["aMaterial", 1, 36],
  ["aMotion", 1, 40],
  ["aUv", 2, 44],
] as const;

export function createCostumeGeometry(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  coat: EngentyCoat
): FurGeometry {
  const cache = new Map<string, { buffer: WebGLBuffer; count: number }>();
  const locations = ATTRIBUTES.map(([name, size, offset]) => [gl.getAttribLocation(program, name), size, offset] as const);
  return {
    draw(u: FurUniforms) {
      const worn = u.costume;
      if (!worn) return;
      const key = `${worn.kind}:${worn.name}:${worn.fur}`;
      let entry = cache.get(key);
      if (!entry) {
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error("engenty: costume allocation failed");
        const mesh = costumeMesh(worn.kind, worn.name, coat, worn.fur);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
        entry = { buffer, count: mesh.vertices.length / COSTUME_FLOATS };
        cache.set(key, entry);
        if (cache.size > 24) {
          const oldest = cache.entries().next().value;
          if (oldest) {
            gl.deleteBuffer(oldest[1].buffer);
            cache.delete(oldest[0]);
          }
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      for (const [location, size, offset] of locations) {
        if (location < 0) continue;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, COSTUME_FLOATS * 4, offset);
      }
      gl.drawArrays(gl.TRIANGLES, 0, entry.count);
    },
    dispose() {
      for (const entry of cache.values()) gl.deleteBuffer(entry.buffer);
      cache.clear();
    },
  };
}
