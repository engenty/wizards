import type { Step } from "../../src/types";

/** What `wizard.json` says of this wizard, as types for its steps. The check would write this. */
export type Input = {
  customer: string;
  email: string;
  budget: number;
  items: { name: string; price: number; quantity: number }[];
};

type Ways = {
  offer: "check" | "legal" | "offer";
  legal: "check" | "offer";
  check: "accept" | "offer";
  accept: "signed" | "end";
  signed: "end" | "chase";
  chase: "end";
};

export type OfferStep<Id extends keyof Ways> = Step<Input, Ways[Id]>;
