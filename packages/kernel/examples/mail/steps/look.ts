import type { Step } from "../../../src/types.js";

const look: Step<{ customer: string }, "send" | "work"> = async (_run, ask) => {
  const review = await ask({ type: "review", show: ["work"], approve: true });
  return { value: review, to: review.approved ? "send" : "work" };
};

export default look;
