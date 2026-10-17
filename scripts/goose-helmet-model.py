# Builds Goose's flight helmet in Blender to match the character studies, then saves it as a
# .blend that scripts/export-goose-helmet.py turns into the renderer's mesh and livery:
#   blender -b --python scripts/goose-helmet-model.py -- <out.blend> [preview.png]
#
# Head units: the head is a ball of radius about 1 at the origin; Blender z is up, -y is the
# front. Every part is a parametric surface over the helmet's own polar angle (theta, from the
# crown) and azimuth (phi, 0 at the front), so the livery, the face opening, the visor and the
# fittings all line up by construction.
import math
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = argv[0] if argv else "/tmp/goose-helmet-v2.blend"
PREVIEW = argv[1] if len(argv) > 1 else None

# --- Shape -------------------------------------------------------------------------------
RX, RY, RZ = 1.16, 1.02, 1.16  # shell half-width, half-depth, half-height
BROW = 63.0  # degrees from the crown to the brow, in the middle of the face
BROW_ARCH = 16.0  # the brow drops this much toward the sides of the opening: an arch
BROW_BACK = 76.0  # the same line, carried round the back
BOTTOM_SIDE = 137.0  # lowest point of the cheek guards
BOTTOM_BACK = 124.0
OPEN = 62.0  # half-width of the face opening at the brow, degrees of azimuth
CHIN = 5.0  # the cheek guards reach this much further in toward the chin at their lower edge
# Each cheek guard's lower front corner is rounded over this much azimuth and polar angle.
CORNER_PHI = 16.0
CORNER_THETA = 18.0
SHELL_THICKNESS = 0.07

VISOR_HALF = 64.0  # the visor reaches a little past the opening on both sides
VISOR_GROW = 1.035  # the visor stands proud of the shell...
VISOR_BULGE = 1.16  # ...and bulges forward in the middle, as a factor on the depth
VISOR_SIDE = 110.0  # lower edge beside the nose
VISOR_NOSE = 99.0  # top of the nose notch in the middle
VISOR_NOSE_WIDTH = 20.0
VISOR_CORNER = 16.0  # azimuth over which the lower edge rounds up into the visor's side

EAR_CUP = dict(phi=84.0, theta=102.0, radius=0.3, depth=0.16, chrome=0.16)
CHEEK_FITTING = dict(phi=66.0, theta=120.0, radius=0.17, depth=0.11, chrome=0.09)


def smoothstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def shell_point(theta, phi, grow=1.0, bulge=1.0):
    t, p = math.radians(theta), math.radians(phi)
    # The front of the visor is pushed forward by `bulge`; the back keeps the shell's depth.
    front = max(math.cos(p), 0.0)
    ry = RY * grow * (1.0 + (bulge - 1.0) * front)
    return Vector((RX * grow * math.sin(t) * math.sin(p), -ry * math.sin(t) * math.cos(p), RZ * grow * math.cos(t)))


def surface_normal(theta, phi, grow=1.0, bulge=1.0, eps=0.2):
    a = shell_point(theta + eps, phi, grow, bulge) - shell_point(theta - eps, phi, grow, bulge)
    b = shell_point(theta, phi + eps, grow, bulge) - shell_point(theta, phi - eps, grow, bulge)
    n = a.cross(b).normalized()
    return n if n.dot(shell_point(theta, phi, grow, bulge)) > 0 else -n


def brow(phi):
    a = abs(phi)
    front = BROW + BROW_ARCH * (min(a, OPEN) / OPEN) ** 2
    return front + (BROW_BACK - front) * smoothstep(OPEN, 180.0, a)


def guard_bottom(phi):
    """Lower edge of the cheek guards and the back, rising in a quarter round at the front corner."""
    a = max(abs(phi), OPEN - CHIN)
    edge = BOTTOM_SIDE + (BOTTOM_BACK - BOTTOM_SIDE) * smoothstep(100.0, 175.0, a)
    u = min((a - (OPEN - CHIN)) / CORNER_PHI, 1.0)
    return edge - CORNER_THETA * (1.0 - math.sqrt(max(0.0, 1.0 - (1.0 - u) ** 2)))


