/**
 * Bild zeichnen
 * Überlegt sich erst ein Motiv zum Thema und zeichnet es dann im Querformat für X.
 */

/** What an agent ask gave back, as text. */
const said = (answer: any): string =>
  (typeof answer === "string" ? answer : String(answer?.text ?? "")).trim();

/** What a person typed, marked as data: a model tells it from the wizard's own words. */
const asData = (field: string, value: unknown): string =>
  `<data field="${field}">${String(value ?? "").replaceAll("</data>", "")}</data>`;

/** The look that fits each tone. */
const STYLES: Record<string, string> = {
  Locker: "candid photograph, natural light, warm colours",
  Professionell: "clean editorial photograph, calm composition, soft daylight",
  Witzig: "playful flat illustration, bold colours, simple shapes",
  Inspirierend: "wide atmospheric photograph, golden hour light",
};

export default async function (run: any, ask: any) {
  const tone = String(run.input.tone ?? "Locker");
  const again = run.last?.value?.regenerate === "visual";
  const before = run.steps.visual?.scene;

  // The image is drawn from the topic, not from the post's words: it still fits after the text changes.
  const scene = said(
    await ask({
      type: "agent",
      title: "Motiv überlegen",
      model: "low",
      instructions: `Beschreibe ein Bild, das einen Post auf X zu diesem Thema begleitet. Ein Bildmodell zeichnet es nach deiner Beschreibung.

Thema: ${asData("topic", run.input.topic)}

So beschreibst du:
- Ein Motiv an einem Ort in einem Moment, so wie man es fotografieren könnte. Keine Symbolbilder wie Glühbirnen, Raketen oder Händeschütteln.
- Nenne Motiv, Umgebung, Licht, Farben und Bildausschnitt in zwei bis vier Sätzen.
- Querformat 16:9, das Motiv in der Bildmitte.
- Keine Schrift, keine Logos, keine Bildschirme mit Text, keine erkennbaren echten Personen.
- Schreibe auf Englisch.
${again ? `\nDie Person möchte ein anderes Bild.${run.last.value.note ? ` Ihr Wunsch: ${asData("note", run.last.value.note)}` : ""}${before ? `\nDie Beschreibung davor:\n"""\n${before}\n"""` : ""}\n` : ""}
Gib nur die Beschreibung aus.`,
      format: "text",
      working: "Ich überlege mir ein Motiv …",
    }),
  );

  const image: any = await ask({
    type: "generate",
    title: "Bild zeichnen",
    asset: "image",
    prompt: `${scene} No text, no letters, no logos, no watermark.`,
    options: { aspectRatio: "16:9", style: STYLES[tone] ?? STYLES.Locker },
    working: "Ich zeichne das Bild …",
  });
  // The prompt as it was sent is not for the person: the pages show the image alone.
  const { text: _sent, ...made } = image ?? {};
  return { value: { ...made, scene } };
}
