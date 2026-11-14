import type { OfferEval } from "../../wizard";

/** Of the whole run: did it end with a signature. */
const signed: OfferEval = async (run) => ({ score: run.steps.signed?.came ? 1 : 0 });

export default signed;
