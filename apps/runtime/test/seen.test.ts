import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-seen-"));
process.env.LOCAL_ACCESS_KEY = "test-key";

const { migrateControlDb, withTenant } = await import("../src/db/client.js");
const { appIdsOf, checkedApps, noteChecked, noteRequest, pruneSeen, seenApps } = await import(
  "../src/mcp/seen.js"
);

beforeAll(() => migrateControlDb());

describe("what the AI clients did", () => {
  it("knows the apps by the names they give themselves", () => {
    expect(appIdsOf("cursor-vscode")).toEqual(["cursor"]);
    expect(appIdsOf("claude-code")).toEqual(["claude-code"]);
    expect(appIdsOf("Visual Studio Code")).toEqual(["vscode"]);
    expect(appIdsOf("claude-ai")).toEqual(["claude-desktop", "claude-ai"]);
    expect(appIdsOf("something else")).toEqual([]);
  });

  it("notes the check-in, the tool call and the widget, per tenant", async () => {
    await noteRequest("t1", "key-1", "MCP", {
      method: "initialize",
      params: { clientInfo: { name: "cursor-vscode" } },
    });
    expect((await seenApps("t1")).cursor).toMatchObject({ toolAt: null, widgetAt: null });
    // Later requests carry no name: the sign-in says who it is.
    await noteRequest("t1", "key-1", "MCP", [{ method: "tools/call", params: { name: "list_wizards" } }]);
    await noteRequest("t1", "key-1", "MCP", {
      method: "resources/read",
      params: { uri: "ui://engenty-wizards/flow-abc.html" },
    });
    const seen = await seenApps("t1");
    expect(seen.cursor?.toolAt).toBeTypeOf("number");
    expect(seen.cursor?.widgetAt).toBeTypeOf("number");
    expect(await seenApps("t2")).toEqual({});
  });

  it("keeps a tool call when a later request is none", async () => {
    await noteRequest("t3", "key-3", "cursor", { method: "tools/call" });
    const { toolAt } = (await seenApps("t3")).cursor ?? {};
    await noteRequest("t3", "key-3", "cursor", { method: "ping" });
    expect((await seenApps("t3")).cursor?.toolAt).toBe(toolAt);
  });

  it("counts an app's checks per person, and forgets them after a month", async () => {
    await noteChecked("t4", "Goose", "Pat", true, "subscription");
    await noteChecked("t4", "Goose", "Pat", false, "subscription");
    await noteChecked("t4", "Goose", null, true, "subscription");
    const apps = await checkedApps("t4");
    expect(apps).toHaveLength(2);
    expect(apps.find((a) => a.person === "Pat")).toMatchObject({ allowed: 1, refused: 1 });
    expect(apps.find((a) => a.person === null)).toMatchObject({ allowed: 1, refused: 0 });
    await withTenant("t4", () => pruneSeen(Date.now() + 31 * 24 * 3600_000));
    expect(await checkedApps("t4")).toEqual([]);
  });
});

describe("what kind of model an app thinks with", () => {
  it("counts LM Studio as local, every other app as one on a subscription", async () => {
    const { appKind } = await import("../src/mcp/seen");
    expect(appKind("LM Studio")).toBe("local");
    // Goose mostly thinks on a provider's model; a sign-in of another app is no local app.
    expect(appKind("goose")).toBe("subscription");
    expect(appKind("LM Studio", "MCP")).toBe("local");
    expect(appKind("LM Studio", "Claude Code")).toBe("subscription");
    expect(appKind("claude-code")).toBe("subscription");
    expect(appKind("some renamed app")).toBe("subscription");
  });
});
