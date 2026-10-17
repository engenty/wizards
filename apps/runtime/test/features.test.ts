import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultFeatures,
  featureOn,
  formatFeatures,
  parseFeatures,
  resolveFeatures,
} from "@engenty-wizards/shared/features";
import { afterAll, describe, expect, it } from "vitest";
import { fileFeatures, writeFeature } from "../src/features.js";

const dir = mkdtempSync(join(tmpdir(), "features-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("feature switches", () => {
  it("reads every way a line or a list writes a switch", () => {
    expect(
      parseFeatures(`
        # a comment
        # teamPlans=on|off
        teamPlans=on
        site = off  # trailing comment
        account=false
        unsetConnectors=1
        contacts.leadScoring=on
        ownKeys
        Bad-Name=on
        nonsense=maybe
      `),
    ).toEqual({
      teamPlans: true,
      site: false,
      account: false,
      unsetConnectors: true,
      "contacts.leadScoring": true,
    });
    expect(parseFeatures("teamPlans=on,site=off, account=0")).toEqual({
      teamPlans: true,
      site: false,
      account: false,
    });
  });

  it("lays the layers over each other, the last winning", () => {
    const all = resolveFeatures(defaultFeatures(), { teamPlans: true }, null, { teamPlans: false, site: true });
    expect(all).toMatchObject({ teamPlans: false, site: true, account: true, ownKeys: true });
  });

  it("writes a switch on its line, keeps the comments, and reads the file again when it changed", () => {
    const file = join(dir, ".features");
    expect(fileFeatures(file)).toEqual({});
    writeFileSync(file, "# the switches\n# teamPlans=on|off\n#\n# site=on|off\n");
    writeFeature("teamPlans", true, file);
    writeFeature("site", false, file);
    writeFeature("contacts.leadScoring", true, file);
    expect(readFileSync(file, "utf8")).toBe(
      "# the switches\nteamPlans=on\n#\nsite=off\ncontacts.leadScoring=on\n",
    );
    expect(fileFeatures(file)).toEqual({ teamPlans: true, site: false, "contacts.leadScoring": true });
    writeFeature("teamPlans", null, file);
    expect(readFileSync(file, "utf8")).toContain("# teamPlans=on|off\n");
    expect(fileFeatures(file)).toEqual({ site: false, "contacts.leadScoring": true });
    writeFileSync(file, "account=off\n");
    // A fresh mtime: the file is read again.
    expect(formatFeatures(fileFeatures(file))).toBe("account=off\n");
  });
});

describe("declared switches", () => {
  it("takes a plugin's declarations under its id and their defaults", async () => {
    const { declaredByPlugin } = await import("@engenty-wizards/shared/features");
    const declared = declaredByPlugin("contacts", {
      leadScoring: true,
      export: { kind: "plan", label: "Export", hint: "CSV of all leads." },
      "Bad Name": false,
    });
    expect(declared).toEqual({
      "contacts.leadScoring": { kind: "release", default: true, label: "leadScoring" },
      "contacts.export": { kind: "plan", default: false, label: "Export", hint: "CSV of all leads." },
    });
    expect(defaultFeatures({ ...declared })).toEqual({
      "contacts.leadScoring": true,
      "contacts.export": false,
    });
  });
});

describe("featureOn", () => {
  it("reads what the resolved switches say", () => {
    expect(featureOn({ ownKeys: false, teamPlans: true }, "ownKeys")).toBe(false);
    expect(featureOn({ ownKeys: false, teamPlans: true }, "teamPlans")).toBe(true);
    expect(featureOn({ "contacts.leadScoring": true }, "contacts.leadScoring")).toBe(true);
  });

  it("takes a core flag's declared default where the switches leave it out", () => {
    expect(featureOn({}, "ownKeys")).toBe(true);
    expect(featureOn({}, "account")).toBe(true);
    expect(featureOn({}, "teamPlans")).toBe(false);
    expect(featureOn(undefined, "ownKeys")).toBe(true);
  });

  it("counts an unknown switch as off", () => {
    expect(featureOn({}, "contacts.leadScoring")).toBe(false);
    expect(featureOn({}, "toString")).toBe(false);
  });
});
