import { describe, expect, it } from "vitest";
import { foundClients, rankClients } from "./client.js";

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

describe("the clients the list opens with", () => {
  const at = (
    id: "codex" | "claude" | "antigravity" | "cursor",
    version: string | null,
    auth: "subscription" | "none" = "none",
    app: string | null = null,
  ) => ({ id, version, auth, app });
  const ids = (clients: { id: string }[]) => clients.map((c) => c.id);

  it("are those signed in, without one installed or present only as an app", () => {
    const clients = [
      at("codex", "1", "subscription"),
      at("claude", "1", "subscription", "Claude"),
      at("antigravity", null, "none", "Antigravity"),
      at("cursor", "1"),
    ];
    expect(ids(foundClients(clients))).toEqual(["claude", "codex"]);
  });

  it("are those on this computer where none is signed in, else the first", () => {
    expect(ids(foundClients([at("codex", null), at("cursor", "1")]))).toEqual(["cursor"]);
    expect(ids(foundClients([at("claude", null), at("codex", null)]))).toEqual(["codex"]);
  });
});
