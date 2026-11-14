import type { Step } from "../../../src/types";

/** One fixed action. The file sets it to "ask", so the user is asked before it happens. */
const send: Step<{ customer: string }> = async (run, ask) => {
  const { to, draft } = run.steps.work;
  const sent = await ask({ type: "tool", call: "gmail.send", input: { to, body: draft } });
  return { value: sent };
};

export default send;
