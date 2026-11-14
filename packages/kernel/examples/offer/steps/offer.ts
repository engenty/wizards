import type { OfferStep } from "../wizard";

const total = (items: { price: number; quantity: number }[]) =>
  items.reduce((sum, item) => sum + item.price * item.quantity, 0);
const plusDays = (day: string, days: number) =>
  new Date(Date.parse(day) + days * 86400e3).toISOString().slice(0, 10);

const offer: OfferStep<"offer"> = async (run, ask) => {
  const { customer, items, budget } = run.input;
  const why = !run.last
    ? ""
    : run.last.step === "offer"
      ? "The last version was over budget. Cut it down."
      : `The ${run.last.step} step said: ${run.last.value.note ?? "no answer in time"}`;

  const draft = await ask<{ text: string; price: number }>({
    type: "agent",
    asks: "operator",
    instructions: `Write an offer for ${customer}.
Items: ${items.map((item) => `${item.quantity} x ${item.name}`).join(", ")}
They add up to ${total(items)}. The budget is ${budget}.
Valid until ${plusDays(run.today, 14)}.
${why}`,
    fields: [
      { id: "text", kind: "text", required: true },
      { id: "price", kind: "number", required: true, description: "Total, net" },
    ],
  });

  if (draft.price > budget * 1.1 && run.count("offer") < 4) return { value: draft, to: "offer" };
  return { value: draft, to: draft.price > 5000 ? "legal" : "check" };
};

export default offer;
