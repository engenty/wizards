import { expect, it } from "vitest";
import { rankClients } from "./client.js";

const client = (id: "codex" | "claude" | "cursor", version: string | null, app: string | null) => ({
  id,
  version,
  app,
});

it("recommends an installed client, the one whose app is here first, else the catalog's first", () => {
  const ids = (list: ReturnType<typeof client>[]) => rankClients(list).map((c) => c.id);
  expect(ids([client("claude", "1", null), client("codex", "1", null)])).toEqual([
    "codex",
    "claude",
  ]);
  expect(ids([client("claude", "1", "Claude"), client("codex", "1", null)])).toEqual([
    "claude",
    "codex",
  ]);
  expect(ids([client("codex", null, "ChatGPT"), client("cursor", "1", null)])).toEqual([
    "cursor",
    "codex",
  ]);
});
