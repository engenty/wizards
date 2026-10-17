import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { layout, readInstallNote } from "../src/cli/home.js";

const dir = mkdtempSync(join(tmpdir(), "wizards-account-cli-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.MARKETPLACE_URL = "off";
process.env.PLUGINS_WATCH = "0";
delete process.env.MANAGE_URL;

let cli: typeof import("../src/cli/account");

beforeAll(async () => {
  cli = await import("../src/cli/account");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the setup's --local", () => {
  const paths = layout(join(dir, "wizards"));
  const file = join(dir, "wizards", ".features");

  it("switches the account off in .features and notes it in install.json", () => {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(file, "# the switches\n# account=on|off\n# site=on|off\n");
    cli.localOnly(paths, file);
    expect(readFileSync(file, "utf8")).toBe("# the switches\naccount=off\n# site=on|off\n");
    expect(cli.isLocalOnly(file)).toBe(true);
    expect(readInstallNote(paths)).toEqual({ local: true });
  });

  it("is told in one line", () => {
    expect(cli.describeAccount({ kind: "local" })).toBe("only on this computer, no account");
    expect(cli.describeAccount({ kind: "none" })).toBe("not signed in");
  });

  it("ends with a sign-in: the switch follows the default again, the note goes", () => {
    cli.joinedAccount(paths, file);
    expect(readFileSync(file, "utf8")).toBe("# the switches\n# account=on|off\n# site=on|off\n");
    expect(cli.isLocalOnly(file)).toBe(false);
    expect(readInstallNote(paths)).toEqual({});
    // Nothing to undo the second time.
    cli.joinedAccount(paths, file);
    expect(readInstallNote(paths)).toEqual({});
  });
});

describe("the code the terminal shows", () => {
  it("is grouped as people read it, whatever the account sent", () => {
    expect(cli.groupedCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(cli.groupedCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(cli.groupedCode("ABC")).toBe("ABC");
  });
});

describe("the account line", () => {
  const account = { userId: "u", tenantId: "t", name: "Matthias", email: "m@test.local" };

  it("names the person, the team and the credits as far as they are known", () => {
    expect(cli.described(account, null)).toBe("Matthias");
    expect(cli.described(account, { name: "Platzer Fenster & Türen", balanceCredits: 120 })).toBe(
      "Matthias · team Platzer Fenster & Türen · 120 credits",
    );
    expect(
      cli.described(account, { name: "Platzer Fenster & Türen", balanceCredits: 120 }, false),
    ).toBe("Matthias · team Platzer Fenster & Türen");
    expect(cli.described({ ...account, name: "" }, null)).toBe("m@test.local");
    expect(
      cli.describeAccount({
        kind: "linked",
        account,
        team: { tenantId: "t", name: "Team", balanceCredits: 1, at: "" },
      }),
    ).toBe("Matthias · Team");
    expect(cli.described(account, { name: "Team Anna", balanceCredits: 500 })).toBe(
      "Matthias · Team Anna · 500 credits",
    );
  });
});
