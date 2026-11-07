// Helpers the embedders share. fetch only: no dependencies.

// A vector scaled to length one, so cosine is a dot product.
export function unit(v: ArrayLike<number>): number[] {
  const out = Array.from(v);
  let sum = 0;
  for (const x of out) {
    sum += x * x;
  }
  const len = Math.sqrt(sum) || 1;
  return out.map((x) => x / len);
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

// The prompts EmbeddingGemma and gemini-embedding-2 are trained on, as their
// model cards give them. The title is the document's name: a passage is found
// by what its page is about too.
export function queryPrompt(text: string): string {
  return `task: search result | query: ${text}`;
}

export function passagePrompt(text: string, title?: string): string {
  return `title: ${title || "none"} | text: ${text}`;
}

export async function failure(name: string, res: Response): Promise<Error> {
  return new Error(`${name} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
