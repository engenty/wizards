import type { OfferStep } from "../wizard.js";

const signed: OfferStep<"signed"> = async (run, ask) => {
  const signal = await ask({
    type: "wait",
    signal: "offer.signed",
    key: run.input.email,
    timeout: "7d",
  });
  return { value: { came: signal.came === true }, to: signal.came ? "end" : "chase" };
};

export default signed;
