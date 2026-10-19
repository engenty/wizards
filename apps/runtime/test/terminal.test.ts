import { describe, expect, it } from "vitest";
import { closeTerminal, openTerminal, subscribeTerminal } from "../src/harness/terminal";

// The built-in terminal needs node-pty's native binary for this platform. The CI runs on Linux,
// where plain node-pty has no prebuilt one and pnpm skips its compile: this test is what fails then.
describe.skipIf(process.platform === "win32")("the built-in terminal", () => {
  it("runs a command and shows what it printed", async () => {
    const id = await openTerminal({
      bin: "/bin/sh",
      args: ["-c", "echo terminal-ok"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    try {
      const { output, code } = await new Promise<{ output: string; code: number }>((resolve) => {
        let output = "";
        subscribeTerminal(id, (event) => {
          if (event.type === "data") {
            output += event.data;
          } else if (event.type === "exit") {
            // A pty can tell of its end a moment before its last output arrives.
            const code = event.code;
            setTimeout(() => resolve({ output, code }), 200);
          }
        });
      });
      expect(output).toContain("terminal-ok");
      expect(code).toBe(0);
    } finally {
      closeTerminal(id);
    }
  });
});