def bottom(phi):
    """The shell's lower edge: brow height across the face opening, cheek guards beside it."""
    if abs(phi) < OPEN:
        return brow(phi)
    return guard_bottom(phi)


def visor_bottom(phi):
    """The visor's lower edge: a nose notch in the middle, rounded corners at the sides."""
    a = abs(phi)
    nose = 1.0 - smoothstep(0.0, VISOR_NOSE_WIDTH, a)
    edge = VISOR_SIDE + (VISOR_NOSE - VISOR_SIDE) * nose
    corner = smoothstep(VISOR_HALF - VISOR_CORNER, VISOR_HALF, a)
    top = brow(phi) + 6.0
    return edge + (top - edge) * (1.0 - math.sqrt(max(0.0, 1.0 - corner * corner)))


# --- Mesh helpers ----------------------------------------------------------------------------
def material(name, color, metallic=0.0, roughness=0.3, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Alpha"].default_value = alpha
    if alpha < 1.0:
        m.surface_render_method = "BLENDED"
    return m


def grid_object(name, rows, cols, point, mat, uv=None, solidify=0.0, bevel=0.0, flip=False, outward=False):
    """A quad grid from point(i/rows, j/cols) -> Vector; uv(i/rows, j/cols) -> (u, v).
    `outward` turns every face away from the head, so a solidify thickens inward."""
    bm = bmesh.new()
    verts = [[bm.verts.new(point(i / rows, j / cols)) for j in range(cols + 1)] for i in range(rows + 1)]
    uv_layer = bm.loops.layers.uv.new("Baked livery") if uv else None
    for i in range(rows):
        for j in range(cols):
            quad = [verts[i][j], verts[i][j + 1], verts[i + 1][j + 1], verts[i + 1][j]]
            if flip:
                quad.reverse()
            face = bm.faces.new(quad)
            if uv_layer:
                for loop, (a, b) in zip(face.loops, [(i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)] if not flip else [(i + 1, j), (i + 1, j + 1), (i, j + 1), (i, j)]):
                    loop[uv_layer].uv = uv(a / rows, b / cols)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    if outward:
        bm.normal_update()
        for face in bm.faces:
            if face.normal.dot(face.calc_center_median()) < 0:
                face.normal_flip()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    if solidify:
        s = ob.modifiers.new("solidify", "SOLIDIFY")
        s.thickness = solidify
        s.offset = -1.0
        s.use_rim = True
        s.material_offset_rim = 1
    if bevel:
        b = ob.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = 3
        b.limit_method = "ANGLE"
    return ob


def tube_object(name, path, radius, mat, sides=10):
    """A closed tube along a list of points."""
    bm = bmesh.new()
    rings = []
    for k, p in enumerate(path):
        a = path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]
        a.normalize()
        side = a.cross(p.normalized()).normalized()
        up = side.cross(a).normalized()
        rings.append([bm.verts.new(p + (side * math.cos(s / sides * math.tau) + up * math.sin(s / sides * math.tau)) * radius) for s in range(sides)])
    for k in range(len(rings) - 1):
        for s in range(sides):
            bm.faces.new([rings[k][s], rings[k][(s + 1) % sides], rings[k + 1][(s + 1) % sides], rings[k + 1][s]])
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


def disc_object(name, theta, phi, radius, depth, mat, lift=0.0):
    """A bevelled cylinder standing on the shell, its axis along the surface normal."""
    centre = shell_point(theta, phi)
    normal = surface_normal(theta, phi)
    bpy.ops.mesh.primitive_cylinder_add(vertices=40, radius=radius, depth=depth)
    ob = bpy.context.active_object
    ob.name = name
    ob.rotation_euler = normal.to_track_quat("Z", "Y").to_euler()
    ob.location = centre + normal * (depth / 2 + lift - 0.02)
    ob.data.materials.append(mat)
    for poly in ob.data.polygons:
        poly.use_smooth = True
    b = ob.modifiers.new("bevel", "BEVEL")
    b.width = min(radius, depth) * 0.3
    b.segments = 4
    b.limit_method = "ANGLE"
    ob.modifiers.new("weighted normals", "WEIGHTED_NORMAL")
    return ob


