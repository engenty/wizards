/**
 * What a model can be trusted with. `basic`: short answers and simple calls; it fills in a wrong
 * input, or makes up what it does not know, and does not notice. `standard`: several steps and
 * inputs with parts. `high`: plans, code, conditions, work over many steps.
 */
export const LEVELS = ["basic", "standard", "high"] as const;
export type Level = (typeof LEVELS)[number];

export const reaches = (has: Level, needs: Level): boolean =>
  LEVELS.indexOf(has) >= LEVELS.indexOf(needs);

export interface ModelFacts {
  /** The model's name, as its source spells it. */
  model: string;
  /** It runs on the person's own computer: its size tells more than its name. */
  local?: boolean;
  /** Bytes of its weights. */
  size?: number;
}

/** The smaller models of the large vendors, by what their names say. */
const SMALL = /(?:^|[^a-z])(?:mini|nano|lite|flash|haiku|small|tiny|fast|instant|air)(?:[^a-z]|$)/i;
const LARGE =
  /claude|opus|sonnet|gpt-[5-9]|(?:^|[^a-z])o[3-9](?:[^a-z]|$)|gemini|kimi|deepseek|grok|glm|minimax|mistral-(?:large|medium)|qwen[\d.]*-max/i;

/** Billions of parameters from which a local model is `standard`, and `high`. */
const STANDARD_PARAMETERS = 12;
const HIGH_PARAMETERS = 100;
/** Bytes a billion parameters takes at the four bits most local models have. */
const BYTES_PER_BILLION = 0.6e9;

/** Billions of parameters: as the name says ("27b"), else by the weights. */
function parametersOf({ model, size }: ModelFacts): number | null {
  // "30b-a3b": a mixture of experts thinks with the active part.
  const active = model.match(/-a(\d+(?:\.\d+)?)b(?![a-z])/i);
  const named = active ?? model.match(/(?:^|[^a-z\d.])(\d+(?:\.\d+)?)b(?![a-z])/i);
  if (named?.[1]) {
    return Number(named[1]);
  }
  return size ? size / BYTES_PER_BILLION : null;
}

/** The level of a model, as far as its name and size say. Unknown is `basic`. */
export function levelOf(facts: ModelFacts): Level {
  if (facts.local) {
    const parameters = parametersOf(facts);
    if (parameters === null || parameters < STANDARD_PARAMETERS) {
      return "basic";
    }
    return parameters < HIGH_PARAMETERS ? "standard" : "high";
  }
  if (LARGE.test(facts.model)) {
    return SMALL.test(facts.model) ? "standard" : "high";
  }
  const parameters = parametersOf(facts);
  if (parameters !== null) {
    return parameters < STANDARD_PARAMETERS
      ? "basic"
      : parameters < HIGH_PARAMETERS
        ? "standard"
        : "high";
  }
  return "basic";
}
