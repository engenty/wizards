# Furry Engenties

Both coats use a closed 3D Gaussian-metaball surface (`volume-mesh.ts`).
Instanced curved hair ribbons grow across its complete surface, including its
back. Body, hair and separate spherical/tubular accessories share depth testing.
The eye belongs to the body surface and is drawn before the hair: short combed
strands cross its irregular outer rim. Directional contact shading softens the
socket; this is an approximation, not a per-strand shadow map.
Strands are bucket-sorted from far to near for each viewing angle before alpha
blending, so the rear coat has the same coverage as the front.
The shared stage uses one WebGL context per coat across all instances.
No textures, models or extra dependencies.

Tune `fur`, `density`, `thick`, `inflate` and `wind` through `FluffyEngenty.overrides`.
The former shell-count option is removed: strands are continuous geometry.
Roots are cached by form, density and inflation; time, gaze, wind, colour and
hair length do not regenerate them. The GPU cache is bounded to 24 variants.

- Wizards: `/dev/engenty-builder` (development only; German/English).
- The engenty repo's manage app: `/styleguide`, section `fluffy`.

Canonical renderer source: `packages/ui-core/src/components/engenty` in the engenty repo.
Wizards vendors the same files under `apps/web/src/engenty`; copy changes to both.
The geometry stability tests live beside the canonical source in the engenty repo.

## Motion and accessories

`motion="auto"` respects reduced motion; `"play"` explicitly starts a preview and
`"pause"` freezes it. `animationSpeed` controls the idle clock. The body follows
gaze within a combined ten-degree yaw/pitch limit; `turn={{ yaw, pitch }}` sets
radians directly within that same limit. The full-orbit mode has been removed.
Goggles use a raised gasket, brass torus, rivets and a convex translucent lens;
the leather strap follows the body surface. The flat icon retains its SVG glasses.
`gooseHelmet` puts a flight helmet on round, dome or drop Fur and Jelly Engenties:
painted shell with cheek guards, smoke visor with a nose notch, rail, ear cups and cheek
fittings. It is an accessory: the engenty keeps its own colour, body and eye under it,
and its fur turns Goose's: a third of the length, denser and thicker (`GOOSE_HAIR`).
Goose is the round blue engenty wearing it. The helmet follows the head turn without
inheriting Jelly deformation, and replaces goggles when both are passed. Its mesh
(`assets/goose-helmet.bin`, about 15,600 triangles) and livery (`assets/goose-helmet-livery.webp`)
load on the first frame that wears it. `scripts/goose-helmet-model.py` builds the helmet in
Blender, `scripts/export-goose-helmet.py` writes both files from it, and `goose-helmet-fit.ts`
places the helmet on each form.

The Wizards builder starts gaze following, supports Fur/Jelly/Compare, and uses
`stageFill` for the per-character dark backgrounds. Pause and manual turn sliders
allow inspection; Play is an explicit override of reduced-motion preferences.

## Use in applications

Pro exports both coats and the goggles through the existing shared component:

```tsx
import { FluffyEngenty } from "@engenty/ui-core";

<FluffyEngenty kind="round" coat="fur" goggles size={280} />
<FluffyEngenty kind="drop" coat="jelly" goggles size={280} />
<FluffyEngenty kind="round" coat="fur" gooseHelmet size={280} />
<FluffyEngenty kind="dome" coat="jelly" gooseHelmet size={280} />
<FluffyEngenty kind="drop" coat="fur" gooseHelmet size={280} />
```

Wizard pages can use the theme-aware brand wrapper. Large fluffy instances use
this renderer; small icons keep the flat version with matching goggles:

```tsx
import { Mascot } from "@/brand";

<Mascot kind="round" fluffy coat="fur" goggles size={280} />
<Mascot kind="drop" fluffy coat="jelly" goggles size={280} />
```

Gaze following (up to ten degrees) is on by default. Use `interactive={false}`
for decorative instances. Both components work in normal application builds;
only the Wizard builder route is restricted to development.

## Jelly tuning

`JELLY_DEFAULTS` sets `inflate: 27`, `softness: 0.05`, and `clarity: 0.15`.
The gel uses soft, restrained reflections. Softness ranges from
0 (no gel deformation) to 1.5 (extra soft): it controls volume-preserving squash,
low-frequency waves, shallow dents and the response to gaze changes. The damped
spring settles consistently across frame rates. Normals follow the deformed mesh,
so the wet highlights move with its surface. Fur does not use these deformations.
Clarity controls background transmission from 0 (opaque) to 1 (maximum). The material approximates internal
scattering and highlights; it does not refract objects elsewhere in the DOM.

Interactive Jelly specimens can be dragged locally and released to watch the
surface spring back. `interactive={false}`, paused playback, and automatic
reduced-motion mode disable grabs.

## App integration

The www lobby, cast and heading mascots use the shared Jelly defaults. Larger
agent avatars in the app (56px and above), hiring previews and onboarding
characters use the same renderer; compact navigation marks remain SVG.
Wizard's large theme-aware `Mascot` instances also use the shared renderer.

## Licence

The figures themselves (`engenty.tsx`, `colors.ts`, `forms.ts`, `goggles.tsx`, `helmet.tsx`,
`logo.tsx`, `goose-helmet-fit.ts` and the helmet's mesh and livery in `assets/`) are CC BY 4.0; the renderers and motion in this folder are FSL-1.1-MIT. Using the figures as a brand
is governed by [TRADEMARKS.md](../../../../TRADEMARKS.md).
