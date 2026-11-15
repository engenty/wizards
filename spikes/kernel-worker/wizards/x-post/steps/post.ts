/**
 * Post schreiben
 * Schreibt den Text im gewählten Ton, hängt den Link an und kürzt, wenn der Post zu lang für X ist.
 */

/** What an agent ask gave back, as text. */
const said = (answer: any): string =>
  (typeof answer === "string" ? answer : String(answer?.text ?? "")).trim();

/** What a person typed, marked as data: a model tells it from the wizard's own words. */
const asData = (field: string, value: unknown): string =>
  `<data field="${field}">${String(value ?? "").replaceAll("</data>", "")}</data>`;

/** How each tone reads. */
const TONES: Record<string, string> = {
  Locker: "locker und direkt, wie eine Nachricht an Bekannte",
  Professionell: "sachlich und klar, ohne Floskeln",
  Witzig: "mit einem Augenzwinkern, ohne Kalauer",
  Inspirierend: "ermutigend und konkret, ohne Pathos",
};

/** X allows 280 characters and counts every link as 23. */
const LIMIT = 280;
const LINK = 23;

/** The post without quotes around it and without the link, which is added after it. */
const clean = (post: string, link: string): string => {
  let out = post.trim();
  if (link) out = out.replaceAll(link, "").trim();
  return out.replace(/^[„“"»«']+|[“”"»«']+$/g, "").trim();
};

export default async function (run: any, ask: any) {
  const link = String(run.input.link ?? "").trim();
  const tone = String(run.input.tone ?? "Locker");
  // What is left for the text: the link takes its 23 characters and a line break.
  const room = link ? LIMIT - LINK - 2 : LIMIT;
  const again = run.last?.value?.regenerate === "post";
  const before = run.steps.post;

  let post = clean(
    said(
      await ask({
        type: "agent",
        title: "Post schreiben",
        model: "low",
        instructions: `Du schreibst einen Post für X (Twitter).

Thema: ${asData("topic", run.input.topic)}
Ton: ${tone} – ${TONES[tone] ?? tone}

So schreibst du:
- Schreibe in der Sprache des Themas und aus der Sicht der Person, die postet (ich oder wir, wie im Thema).
- Der erste Satz sagt die Neuigkeit. Keine Einleitung davor.
- Namen, Daten, Orte und Zahlen stehen genau so da wie im Thema. Erfinde nichts dazu.
- Höchstens ${room - 20} Zeichen. Kürzer ist besser.
- Hashtags nur, wenn jemand wirklich danach sucht: meist keiner, höchstens zwei, am Ende.
- Höchstens ein Emoji. Keine Anführungszeichen um den Post.
${link ? "- Schreibe keinen Link in den Text. Der Link wird nach deinem Text angehängt, dein letzter Satz führt zu ihm hin." : "- Schreibe keinen Link in den Text."}
${again ? `\nDie Person möchte eine neue Version.${run.last.value.note ? ` Ihr Wunsch: ${asData("note", run.last.value.note)}` : ""}\nDie Version davor:\n"""\n${String(before ?? "")}\n"""\n` : ""}
Gib nur den Text des Posts aus.`,
        format: "text",
        working: "Ich schreibe den Post …",
      }),
    ),
    link,
  );

  // A model counts badly: the length is counted here, and a post that is too long is cut once.
  if ([...post].length > room) {
    post = clean(
      said(
        await ask({
          type: "agent",
          title: "Post kürzen",
          model: "low",
          instructions: `Dieser Post für X ist zu lang. Kürze ihn auf höchstens ${room - 30} Zeichen. Behalte Ton, Namen, Daten und Zahlen. Gib nur den Text aus.

"""
${post}
"""`,
          format: "text",
          working: "Ich kürze den Post auf die Länge von X …",
        }),
      ),
      link,
    );
  }

  const value = link ? `${post}\n\n${link}` : post;
  if (run.steps.visual !== undefined)
    return { value, to: "check", why: "Das Bild gibt es schon, nur der Text ist neu." };
  return { value };
}
