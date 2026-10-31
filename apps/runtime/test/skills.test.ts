import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Skills of a space: behind their switch; written, uploaded or added from skills.sh; always on
// in a step's instructions or read on demand with skill_load; refused past their limits; their
// scripts in a step's sandbox once someone switched them on.

const dir = mkdtempSync(join(tmpdir(), "wizards-skills-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "skills=off";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let client: typeof import("../src/db/client");

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>;
const upload = (name: string, data: Uint8Array) => {
  const form = new FormData();
  form.set("file", new File([data], name));
  return app.fetch(
    new Request(url(`/api/studio/spaces/${spaceId}/skills/upload`), {
      method: "POST",
      headers: { cookie, origin: "http://localhost:5181" },
      body: form,
    }),
  );
};
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);

/** What skills.sh holds in this test: its search and its registry items. */
const registry: Record<string, { path: string; content: string | null }[]> = {
  "anthropics/skills/pdf": [
    {
      path: "SKILL.md",
      content:
        "---\nname: pdf\ndescription: >\n  Use this skill whenever the user wants\n  to do anything with PDF files.\nlicense: Proprietary\n---\n\n# PDF\n\nRead forms.md for forms.\n",
    },
    { path: "forms.md", content: "# Forms\n\nFill the fields." },
    { path: "scripts/fill.py", content: "print('fill')" },
    { path: "assets/logo.png", content: "\u0000PNG" },
    { path: "assets/font.ttf", content: null },
  ],
  "someone/tools/brandkit": [
    { path: "SKILL.md", content: '---\nname: brandkit\ndescription: "A brand kit"\n---\nBody.' },
  ],
};
let searched = 0;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (address.startsWith("https://skills.sh/api/search")) {
      searched++;
      return Response.json({
        skills: Object.keys(registry).map((id) => ({
          id,
          source: id.split("/").slice(0, 2).join("/"),
          skillId: id.split("/")[2],
          name: id.split("/")[2],
          installs: 1000,
        })),
      });
    }
    if (address.startsWith("https://skills.sh/r/")) {
      const ref = address.slice("https://skills.sh/r/".length);
      const files = registry[ref];
      return files
        ? Response.json({ name: ref.split("/")[2], files })
        : new Response("not found", { status: 404 });
    }
    return realFetch(input, init);
  });
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("SKILL.md", () => {
  it("reads the front matter skills use: plain, quoted, folded, lists and maps", async () => {
    const { parseSkillMd, skillMd } = await import("@engenty/wizards-shared/skills");
    const read = parseSkillMd(
      [
        "---",
        "name: brand-voice",
        "description: >-",
        "  How we write:",
        "  short and warm.",
        "license: 'Apache-2.0'",
        "allowed-tools: [Read, Grep]",
        "metadata:",
        "  version: \"1.2\"",
        "  author: engenty",
        "---",
        "",
        "# Voice",
      ].join("\n"),
    );
    expect(read).toEqual({
      name: "brand-voice",
      description: "How we write: short and warm.",
      body: "# Voice",
      meta: {
        license: "Apache-2.0",
        "allowed-tools": ["Read", "Grep"],
        metadata: { version: "1.2", author: "engenty" },
      },
    });
    // Written back, it reads the same.
    expect(parseSkillMd(skillMd(read))).toEqual(read);
    expect(() => parseSkillMd("# no front matter")).toThrow(/frontmatter/);
    expect(() => parseSkillMd("---\nname: x\n---\n")).toThrow(/description/);
  });
});

describe("the switch", () => {
  it("keeps skills away while it is off", async () => {
    expect((await send("GET", `/api/studio/spaces/${spaceId}/skills`)).status).toBe(404);
    const { activeSkills } = await import("../src/services/skills");
    await local(async () => {
      const { insertSkill } = await import("../src/services/skills");
      await insertSkill(
        spaceId,
        { name: "hidden", description: "Hidden.", body: "Never shown.", meta: {}, files: [], blobFiles: [] },
        { source: "own", mode: "always" },
      );
      expect(await activeSkills(spaceId)).toEqual({ always: [], demand: [] });
    });
    process.env.FEATURES = "skills=on";
    expect((await send("GET", `/api/studio/spaces/${spaceId}/skills`)).status).toBe(200);
    const listed = await json(send("GET", `/api/studio/spaces/${spaceId}/skills`));
    const hidden = listed.skills.find((s: any) => s.name === "hidden");
    await send("DELETE", `/api/studio/skills/${hidden.id}`);
  });
});