# --- Livery ------------------------------------------------------------------------------------
LIVERY_W, LIVERY_H = 2048, 1024
RED = np.array([0.82, 0.05, 0.094])
WHITE = np.array([0.97, 0.95, 0.9])
BLUE = np.array([0.08, 0.16, 0.85])


# Strokes as the studies draw them, in head units: the crown's "N"s as seen from the front
# (|x|, z) and the side stripes as seen from the side (forward, z). Mirrored left and right.
LIVERY_FRONT = [
    [(0.15, 0.42), (0.21, 1.02), (0.5, 0.44), (0.6, 0.96)],
    [(0.76, 0.42), (0.86, 0.8), (1.02, 0.36)],
]
LIVERY_SIDE = [
    [(0.55, 0.62), (0.1, -0.05)],
    [(0.3, 0.95), (-0.25, 0.1)],
    [(-0.1, 1.08), (-0.65, 0.22)],
    [(-0.5, 1.0), (-0.98, 0.3)],
]
LIVERY_CORE = 0.06
LIVERY_OUTLINE = 0.035


def stroke_distance(px, py, strokes):
    distance = np.full(px.shape, 1e9)
    for stroke in strokes:
        for (ax, ay), (bx, by) in zip(stroke, stroke[1:]):
            dx, dy = bx - ax, by - ay
            t = np.clip(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0.0, 1.0)
            distance = np.minimum(distance, np.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return distance


def livery_image():
    """Red enamel with the studies' blue-and-white zigzags, in the shell's (phi, theta) space."""
    u = (np.arange(LIVERY_W) + 0.5) / LIVERY_W
    v = (np.arange(LIVERY_H) + 0.5) / LIVERY_H
    U, V = np.meshgrid(u, v)
    phi = np.abs(U * 360.0 - 180.0)  # 0 at the front, mirrored left and right
    theta = (1.0 - V) * 180.0
    t, p = np.radians(theta), np.radians(phi)
    x = RX * np.sin(t) * np.sin(p)
    forward = RY * np.sin(t) * np.cos(p)
    z = RZ * np.cos(t)
    # Each set of strokes is drawn where its view faces the surface, blending at about 55 degrees.
    front = np.where(np.cos(p) > 0.5, stroke_distance(x, z, LIVERY_FRONT), 1e9)
    side = np.where(np.cos(p) <= 0.5, stroke_distance(forward, z, LIVERY_SIDE), 1e9)
    distance = np.minimum(front, side)
    blue = distance < LIVERY_CORE
    white = (distance >= LIVERY_CORE) & (distance < LIVERY_CORE + LIVERY_OUTLINE)
    lower = np.vectorize(bottom)(np.where(U < 0.5, -phi, phi))
    painted = (theta > 8.0) & (theta < lower - 6.0) & (phi > 8.5)  # the rail and the rims stay red
    rgb = np.where((blue & painted)[..., None], BLUE, np.where((white & painted)[..., None], WHITE, RED))
    image = bpy.data.images.new("helmet-livery-atlas", LIVERY_W, LIVERY_H, alpha=False)
    pixels = np.concatenate([rgb, np.ones((LIVERY_H, LIVERY_W, 1))], axis=2).astype(np.float32)
    # Blender stores rows bottom-up and expects linear colour for an sRGB image's float pixels.
    image.pixels.foreach_set((pixels ** 2.2).ravel())
    image.pack()
    return image


# --- Build -----------------------------------------------------------------------------------
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob)

