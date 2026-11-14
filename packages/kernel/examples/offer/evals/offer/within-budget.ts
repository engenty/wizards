import type { OfferEval } from "../../wizard";

/** Code as the judge: exact and free. */
const withinBudget: OfferEval = async (run) => {
  const { price } = run.steps.offer;
  const most = run.input.budget * 1.1;
  return { score: price <= most ? 1 : 0, why: `${price} against a budget of ${run.input.budget}` };
};

export default withinBudget;
