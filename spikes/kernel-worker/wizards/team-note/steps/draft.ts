/** Notiz schreiben: drei Sätze zum Stichwort, für den Team-Kanal. */
export default async function (run: any, ask: any) {
  const answer: any = await ask({
    type: "agent",
    title: "Notiz schreiben",
    model: "low",
    instructions: `Schreibe eine kurze Notiz für den Team-Kanal, höchstens drei Sätze, zu: ${String(run.input.topic)}`,
    format: "text",
  });
  return { value: String(answer?.text ?? answer).trim() };
}
