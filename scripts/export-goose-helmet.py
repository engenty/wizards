# Exports Goose's flight helmet, as built by scripts/goose-helmet-model.py, into the two files
# the engenty renderer loads: a compact mesh and the livery texture.
#   blender -b goose-helmet.blend --python scripts/export-goose-helmet.py -- apps/web/src/engenty/assets
#
# goose-helmet.bin: header "GHLM", vertex count, index count, opaque index count (uint32 each),
# position scale (float32); then 18-byte vertices (int16 position xyz in head units times the
# scale, int16 normal, uint16 uv, uint16 material); then uint16 triangle indices, the visor last.
# Head units: x right, y down, z toward the viewer, head radius about 1.
import os
import struct
import sys

import bpy

out_dir = sys.argv[sys.argv.index("--") + 1]
POSITION_SCALE = 16000.0
TRIANGLE_BUDGET = 11000

MATERIALS = {
    "candy red enamel": 0,
    "helmet paint image": 1,
    "red molded detail": 2,
    "brushed metal": 3,
    "dark padded helmet interior": 4,
    "polished blue smoke lens edge": 5,
    "smoke polycarbonate visor": 6,
}
VISOR = 6


def triangle_count(o):
    evaluated = o.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    count = len(mesh.loop_triangles)
    evaluated.to_mesh_clear()
    return count


parts = [o for o in bpy.data.objects if o.type == "MESH" and "not in asset" not in o.name]

# Round little parts and the visor, whose clear lower edge shows every facet, keep more of
# their faces; the large smooth sheets carry the budget.
small = ("cup", "fitting", "rivet", "seal", "hinge", "visor")
counts = {o.name: triangle_count(o) for o in parts}
base = TRIANGLE_BUDGET / sum(counts.values())
for o in parts:
    share = min(1.0, base * (1.8 if any(word in o.name for word in small) else 1.0))
    if share >= 1.0:
        continue
    decimate = o.modifiers.new("export decimate", "DECIMATE")
    decimate.decimate_type = "COLLAPSE"
    decimate.ratio = share
    decimate.use_collapse_triangulate = True

depsgraph = bpy.context.evaluated_depsgraph_get()
vertices = []
index_of = {}
opaque, visor = [], []
for o in parts:
    evaluated = o.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    world = o.matrix_world
    normal_matrix = world.to_3x3().inverted().transposed()
    uv_layer = mesh.uv_layers.get("Baked livery") or mesh.uv_layers.active
    slot_ids = [MATERIALS.get(s.material.name if s.material else "", 0) for s in evaluated.material_slots] or [0]
    for tri in mesh.loop_triangles:
        material = slot_ids[min(tri.material_index, len(slot_ids) - 1)]
        corners = []
        for loop in tri.loops:
            p = world @ mesh.vertices[mesh.loops[loop].vertex_index].co
            n = (normal_matrix @ mesh.corner_normals[loop].vector).normalized()
            uv = uv_layer.data[loop].uv if (uv_layer and material == 1) else (0.0, 0.0)
            # Blender: z up, -y toward the camera.
            position = (p.x, -p.z, -p.y)
            key = (
                *(round(c * POSITION_SCALE) for c in position),
                round(n.x * 32767), round(-n.z * 32767), round(-n.y * 32767),
                round(min(max(uv[0], 0), 1) * 65535), round(min(max(uv[1], 0), 1) * 65535),
                material,
            )
            index = index_of.get(key)
            if index is None:
                index = index_of[key] = len(vertices)
                vertices.append(key)
            corners.append(index)
        (visor if material == VISOR else opaque).extend(corners)
    evaluated.to_mesh_clear()

if len(vertices) >= 65536:
    sys.exit(f"export-goose-helmet: {len(vertices)} vertices do not fit 16-bit indices")
indices = opaque + visor
with open(os.path.join(out_dir, "goose-helmet.bin"), "wb") as f:
    f.write(struct.pack("<4sIIIf", b"GHLM", len(vertices), len(indices), len(opaque), POSITION_SCALE))
    for v in vertices:
        f.write(struct.pack("<hhhhhhHHH", *v))
    f.write(struct.pack(f"<{len(indices)}H", *indices))

livery = bpy.data.images["helmet-livery-atlas"].copy()
livery.scale(2048, 1024)
livery.file_format = "WEBP"
livery.save(filepath=os.path.join(out_dir, "goose-helmet-livery.webp"), quality=86)

print(f"export-goose-helmet: {len(vertices)} vertices, {len(indices) // 3} triangles")
