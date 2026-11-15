/** In den Kanal schicken. Die Datei setzt die Aktion auf "ask": erst nach dem Ja der Person. */
export default async function (run: any, ask: any) {
  const sent = await ask({
    type: "tool",
    call: "slack.chat.postMessage",
    input: { channel: "#team", text: run.steps.draft },
  });
  return { value: sent };
}