livery = material("helmet paint image", (0.64, 0.004, 0.009), roughness=0.2)
tex = livery.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = livery_image()
livery.node_tree.links.new(tex.outputs["Color"], livery.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
enamel = material("candy red enamel", (0.64, 0.004, 0.009), metallic=0.2, roughness=0.25)
molded = material("red molded detail", (0.42, 0.012, 0.018), metallic=0.2, roughness=0.3)
metal = material("brushed metal", (0.7, 0.72, 0.74), metallic=0.9, roughness=0.18)
padding = material("dark padded helmet interior", (0.012, 0.015, 0.02), roughness=0.85)
seal = material("polished blue smoke lens edge", (0.008, 0.012, 0.025), roughness=0.2)
smoke = material("smoke polycarbonate visor", (0.006, 0.01, 0.05), roughness=0.08, alpha=0.55)

# Shell: one sheet from the crown to the lower edge; across the face opening the lower edge is
# the brow, so the cheek guards end in a straight edge beside the opening.
PHI_SAMPLES = 400


def shell_phi(j):
    x = j * 2.0 - 1.0  # -1..1
    return x * 180.0


def shell_theta(i, j):
    return 0.5 + i * (bottom(shell_phi(j)) - 0.5)


def shell_grid(i, j):
    return shell_point(shell_theta(i, j), shell_phi(j))


def shell_uv(i, j):
    return ((shell_phi(j) + 180.0) / 360.0, 1.0 - shell_theta(i, j) / 180.0)


shell = grid_object("formed red outer shell", 70, PHI_SAMPLES, shell_grid, livery, uv=shell_uv, solidify=SHELL_THICKNESS, bevel=0.025, outward=True)
shell.data.materials.append(enamel)
# The shell's inside is the dark padding; its cut edges are enamel.
shell.data.materials.append(padding)
shell.modifiers["solidify"].material_offset = 2

GUARD_TOP = 88.0  # where the cheek guards start to curve in toward the chin


def guard_edge(theta):
    """Azimuth of a cheek guard's front edge: straight below the brow, curving in at the chin."""
    return OPEN - CHIN * smoothstep(GUARD_TOP, BOTTOM_SIDE, theta) ** 0.7


def guard_angles(i, j):
    theta = GUARD_TOP + i * (BOTTOM_SIDE - GUARD_TOP)
    phi = guard_edge(theta) + j * (OPEN + 0.6 - guard_edge(theta))
    return min(theta, guard_bottom(phi)), phi


def guard_grid(sign):
    def point(i, j):
        theta, phi = guard_angles(i, j)
        return shell_point(theta, sign * phi)

    def uv(i, j):
        theta, phi = guard_angles(i, j)
        return ((sign * phi + 180.0) / 360.0, 1.0 - theta / 180.0)

    return point, uv


for name, sign in (("left", -1.0), ("right", 1.0)):
    point, uv = guard_grid(sign)
    guard = grid_object(f"{name} molded lower cheek guard", 40, 16, point, livery, uv=uv, solidify=SHELL_THICKNESS, bevel=0.025, outward=True)
    guard.data.materials.append(enamel)
    guard.data.materials.append(padding)
    guard.modifiers["solidify"].material_offset = 2


RIM_START = OPEN - CHIN - 2.0  # the padded rim runs from one cheek guard's front edge round the back


def rim_point(i, j):
    """A dark padded strip just inside the lower edge, showing a little below it."""
    phi = RIM_START + j * (360.0 - 2.0 * RIM_START)
    phi = phi - 360.0 if phi > 180.0 else phi
    lower = bottom(phi) if abs(phi) >= OPEN else guard_bottom(phi)
    return shell_point(lower - 10.0 + i * 14.0, phi, grow=0.95)


# Padding: the studies show a dark rim along the cheek guards and the back, below the shell.
padding_ob = grid_object("dark padded interior", 6, 200, rim_point, padding, flip=True)


def visor_point(theta, phi):
    """The visor leaves the shell at the brow and bulges forward toward its lower edge."""
    lift = smoothstep(brow(phi), brow(phi) + 28.0, theta)
    return shell_point(theta, phi, grow=1.0 + (VISOR_GROW - 1.0) * (0.4 + 0.6 * lift), bulge=1.0 + (VISOR_BULGE - 1.0) * lift)


def visor_grid(i, j):
    phi = VISOR_HALF * (2 * j - 1)
    top = brow(phi) - 1.5
    return visor_point(top + i * (visor_bottom(phi) - top), phi)


# Visor: a smoke shield standing proud of the opening, its lower edge arched up over the nose.
visor = grid_object("curved smoke visor", 44, 140, visor_grid, smoke, solidify=0.014)

# A dark rubber seal along the brow, where the visor tucks under the shell. The visor's lower
# edge stays clear, as in the studies.
SEAL_HALF = OPEN + 3.0
tube_object(
    "dark visor brow seal",
    [shell_point(brow(p), p, grow=1.012) for p in np.linspace(-SEAL_HALF, SEAL_HALF, 100)],
    0.045,
    seal,
)

# Top rail from the brow over the crown, with a knob at its top end and a rivet at the front.
def rail_section(theta, width, height):
    p = shell_point(theta, 0.0)
    n = surface_normal(theta, 0.0)
    side = Vector((1.0, 0.0, 0.0))
    return [p - side * width / 2 - n * 0.02, p + side * width / 2 - n * 0.02, p + side * width / 2 + n * height, p - side * width / 2 + n * height]


def loft(name, sections, mat, bevel):
    bm = bmesh.new()
    rings = [[bm.verts.new(v) for v in s] for s in sections]
    for k in range(len(rings) - 1):
        for s in range(4):
            bm.faces.new([rings[k][s], rings[k][(s + 1) % 4], rings[k + 1][(s + 1) % 4], rings[k + 1][s]])
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    b = ob.modifiers.new("bevel", "BEVEL")
    b.width = bevel
    b.segments = 4
    ob.modifiers.new("weighted normals", "WEIGHTED_NORMAL")
    for poly in me.polygons:
        poly.use_smooth = True
    return ob


loft("gloss red top rail", [rail_section(t, 0.2, 0.085) for t in np.linspace(14.0, BROW - 4.0, 24)], enamel, 0.025)
loft("low crown hinge", [rail_section(t, 0.27, 0.17) for t in np.linspace(4.0, 15.0, 6)], enamel, 0.04)
rivet_pos = shell_point(BROW - 9.0, 0.0) + surface_normal(BROW - 9.0, 0.0) * 0.065
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.022, location=rivet_pos)
bpy.context.active_object.name = "rail front rivet"
bpy.context.active_object.data.materials.append(metal)

