import { describe, expect, it } from "vitest";
import { CLIENT_IDS, CLIENTS, clientEntry, installCommand } from "./index.js";
import { suggestedClient } from "./server/index.js";

const codex = clientEntry("codex");
const claude = clientEntry("claude");
const cursor = clientEntry("cursor");
if (!codex || !claude || !cursor) {
  throw new Error("The catalog lost a client.");
}

describe("the catalog", () => {
  it("has each client once, in the order of the ids", () => {
    expect(CLIENTS.map((client) => client.id)).toEqual([...CLIENT_IDS]);
    expect(clientEntry("vim")).toBeNull();
  });

  it("installs from npm into the host's folder, the others with the vendor's script", () => {
    expect(installCommand(codex, "/h/clients", "darwin")).toBe(
      "npm install --global --prefix /h/clients @openai/codex",
    );
    expect(installCommand(codex, "/Users/a b/w/clients", "linux")).toBe(
      "npm install --global --prefix '/Users/a b/w/clients' @openai/codex",
    );
    expect(installCommand(claude, "/h/clients", "darwin")).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
  });

  it("installs on Windows with PowerShell: the vendor's install.ps1, npm with a quoted prefix", () => {
    const folder = "C:\\Users\\a b\\.engenty\\wizards\\clients";
    expect(installCommand(claude, folder, "win32")).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(installCommand(cursor, folder, "win32")).toBe(
      "irm 'https://cursor.com/install?win32=true' | iex",
    );
    expect(installCommand(codex, folder, "win32")).toBe(
      `npm install --global --prefix '${folder}' @openai/codex`,
    );
  });

  it("suggests the first when no vendor app says otherwise", () => {
    const missing = CLIENTS.filter((c) => c.id !== "codex").map((c) => ({
      client: { ...c, app: undefined },
    }));
    expect(suggestedClient(missing)?.client.id).toBe("claude");
    expect(suggestedClient([])).toBeNull();
  });
});
