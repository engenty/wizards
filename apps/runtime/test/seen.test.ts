import { describe, expect, it } from "vitest";
import { appIdsOf, noteRequest, seenApps } from "../src/mcp/seen.js";

describe("what the AI clients did", () => {
  it("knows the apps by the names they give themselves", () => {
    expect(appIdsOf("cursor-vscode")).toEqual(["cursor"]);
    expect(appIdsOf("claude-code")).toEqual(["claude-code"]);
    expect(appIdsOf("Visual Studio Code")).toEqual(["vscode"]);
    expect(appIdsOf("claude-ai")).toEqual(["claude-desktop", "claude-ai"]);
    expect(appIdsOf("something else")).toEqual([]);
  });

  it("notes the check-in, the tool call and the widget, per tenant", () => {
    noteRequest("t1", "key-1", "MCP", {
      method: "initialize",
      params: { clientInfo: { name: "cursor-vscode" } },
    });
    expect(seenApps("t1").cursor).toMatchObject({ toolAt: null, widgetAt: null });
    // Later requests carry no name: the sign-in says who it is.
    noteRequest("t1", "key-1", "MCP", [{ method: "tools/call", params: { name: "list_wizards" } }]);
    noteRequest("t1", "key-1", "MCP", {
      method: "resources/read",
      params: { uri: "ui://engenty-wizards/flow-abc.html" },
    });
    expect(seenApps("t1").cursor?.toolAt).toBeTypeOf("number");
    expect(seenApps("t1").cursor?.widgetAt).toBeTypeOf("number");
    expect(seenApps("t2")).toEqual({});
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
