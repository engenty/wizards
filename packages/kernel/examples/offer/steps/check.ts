import type { OfferStep } from "../wizard.js";

const check: OfferStep<"check"> = async (_run, ask) => {
  const review = await ask({
    type: "review",
    role: "operator",
    show: ["offer"],
    approve: true,
    timeout: "2d",
  });
  return { value: review, to: review.approved ? "accept" : "offer" };
};

export default check;
