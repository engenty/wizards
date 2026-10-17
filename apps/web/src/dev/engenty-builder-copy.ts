import { lang } from "../lib/i18n";

const COPY = {
  de: {
    furry: "Fell",
    jelly: "Jelly",
    both: "Vergleichen",
    material: "Material",
    clarity: "Transparenz",
    softness: "Weichheit",
    jellyHint: "Jelly ziehen und loslassen, um das elastische Nachfedern zu sehen.",
    background: "Hintergrund",
    light: "Hell",
    match: "Passend zur Figur",
    palette: "Dunkle Engenty-Farben",
    play: "Abspielen",
    pause: "Pause",
    speed: "Tempo",
    motionHint:
      "Automatisch gemäß Systemeinstellung. Abspielen aktiviert die Vorschau auch bei reduzierter Bewegung.",
    angle: "Drehwinkel (°)",
    tilt: "Neigung (°)",
    fur: "Felllänge",
    density: "Haardichte",
    thick: "Haarstärke",
    inflate: "Körperwölbung",
    wind: "Wind",
    description:
      "Fell und Jelly vergleichen, in Bewegung ansehen und auf ihren Bühnenfarben abstimmen.",
    back: "Zurück zu Wizards",
    preview: "Vorschau",
    dark: "Dunkler Hintergrund",
    follow: "Blick folgt Maus",
    goggles: "Pilotenbrille",
    helmet: "Helm",
    helmetShapes: "Helm für rund, Kuppel und Tropfen",
    helmetStageNote:
      "Der Helm ist in Blender nach den Charakterstudien gebaut: Schale, Lackierung, Visier und Ohrmuscheln.",
    controls: "Renderer einstellen",
    form: "Form",
    reset: "Zurücksetzen",
    gallery: "Alle Formen · kleine Darstellung",
    gooseEyebrow: "Charakterstudien · 1986",
    gooseLiveEyebrow: "Goose · live",
    gooseLiveTitle: "Der Helm auf jeder Form",
    gooseLiveNote:
      "Goose trägt den ganzen Fliegerhelm auf Rund, Kuppel und Tropfen, mit Fell und als Jelly. Dreh den Kopf, um den Sitz zu prüfen.",
    gooseIntro:
      "Roter 80er-Helm, rauchgraue Gläser und eine Brille für genau ein Auge. Vier Looks als Fell und Jelly.",
    gooseArtAlt:
      "Vier stilisierte Varianten derselben blauen Engenty-Figur im 2-mal-2-Raster: roter Pilotenhelm mit Shield, roter Helm mit dunkler Aviator-Sonnenbrille, ohne Helm mit Sonnenbrille und roter Helm mit einer einzigen dunklen Linse.",
    gooseConceptNote:
      "Statische Zielstudien. Der klassische Look oben läuft live in 3D, die anderen drei sind noch Studien.",
    goose: {
      classic: {
        name: "Classic Goose",
        description: "Roter Helm mit blau-weißen Winkeln und einem großen rauchgrauen Shield.",
      },
      helmetAviator: {
        name: "Helmet Aviators",
        description: "Derselbe rote Helm, aber mit dunkler Pilotensonnenbrille statt Shield.",
      },
      noHelmet: {
        name: "Off Duty",
        description:
          "Ohne Helm: dunkle Aviator-Gläser, offenes Fell oder Jelly; die Fellversion trägt einen oliven Kragen mit Wings.",
      },
      singleLens: {
        name: "One-Lens Wingman",
        description: "Roter Helm, eine rauchgraue Linse mit dunklem Rahmen und Band um den Kopf.",
      },
    },
  },
  en: {
    furry: "Fur",
    jelly: "Jelly",
    both: "Compare",
    material: "Material",
    clarity: "Transparency",
    softness: "Softness",
    jellyHint: "Drag and release the Jelly to see it spring back.",
    background: "Background",
    light: "Light",
    match: "Match character",
    palette: "Dark Engenty colours",
    play: "Play",
    pause: "Pause",
    speed: "Speed",
    motionHint:
      "Automatic playback follows your system setting. Play explicitly enables animation, including with reduced motion.",
    angle: "Turn angle (°)",
    tilt: "Tilt (°)",
    fur: "Fur length",
    density: "Hair density",
    thick: "Hair width",
    inflate: "Body volume",
    wind: "Wind",
    description: "Compare fur and jelly in motion, and tune them against their stage colours.",
    back: "Back to Wizards",
    preview: "Preview",
    dark: "Dark background",
    follow: "Follow pointer",
    goggles: "Pilot goggles",
    helmet: "Helmet",
    helmetShapes: "Helmet for round, dome and drop",
    helmetStageNote:
      "The helmet is built in Blender to the character studies: shell, livery, visor and ear cups.",
    controls: "Renderer controls",
    form: "Shape",
    reset: "Reset",
    gallery: "All shapes · small sizes",
    gooseEyebrow: "Character studies · 1986",
    gooseLiveEyebrow: "Goose · live",
    gooseLiveTitle: "The helmet on every shape",
    gooseLiveNote:
      "Goose wears the full flight helmet on round, dome and drop, in fur and jelly. Turn the head to check the fit.",
    gooseIntro:
      "Red 80s helmet, smoke-gray lenses and eyewear made for exactly one eye. Four looks in fur and jelly.",
    gooseArtAlt:
      "Four stylized versions of the same blue Engenty in a two-by-two grid: red flight helmet with shield, red helmet with dark aviator sunglasses, no helmet with sunglasses, and red helmet with one dark lens.",
    gooseConceptNote:
      "Static target studies. The classic look above runs live in 3D. The other three are still studies.",
    goose: {
      classic: {
        name: "Classic Goose",
        description: "Red helmet with blue-and-white chevrons and a large smoke-gray shield.",
      },
      helmetAviator: {
        name: "Helmet Aviators",
        description: "The same red helmet, with dark pilot sunglasses instead of a shield.",
      },
      noHelmet: {
        name: "Off Duty",
        description:
          "No helmet: dark aviator lenses and exposed fur or jelly; the fur version wears an olive collar with wings.",
      },
      singleLens: {
        name: "One-Lens Wingman",
        description: "Red helmet, one smoke-gray lens with a dark frame and band around the head.",
      },
    },
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];

/** The copy in the language in effect, looked up on every read: the language can change. */
export const builderCopy = new Proxy({} as Copy, {
  get: (_target, key) => COPY[lang][key as keyof Copy],
});
