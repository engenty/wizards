import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A guest's run – a live run with a visitor and no user, a plugin door's among them – never gets
// the Docker sandbox: SANDBOX_GUESTS picks its engine, off or agentOS (docs/plans/capabilities.md,
// A1). A member's run keeps the server's SANDBOX.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-guest-sandbox-"));
// Nothing installed here: agentOS is not ready.
process.env.SANDBOX_ENGINES_DIR = mkdtempSync(join(tmpdir(), "wizards-no-engines-"));
process.env.SANDBOX = "docker";
process.env.SANDBOX_GUESTS = "agentos";

let sandbox: typeof import("../src/sandbox");
let resources: typeof import("../src/engine/resources");

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  sandbox = await import("../src/sandbox");
  resources = await import("../src/engine/resources");
});

function fakeEngine(name: string, ready: boolean): import("../src/sandbox").SandboxEngine {
  return {
    name,
    ready: () => ready,
    capabilities: () => ({ commands: [], network: "none", uses: "", workdir: "/w" }),
    create: () => {
      throw new Error("not in this test");
    },
  };
}

const member = { mode: "live", userId: "user-1", visitorId: null };
const guest = { mode: "live", userId: null, visitorId: "visitor-1" };
/** A run a plugin door (WhatsApp, SMS) started: a visitor of the channel's, no user. */
const door = { mode: "live", userId: null, visitorId: "whatsapp:+4366012345", runner: "whatsapp" };
const test = { mode: "test", userId: "user-1", visitorId: null };

describe("picking a guest's engine", () => {
  it("is off by default, and off when it names Docker or nothing it knows", () => {
    const engines = [fakeEngine("docker", true), fakeEngine("agentos", true)];
    expect(sandbox.pickGuestEngine(engines, "")).toBeNull();
    expect(sandbox.pickGuestEngine(engines, "off")).toBeNull();
    expect(sandbox.pickGuestEngine(engines, "docker")).toBeNull();
    expect(sandbox.pickGuestEngine(engines, "e2b")).toBeNull();
  });

  it("takes agentOS only when it is ready", () => {
    expect(sandbox.pickGuestEngine([fakeEngine("agentos", true)], "agentos")?.name).toBe("agentos");
    expect(sandbox.pickGuestEngine([fakeEngine("agentos", false)], "agentos")).toBeNull();
    expect(sandbox.pickGuestEngine([fakeEngine("docker", true)], "agentos")).toBeNull();
  });
});

describe("a run's sandbox with SANDBOX=docker and SANDBOX_GUESTS=agentos, agentOS not installed", () => {
  it("gives a member's run and a test run the server's engine", () => {
    expect(resources.runSandboxEngine(member)?.name).toBe("docker");
    expect(resources.runSandboxEngine(test)?.name).toBe("docker");
  });

  it("gives a guest's run none, a plugin door's run among them", () => {
    expect(resources.runSandboxEngine(guest)).toBeNull();
    expect(resources.runSandboxEngine(door)).toBeNull();
  });

  it("is what the step's tools see: capabilities for a member, none and no handle for a guest", () => {
    const scope = { kind: "run", id: "r" } as never;
    const theirs = new resources.RunResources("run-member");
    theirs.bind(scope, member);
    expect(theirs.sandboxCapabilities()?.commands).toContain("python3");

    const visitors = new resources.RunResources("run-guest");
    visitors.bind(scope, guest);
    expect(visitors.sandboxCapabilities()).toBeNull();
    expect(() => visitors.sandboxHandle()).toThrow("This run has no sandbox.");
  });
});
