import type { Step } from "../../../src/types";

/** The agent may read the mail. It cannot send: the step does not hand it that action. */
const work: Step<{ customer: string }> = async (run, ask) => {
  const note = run.last?.step === "look" ? `Change it: ${run.last.value.note}` : "";

  const found = await ask<{ to: string; draft: string }>({
    type: "agent",
    model: "standard",
    instructions: `Find the last thread with ${run.input.customer} and draft an answer. ${note}`,
    tools: ["gmail.search_threads", "gmail.read_thread"],
    fields: [
      { id: "to", kind: "text", required: true },
      { id: "draft", kind: "text", required: true },
    ],
  });

  return { value: found };
};

export default work;
