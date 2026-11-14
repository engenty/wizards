import type { OfferStep } from "../wizard";

const accept: OfferStep<"accept"> = async (_run, ask) => {
  const review = await ask({ type: "review", show: ["offer"], approve: true });
  return { value: review, to: review.approved ? "signed" : "end" };
};

export default accept;
