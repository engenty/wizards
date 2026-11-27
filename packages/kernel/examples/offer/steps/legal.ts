import type { OfferStep } from "../wizard.js";

const legal: OfferStep<"legal"> = async (_run, ask) => {
  const review = await ask({
    type: "review",
    role: "legal",
    show: ["offer"],
    approve: true,
    timeout: "3d",
  });
  return { value: review, to: review.approved ? "check" : "offer" };
};

export default legal;
