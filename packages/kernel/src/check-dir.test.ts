import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkDir } from "./check-dir.js";
import { typesOf } from "./types-of.js";

const example = (name: string) => new URL(`../examples/${name}/`, import.meta.url).pathname;
async function copyOf(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "kernel-check-"));
  await cp(example(name), dir, { recursive: true });
  // the examples import their types from the package's source; a wizard's folder has its own
  for (const step of ["offer", "legal", "check", "accept", "signed", "chase"]) {
    const path = join(dir, "steps", `${step}.ts`);
    await writeFile(
      path,
      (await readFile(path, "utf8"))
        .replace(/^import type .*\n\n?/m, "")
        .replace(/: OfferStep<"\w+">/, ""),
    );
  }
  return dir;
}

it("checks a wizard's folder: the map, the compile, the types, and its tests", async () => {
  const dir = await copyOf("offer");
  const cases = JSON.parse(
    await readFile(new URL("../test/offer.cases.json", import.meta.url), "utf8"),
  );
  await writeFile(join(dir, "tests.json"), JSON.stringify(cases.slice(0, 3)));
  const found = await checkDir(dir);
  expect(found.issues).toEqual([]);
  expect(found.tests?.map((t) => t.ok)).toEqual([true, true, true]);
  expect(found.untaken).toContain("legal > offer"); // three tests do not take every edge
  expect(found.ok).toBe(true);
  expect(await readFile(join(dir, "wizard.d.ts"), "utf8")).toBe(
    typesOf(JSON.parse(await readFile(join(dir, "wizard.json"), "utf8"))),
  );
});

it("says what is wrong, and where", async () => {
  const dir = await copyOf("offer");
  await writeFile(
    join(dir, "steps", "legal.ts"),
    'import { readFileSync } from "node:fs";\nexport default async () => ({ value: readFileSync("/etc/hosts", "utf8"), to: "check" });\n',
  );
  const broken = await checkDir(dir, { writeTypes: false });
  expect(broken.ok).toBe(false);
  expect(broken.issues.join("\n")).toMatch(/legal\.ts:1: .*node:fs/);

  const dir2 = await copyOf("offer");
  await writeFile(join(dir2, "steps", "extra.ts"), "export default async () => ({});\n");
  expect((await checkDir(dir2, { writeTypes: false })).issues).toEqual([
    "No way leads to steps/extra.",
  ]);
});

it("writes the input and the ways of each step as types", () => {
  const types = typesOf(
    JSON.parse(
      JSON.stringify({
        title: "T",
        input: {
          fields: [
            { id: "customer", kind: "text", required: true },
            { id: "budget", kind: "number" },
            { id: "plan", kind: "select", options: ["small", "large"] },
            {
              id: "items",
              kind: "items",
              columns: [
                { id: "name", kind: "text" },
                { id: "price", kind: "money" },
              ],
            },
          ],
        },
        start: "a",
        edges: { a: ["b", "end"], b: ["end"] },
      }),
    ),
  );
  expect(types).toContain('"customer": string;');
  expect(types).toContain('"budget"?: number;');
  expect(types).toContain('"plan"?: "small" | "large";');
  expect(types).toContain('"items"?: { "name": string; "price": number }[];');
  expect(types).toContain('"a": "b" | "end";');
});