# Ear cups and cheek fittings: red discs with chrome centres, both sides.
for side, sign in (("left", -1.0), ("right", 1.0)):
    for label, spec in (("ear cup", EAR_CUP), ("cheek fitting", CHEEK_FITTING)):
        phi = sign * spec["phi"]
        disc_object(f"{side} {label} cap", spec["theta"], phi, spec["radius"], spec["depth"], enamel)
        disc_object(f"{side} {label} rivet", spec["theta"], phi, spec["chrome"], spec["depth"] * 1.25, metal, lift=0.012)

# --- Preview ---------------------------------------------------------------------------------
if PREVIEW:
    scene = bpy.context.scene
    body = material("goose body — not in asset", (0.02, 0.12, 0.85), roughness=0.5)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=1.0, location=(0, 0, -0.2))
    ball = bpy.context.active_object
    ball.name = "goose body — not in asset"
    ball.scale = (1.06, 1.0, 0.98)
    ball.data.materials.append(body)
    for poly in ball.data.polygons:
        poly.use_smooth = True
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=0.28, location=(0.12, -0.9, 0.12))
    eye = bpy.context.active_object
    eye.name = "goose eye — not in asset"
    eye.data.materials.append(material("eye — not in asset", (0.9, 0.9, 0.9), roughness=0.3))
    world = bpy.data.worlds.new("studio") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.95, 0.93, 0.88, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    for name, loc, energy in (("key", (-4, -5, 5), 900), ("rim", (5, 3, 4), 500), ("fill", (3, -6, 1), 250)):
        light = bpy.data.lights.new(name, "AREA")
        light.energy = energy
        light.size = 4
        lo = bpy.data.objects.new(name, light)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo)
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = 3.2
    co = bpy.data.objects.new("cam", cam)
    yaw = math.radians(-14)
    # Looking along +y turned by `yaw`, from 8 units away.
    co.location = (8 * math.sin(yaw), -8 * math.cos(yaw), 0.25)
    co.rotation_euler = (math.radians(88), 0, yaw)
    scene.collection.objects.link(co)
    scene.camera = co
    scene.view_settings.view_transform = "Standard"
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = scene.render.resolution_y = 720
    scene.render.film_transparent = False
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)

bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("goose-helmet-model: saved", OUT)
