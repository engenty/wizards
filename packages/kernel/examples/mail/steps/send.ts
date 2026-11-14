import type { Step } from "../../../src/types";
import type { Draft } from "./work";

/** Gmail takes a whole message as base64url text. */
const message = ({ to, subject, draft }: Draft) =>
  btoa(unescape(encodeURIComponent(`To: ${to}\r\nSubject: ${subject}\r\n\r\n${draft}`)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** One fixed action. The file sets it to "ask", so the user is asked before it happens. */
const send: Step<{ customer: string }> = async (run, ask) => {
  const draft: Draft = run.steps.work;
  const sent = await ask({
    type: "tool",
    call: "gmail.users.messages.send",
    input: { userId: "me", body: { raw: message(draft), threadId: draft.threadId } },
  });
  return { value: sent };
};

export default send;
