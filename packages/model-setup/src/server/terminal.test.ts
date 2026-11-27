import { describe, expect, it } from "vitest";
import { TerminalError, Terminals } from "./terminal.js";

const terminals = new Terminals();

// The built-in terminal needs node-pty's native binary for this platform. The CI runs on Linux,
// where plain node-pty has no prebuilt one and pnpm skips its compile: this test is what fails then.
describe.skipIf(process.platform === "win32")("the built-in terminal", () => {
  it("runs a command and shows what it printed", async () => {
    const id = await terminals.open({
      bin: "/bin/sh",
      args: ["-c", "echo terminal-ok"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    try {
      const { output, code } = await new Promise<{ output: string; code: number }>((resolve) => {
        let output = "";
        terminals.subscribe(id, (event) => {
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
      terminals.close(id);
    }
  });

  it("ends the command once what it is for is done", async () => {
    let asked = 0;
    const id = await terminals.open({
      bin: "/bin/sh",
      args: ["-c", "sleep 60"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      until: async () => ++asked > 0,
    });
    try {
      const events = await new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        terminals.subscribe(id, (event) => {
          seen.push(event.type);
          if (event.type === "exit") {
            resolve(seen);
          }
        });
      });
      expect(events).toEqual(["done", "exit"]);
    } finally {
      terminals.close(id);
    }
  }, 15_000);

  it("says which terminal is gone", () => {
    expect(() => terminals.write("nope", "x")).toThrow(TerminalError);
  });
});
