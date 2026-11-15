/**
 * Passt der Post?
 * Die Person prüft Text und Bild, ändert den Text oder fordert eine neue Version an.
 */

export default async function (run: any, ask: any) {
  const answer: any = await ask({
    type: "review",
    title: "Passt der Post?",
    description:
      "Prüfe Namen, Datum und Link. Den Text kannst du direkt ändern. Für Text oder Bild kannst du eine neue Version anfordern.",
    show: ["post", "visual"],
    edit: true,
    regenerate: true,
  });
  if (answer?.regenerate === "post")
    return { value: answer, to: "post", why: "Du möchtest einen neuen Text." };
  if (answer?.regenerate === "visual")
    return { value: answer, to: "visual", why: "Du möchtest ein neues Bild." };
  // The post as the person left it: their changes in the review count, not the first version.
  const edit = answer?.edits?.post;
  const post = typeof edit === "string" ? edit : (edit?.text ?? run.steps.post);
  return { value: post };
}
