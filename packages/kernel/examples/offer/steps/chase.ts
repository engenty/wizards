import type { OfferStep } from "../wizard";

const chase: OfferStep<"chase"> = async (run, ask) => {
  const value = await ask({
    type: "agent",
    instructions: `Write a short, friendly reminder to ${run.input.customer}.`,
    fields: [{ id: "mail", kind: "text", required: true }],
  });
  return { value };
};

export default chase;