describe("own skills", () => {
  let id = "";

  it("are written, renamed, and edited as a whole SKILL.md", async () => {
    const made = await json(
      send("POST", `/api/studio/spaces/${spaceId}/skills`, {
        name: "tonalitaet",
        description: "So schreiben wir.",
        body: "# Tonalität\n\nPer du.",
      }),
    );
    id = made.id;
    expect(made.name).toBe("tonalitaet");
    // The same name again gets the next free one.
    const again = await json(
      send("POST", `/api/studio/spaces/${spaceId}/skills`, { name: "tonalitaet", description: "x" }),
    );
    expect(again.name).toBe("tonalitaet-2");
    await send("DELETE", `/api/studio/skills/${again.id}`);

    const bad = await send("PATCH", `/api/studio/skills/${id}`, { name: "Not Valid" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/lower-case/);

    const res = await send("PATCH", `/api/studio/skills/${id}`, {
      skillMd: "---\nname: voice\ndescription: How we write.\nlicense: MIT\n---\n\n# Voice\n\nShort.",
    });
    expect(res.status).toBe(200);
    const skill = await json(send("GET", `/api/studio/skills/${id}`));
    expect(skill).toMatchObject({
      name: "voice",
      description: "How we write.",
      body: "# Voice\n\nShort.",
      meta: { license: "MIT" },
      source: "own",
      mode: "demand",
    });
  });

  it("hold text files at paths inside their folder", async () => {
    expect(
      (
        await send("PATCH", `/api/studio/skills/${id}`, {
          files: [{ path: "../escape.md", text: "x" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("PATCH", `/api/studio/skills/${id}`, {
          files: [{ path: "image.png", text: "x" }],
        })
      ).status,
    ).toBe(400);
    const ok = await send("PATCH", `/api/studio/skills/${id}`, {
      files: [{ path: "references/examples.md", text: "Good: short." }],
    });
    expect(ok.status).toBe(200);
  });

  it("are always on at most five, with 20,000 characters together", async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const made = await json(
        send("POST", `/api/studio/spaces/${spaceId}/skills`, {
          name: `rule-${n}`,
          description: `Rule ${n}.`,
          body: "x".repeat(n === 5 ? 19_700 : 100),
          mode: n === 5 ? "demand" : "always",
        }),
      );
      ids.push(made.id);
    }
    const tooLong = await send("PATCH", `/api/studio/skills/${ids[4]}`, { mode: "always" });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toMatch(/20,000 characters/);
    await send("PATCH", `/api/studio/skills/${ids[4]}`, { body: "short" });
    expect((await send("PATCH", `/api/studio/skills/${ids[4]}`, { mode: "always" })).status).toBe(200);
    const sixth = await send("PATCH", `/api/studio/skills/${id}`, { mode: "always" });
    expect(sixth.status).toBe(400);
    expect((await sixth.json()).error).toMatch(/At most 5/);
    for (const x of ids) {
      await send("DELETE", `/api/studio/skills/${x}`);
    }
  });

  it("download as a zip of their folder", async () => {
    const res = await send("GET", `/api/studio/skills/${id}/zip`);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["voice/SKILL.md", "voice/references/examples.md"]);
    expect(strFromU8(files["voice/SKILL.md"])).toMatch(/^---\nname: voice\ndescription: How we write\./);
  });
});

describe("uploads", () => {
  it("take a SKILL.md", async () => {
    const res = await upload(
      "SKILL.md",
      strToU8("---\nname: catering\ndescription: Wie wir ein Angebot aufbauen.\n---\n# Angebot"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("catering");
  });

  it("take a zip's folder, files that are not text kept for scripts", async () => {
    const zip = zipSync({
      "__MACOSX/._x": strToU8("junk"),
      "angebot/SKILL.md": strToU8("---\nname: angebot\ndescription: Angebote.\n---\nBody"),
      "angebot/references/menu.md": strToU8("# Menü"),
      "angebot/assets/photo.jpg": new Uint8Array([0xff, 0xd8, 0x00, 0x01]),
      "angebot/.hidden.md": strToU8("hidden"),
    });
    const res = await upload("angebot.skill", zip);
    expect(res.status).toBe(200);
    const made = await res.json();
    expect(made.skipped).toEqual([]);
    const skill = await json(send("GET", `/api/studio/skills/${made.id}`));
    expect(skill).toMatchObject({ source: "upload", runScripts: false, files: 2 });
    expect(skill.fileList).toEqual([{ path: "references/menu.md", text: "# Menü" }]);
    expect(skill.blobList).toEqual([
      { path: "assets/photo.jpg", hash: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: 4 },
    ]);
    // The zip to download carries them, byte for byte.
    const downloaded = unzipSync(
      new Uint8Array(await (await send("GET", `/api/studio/skills/${made.id}/zip`)).arrayBuffer()),
    );
    expect([...downloaded["angebot/assets/photo.jpg"]]).toEqual([0xff, 0xd8, 0x00, 0x01]);
  });

  it("leave out files for scripts past their limits", async () => {
    const zip = zipSync({
      "big/SKILL.md": strToU8("---\nname: big\ndescription: Big.\n---\nBody"),
      "big/a.bin": new Uint8Array(4_000_000),
      "big/b.bin": new Uint8Array(4_000_000).fill(1),
      "big/c.bin": new Uint8Array(4_000_000).fill(2),
      "big/d.bin": new Uint8Array(4_000_000).fill(3),
      "big/e.bin": new Uint8Array(4_000_000).fill(4),
      "big/f.bin": new Uint8Array(4_000_000).fill(5),
    });
    const made = await json(upload("big.zip", zip));
    expect(made.skipped).toEqual([{ path: "f.bin", reason: "size" }]);
    const skill = await json(send("GET", `/api/studio/skills/${made.id}`));
    expect(skill.blobList).toHaveLength(5);
    await send("DELETE", `/api/studio/skills/${made.id}`);
  });

  it("refuse what is no skill", async () => {
    const none = await upload("x.zip", zipSync({ "README.md": strToU8("hi") }));
    expect(none.status).toBe(400);
    expect((await none.json()).error).toMatch(/no SKILL\.md/);
    expect((await upload("x.pdf", strToU8("%PDF"))).status).toBe(400);
  });
});

describe("skills.sh", () => {
  let id = "";

  it("finds skills, marks the official ones and the ones the space has", async () => {
    const { hits } = await json(send("GET", `/api/studio/spaces/${spaceId}/skills/registry?q=pdf`));
    expect(hits).toEqual([
      expect.objectContaining({ ref: "anthropics/skills/pdf", official: true, added: false }),
      expect.objectContaining({ ref: "someone/tools/brandkit", official: false }),
    ]);
    const before = searched;
    await send("GET", `/api/studio/spaces/${spaceId}/skills/registry?q=p`);
    expect(searched).toBe(before);
  });

  it("shows a skill whole before it is added", async () => {
    const preview = await json(
      send("GET", `/api/studio/spaces/${spaceId}/skills/registry/preview?ref=anthropics/skills/pdf`),
    );
    expect(preview).toMatchObject({
      name: "pdf",
      description: "Use this skill whenever the user wants to do anything with PDF files.",
      official: true,
      meta: { license: "Proprietary" },
    });
    expect(preview.fileList.map((f: any) => f.path)).toEqual(["forms.md", "scripts/fill.py"]);
    expect(preview.blobList).toEqual([{ path: "assets/logo.png", bytes: 4 }]);
    // A file skills.sh hands out without its content can't come along.
    expect(preview.skipped).toEqual([{ path: "assets/font.ttf", reason: "binary" }]);
  });

  it("adds a copy that only its update changes", async () => {
    const made = await json(
      send("POST", `/api/studio/spaces/${spaceId}/skills/registry`, {
        ref: "anthropics/skills/pdf",
        mode: "demand",
      }),
    );
    id = made.id;
    const skill = await json(send("GET", `/api/studio/skills/${id}`));
    expect(skill).toMatchObject({
      source: "skills.sh",
      origin: "anthropics/skills/pdf",
      official: true,
      runScripts: false,
    });
    const refused = await send("PATCH", `/api/studio/skills/${id}`, { body: "changed" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/Copy it as your own/);
    expect((await send("PATCH", `/api/studio/skills/${id}`, { mode: "off" })).status).toBe(200);

    expect((await json(send("GET", `/api/studio/skills/${id}/update`))).update).toBeNull();
    registry["anthropics/skills/pdf"][1].content = "# Forms\n\nFill every field.";
    const { update } = await json(send("GET", `/api/studio/skills/${id}/update`));
    expect(update.hash).not.toBe(skill.originHash);
    expect(
      (await send("POST", `/api/studio/skills/${id}/update`, { hash: "stale" })).status,
    ).toBe(409);
    expect(
      (await send("POST", `/api/studio/skills/${id}/update`, { hash: update.hash })).status,
    ).toBe(200);
    const after = await json(send("GET", `/api/studio/skills/${id}`));
    expect(after.fileList[0].text).toBe("# Forms\n\nFill every field.");
    expect(after.mode).toBe("off");
    expect(after.blobList.map((f: any) => f.path)).toEqual(["assets/logo.png"]);
  });

  it("runs its scripts only once someone switches them on, as the sync record carries", async () => {
    const on = await send("PATCH", `/api/studio/skills/${id}`, { runScripts: true });
    expect(on.status).toBe(200);
    expect((await json(send("GET", `/api/studio/skills/${id}`))).runScripts).toBe(true);
    const { KINDS } = await import("../src/sync/records");
    const read = await local(() => KINDS.skill.read(id));
    expect(read?.record).toMatchObject({ runScripts: true, blobFiles: [{ path: "assets/logo.png" }] });
    expect(KINDS.skill.blobs?.(read!.record)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });

  it("copies one as the space's own, to change", async () => {
    const copy = await json(send("POST", `/api/studio/skills/${id}/copy`));
    expect(copy.name).toBe("pdf-2");
    // A copy is a new skill: its scripts are off until someone switches them on for it.
    expect((await json(send("GET", `/api/studio/skills/${copy.id}`))).runScripts).toBe(false);
    expect((await send("PATCH", `/api/studio/skills/${copy.id}`, { body: "mine" })).status).toBe(200);
    await send("DELETE", `/api/studio/skills/${copy.id}`);
    await send("PATCH", `/api/studio/skills/${id}`, { mode: "demand" });
  });
});

describe("in a step", () => {
  it("stands whole when always on, by name on demand, and reads with skill_load and skill_read", async () => {
    const { skillsBlock, skillsOf, skillTools } = await import("../src/tools/skills");
    const listed = await json(send("GET", `/api/studio/spaces/${spaceId}/skills`));
    const voice = listed.skills.find((s: any) => s.name === "voice");
    await send("PATCH", `/api/studio/skills/${voice.id}`, { mode: "always" });
    const emitted: any[] = [];
    const ctx = {
      space: { id: spaceId },
      signal: new AbortController().signal,
      holder: { kind: "person", id: "local", role: "owner" },
      store: { holder: "u:local", wizardId: "w1" },
      emit: async (_type: string, message: unknown) => {
        emitted.push(message);
      },
    } as never;
    await local(async () => {
      const skills = await skillsOf(ctx);
      const block = skillsBlock(skills, { tools: true });
      expect(block).toContain('<skill name="voice">\n# Voice\n\nShort.');
      expect(block).toContain("references/examples.md");
      expect(block).toContain("# SKILLS ON DEMAND");
      expect(block).toContain(
        "- pdf: Use this skill whenever the user wants to do anything with PDF files.",
      );
      // A client that runs no tools gets the skills always on alone.
      expect(skillsBlock(skills, { tools: false })).not.toContain("ON DEMAND");

      const tools = await skillTools(ctx);
      expect(Object.keys(tools)).toEqual(["skill_load", "skill_read"]);
      expect(tools.skill_read.description).toContain("nothing runs them");
      const loaded = await tools.skill_load.execute({ name: "pdf" });
      expect(loaded).toMatchObject({ name: "pdf", files: ["forms.md", "scripts/fill.py"] });
      expect(loaded.folder).toBeUndefined();
      expect(loaded.instructions).toContain("Read forms.md for forms.");
      const file = await tools.skill_read.execute({ name: "pdf", path: "forms.md" });
      expect(file.text).toBe("# Forms\n\nFill every field.");
      expect((await tools.skill_read.execute({ name: "pdf", path: "nope.md" })).error).toMatch(
        /forms\.md/,
      );
      expect(emitted).toEqual([
        { code: "readsSkill", params: { name: "pdf" } },
        { code: "readsSkill", params: { name: "pdf/forms.md" } },
      ]);
    });
  });
});

describe("scripts in the sandbox", () => {
  /** A sandbox that keeps what is written to it. */
  const fakeSandbox = () => {
    const files = new Map<string, string | Uint8Array>();
    const commands: string[] = [];
    const sandbox = {
      capabilities: { commands: [], network: "none", uses: "", workdir: "/sandbox" },
      exec: async (command: string) => {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      writeFile: async (path: string, data: string | Uint8Array) => {
        files.set(path, data);
      },
      readFile: async () => new Uint8Array(),
      destroy: async () => undefined,
    };
    return { sandbox, files, commands };
  };
  const ctx = { space: { id: "" }, emit: async () => undefined };
  /** The owner, with the fake sandbox: a caller of the tool catalogue. */
  const testCaller = async (sandbox: unknown) => {
    const { personCaller } = await import("../src/elements/caller");
    return personCaller({
      space: { id: spaceId, name: "Test" },
      userId: "local",
      role: "owner",
      signal: new AbortController().signal,
      sandbox: { handle: () => sandbox as never, workdir: "/sandbox" },
    });
  };

  it("puts the folder of a skill whose scripts may run into the sandbox, once per run", async () => {
    const { skillsBlock, skillToolsOf } = await import("../src/tools/skills");
    const { activeSkills } = await import("../src/services/skills");
    const { sandbox, files, commands } = fakeSandbox();
    ctx.space.id = spaceId;
    await local(async () => {
      const skills = await activeSkills(spaceId);
      expect(skills.demand.find((k) => k.name === "pdf")?.runScripts).toBe(true);
      expect(skillsBlock(skills, { tools: true, sandbox: true })).toContain(
        "These skills bring scripts that run in the sandbox: pdf.",
      );
      expect(skillsBlock(skills, { tools: true })).not.toContain("scripts that run");

      const tools = skillToolsOf(skills, await testCaller(sandbox));
      expect(tools.skill_read.description).not.toContain("nothing runs them");
      const loaded = await tools.skill_load.execute({ name: "pdf" });
      expect(loaded).toMatchObject({
        folder: "/sandbox/skills/pdf",
        files: ["assets/logo.png", "forms.md", "scripts/fill.py"],
      });
      expect(loaded.scripts).toContain("python3 skills/pdf/scripts/<file>.py");
      expect([...files.keys()].sort()).toEqual([
        "skills/pdf/SKILL.md",
        "skills/pdf/assets/logo.png",
        "skills/pdf/forms.md",
        "skills/pdf/scripts/fill.py",
      ]);
      expect(files.get("skills/pdf/scripts/fill.py")).toBe("print('fill')");
      expect(String(files.get("skills/pdf/SKILL.md"))).toMatch(/^---\nname: pdf\n/);
      expect([...(files.get("skills/pdf/assets/logo.png") as Uint8Array)]).toEqual([
        0, 80, 78, 71,
      ]);
      expect(commands).toEqual(["rm -rf skills/pdf"]);

      // Loaded again in the same run, the folder is there already.
      await tools.skill_load.execute({ name: "pdf" });
      expect(commands).toHaveLength(1);
      expect(
        (await tools.skill_read.execute({ name: "pdf", path: "assets/logo.png" })).error,
      ).toMatch(/for the skill's scripts/);
    });
  });

  it("leaves a skill whose scripts are off as text, sandbox or not", async () => {
    const { skillToolsOf } = await import("../src/tools/skills");
    const { activeSkills } = await import("../src/services/skills");
    const listed = await json(send("GET", `/api/studio/spaces/${spaceId}/skills`));
    const pdf = listed.skills.find((s: any) => s.name === "pdf");
    await send("PATCH", `/api/studio/skills/${pdf.id}`, { runScripts: false });
    const { sandbox, files } = fakeSandbox();
    await local(async () => {
      const tools = skillToolsOf(await activeSkills(spaceId), await testCaller(sandbox));
      const loaded = await tools.skill_load.execute({ name: "pdf" });
      expect(loaded.folder).toBeUndefined();
      expect(loaded.files).toEqual(["forms.md", "scripts/fill.py"]);
      expect(files.size).toBe(0);
    });
  });

  it("says when the folder could not be written, and gives the instructions all the same", async () => {
    const { skillToolsOf } = await import("../src/tools/skills");
    const { activeSkills } = await import("../src/services/skills");
    const listed = await json(send("GET", `/api/studio/spaces/${spaceId}/skills`));
    const pdf = listed.skills.find((s: any) => s.name === "pdf");
    await send("PATCH", `/api/studio/skills/${pdf.id}`, { runScripts: true });
    const { sandbox } = fakeSandbox();
    sandbox.writeFile = async () => {
      throw new Error("disk full");
    };
    await local(async () => {
      const tools = skillToolsOf(await activeSkills(spaceId), await testCaller(sandbox));
      const loaded = await tools.skill_load.execute({ name: "pdf" });
      expect(loaded.instructions).toContain("Read forms.md for forms.");
      expect(loaded.folder).toBeUndefined();
      expect(loaded.scripts).toMatch(/disk full.*can't run/);
    });
  });
});
