import type { OfferEval } from "../../wizard";

/** A model as the judge. */
const tone: OfferEval = async (run, ask) => {
  const verdict = await ask<{ score: number; why: string }>({
    type: "agent",
    model: "standard",
    instructions: `Is this offer to ${run.input.customer} clear and polite? Give a score from 0 to 1.

${run.steps.offer.text}`,
    fields: [
      { id: "score", kind: "number", required: true },
      { id: "why", kind: "text" },
    ],
  });
  return { score: verdict.score, why: verdict.why };
};

export default tone;
