import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWizard } from "@engenty/wizards-shared/definition";
import type { RunView } from "@engenty/wizards-shared/run";
import type { ShareOverview, SharePreview } from "@engenty/wizards-shared/sharing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-sharing-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
// The test's mail server listens on the loopback interface.
process.env.ALLOW_PRIVATE_FETCH = "1";

const ORIGIN = "http://localhost:5181";
const TENANT = "local";
const VISITOR = "wz_vid=visitor-1";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let env: typeof import("../src/env").env;

interface Mail {
  to: string[];
  data: string;
}

/** An SMTP server that takes every mail and refuses the password "wrong". */
function mailServer(): Promise<{ server: Server; port: number; mails: Mail[] }> {
  const mails: Mail[] = [];
  const wrong = Buffer.from("\0me@example.com\0wrong").toString("base64");
  const server = createServer((socket) => {
    let reading = false;
    let buffer = "";
    let mail: Mail = { to: [], data: "" };
    socket.write("220 test ESMTP\r\n");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (reading) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) {
            return;
          }
          const slow = mail.to.includes("slow@example.com");
          mails.push({ ...mail, data: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5);
          mail = { to: [], data: "" };
          reading = false;
          // A mail to "slow@…" is accepted late: time for a job to be stopped meanwhile.
          setTimeout(() => socket.write("250 ok\r\n"), slow ? 1500 : 0);
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl === -1) {
          return;
        }
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const command = line.toUpperCase();
        if (command.startsWith("EHLO")) {
          socket.write("250-test\r\n250-AUTH PLAIN\r\n250 SIZE 30000000\r\n");
        } else if (command.startsWith("AUTH")) {
          socket.write(line.includes(wrong) ? "535 denied\r\n" : "235 ok\r\n");
        } else if (command.startsWith("RCPT TO")) {
          mail.to.push(line.match(/<(.+)>/)?.[1] ?? "");
          socket.write("250 ok\r\n");
        } else if (command === "DATA") {
          reading = true;
          socket.write("354 go\r\n");
        } else if (command === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port, mails });
    });
  });
}

const definition = (share?: unknown) => ({
  version: 1,
  title: "Monatsbericht",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "start",
      type: "page",
      title: "Start",
      fields: [{ id: "email", kind: "email", label: "E-Mail" }],
    },
    {
      id: "write",
      type: "agent",
      title: "Text",
      instructions: "Schreibe für {{email}}",
      tools: [],
      output: { format: "markdown" },
    },
    {
      id: "done",
      type: "result",
      title: "Fertig",
      message: "Hier ist dein Bericht.",
      deliverables: [{ from: "write", label: "Bericht", formats: ["md", "txt"] }],
      ...(share ? { share } : {}),
    },
  ],
});

let smtp: Awaited<ReturnType<typeof mailServer>>;
let member = "";

/** A finished run of a wizard with this result, belonging to the test's visitor. */
async function finishedRun(id: string, share?: unknown): Promise<string> {
  const wizards = await import("../src/services/wizards");
  const control = await import("../src/tenants/control");
  const parsed = parseWizard(definition(share));
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.issues));
  }
  await client.withTenant(TENANT, async () => {
    const wizard = await wizards.createWizard("local", { definition: parsed.wizard });
    await client.db.insert(client.schema.run).values({
      id,
      wizardId: wizard.id,
      tenantId: TENANT,
      definition: parsed.wizard,
      files: [],
      version: null,
      mode: "live",
      visitorId: "visitor-1",
      status: "done",
      cursor: "done",
      state: {
        values: { email: "kundin@example.com" },
        outputs: { write: { text: "# Bericht\n\nAlles im Plan.", at: new Date().toISOString() } },
        history: ["start"],
        notes: {},
      },
    });
    await control.indexRun({ runId: id, visitorId: "visitor-1" });
  });
  return id;
}

const call = async <T>(path: string, cookie: string, body?: unknown) => {
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as T };
};

/** The run's view once its share job has stopped working. */
async function settled(runId: string): Promise<NonNullable<RunView["shareJob"]>> {
  for (let i = 0; i < 100; i++) {
    const { body } = await call<RunView>(`/api/runs/${runId}`, VISITOR);
    if (body.shareJob && body.shareJob.status !== "running") {
      return body.shareJob;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the share job did not finish");
}

beforeAll(async () => {
  smtp = await mailServer();
  client = await import("../src/db/client");
  await client.migrateControlDb();
  env = (await import("../src/env")).env;
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(`${ORIGIN}/api/local/enter?k=test-key`));
  member = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
}, 60_000);

afterAll(() => {
  smtp.server.close();
});

describe("share targets", () => {
  it("offers a visitor the targets that need no model, the owner also the ones an agent drives", async () => {
    const runId = await finishedRun("run-offer");
    const visitor = await call<ShareOverview>(`/api/runs/${runId}/share/targets`, VISITOR);
    expect(visitor.status).toBe(200);
    const ids = visitor.body.targets.map((t) => t.target);
    expect(ids).toContain("email");
    expect(ids).toContain("storage:s3");
    expect(visitor.body.targets.every((t) => !t.agent)).toBe(true);
    // No OAuth client is configured here: Slack and Drive cannot be connected, so they are not offered.
    expect(ids).not.toContain("slack");
    expect(ids).not.toContain("storage:google-drive");

    const email = visitor.body.targets.find((t) => t.target === "email");
    expect(email?.connection?.connectors.map((c) => c.id)).toEqual(["smtp"]);
    expect(email?.connection?.account).toBeNull();
    expect(email?.fields.find((f) => f.id === "subject")?.value).toBe("Fertig · Monatsbericht");
    expect(email?.fields.find((f) => f.id === "message")?.value).toBe("Hier ist dein Bericht.");

    const owner = await call<ShareOverview>(`/api/runs/${runId}/share/targets?lang=en`, member);
    const browser = owner.body.targets.find((t) => t.target === "browser");
    if (browser) {
      expect(browser.agent).toBe(true);
      expect(browser.presets.map((p) => p.label)).toContain("LinkedIn");
      expect(browser.name).toBe("Website");
    }
    expect(owner.body.targets.find((t) => t.target === "email")?.name).toBe("Email");
  });

  it("shows nobody else the targets of a run", async () => {
    const runId = await finishedRun("run-private");
    const stranger = await call(`/api/runs/${runId}/share/targets`, "wz_vid=someone-else");
    expect(stranger.status).toBe(404);
  });

  it("takes the targets, names and prefilled values a wizard's result lists", async () => {
    const runId = await finishedRun("run-listed", [
      { target: "email", label: "An mich senden", values: { to: "{{email}}", subject: "Für {{email}}" } },
      { target: "browser", label: "Auf LinkedIn posten", values: { url: "https://www.linkedin.com/feed/" } },
      { target: "storage:google-drive" },
    ]);
    const { body } = await call<ShareOverview>(`/api/runs/${runId}/share/targets`, VISITOR);
    const email = body.targets[0];
    expect(email.key).toBe("0:email");
    expect(email.name).toBe("An mich senden");
    expect(email.fields.find((f) => f.id === "to")?.value).toBe("kundin@example.com");
    expect(email.fields.find((f) => f.id === "subject")?.value).toBe("Für kundin@example.com");
    // A listed target an agent drives is offered to a visitor too; one that is not set up is left out.
    expect(body.targets.map((t) => t.target)).not.toContain("storage:google-drive");
    const browser = body.targets.find((t) => t.target === "browser");
    if (browser) {
      expect(browser.key).toBe("1:browser");
      expect(browser.name).toBe("Auf LinkedIn posten");
    }
  });

  it("offers nothing where the result lists no target", async () => {
    const runId = await finishedRun("run-none", []);
    const { body } = await call<ShareOverview>(`/api/runs/${runId}/share/targets`, member);
    expect(body.targets).toEqual([]);
  });
});

describe("sharing by e-mail", () => {
  it("sends from the mailbox the person connects, with the picked files attached", async () => {
    const runId = await finishedRun("run-mail");
    const request = {
      target: "email",
      items: [{ from: "write", format: "md" }],
      values: { to: "a@example.com, b@example.com", subject: "Bericht März", message: "Anbei." },
    };

    // Without a connected mailbox the job does not start.
    const early = await call<{ fields: Record<string, string> }>(
      `/api/runs/${runId}/share/jobs`,
      VISITOR,
      request,
    );
    expect(early.status).toBe(422);
    expect(early.body.fields._account).toBeTruthy();

    const connect = (password: string) =>
      call<{ label?: string; error?: string }>(
        `/api/runs/${runId}/connections/${encodeURIComponent("share:email")}/credentials/smtp`,
        VISITOR,
        { values: { email: "me@example.com", password, host: "127.0.0.1", port: String(smtp.port) } },
      );
    expect((await connect("wrong")).status).toBe(422);
    const connected = await connect("secret");
    expect(connected.status).toBe(200);
    expect(connected.body.label).toBe("me@example.com");

    const overview = await call<ShareOverview>(`/api/runs/${runId}/share/targets`, VISITOR);
    expect(overview.body.targets[0].connection?.account?.label).toBe("me@example.com");

    const bad = await call<{ fields: Record<string, string> }>(
      `/api/runs/${runId}/share/jobs`,
      VISITOR,
      { ...request, values: { ...request.values, to: "not an address" } },
    );
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.fields)).toEqual(["to"]);

    const started = await call<{ status: string }>(`/api/runs/${runId}/share/jobs`, VISITOR, request);
    expect(started.status).toBe(200);
    const job = await settled(runId);
    expect(job.error).toBeNull();
    expect(job.status).toBe("done");
    expect(job.result?.summary).toBe("Sent to a@example.com, b@example.com");

    const mail = smtp.mails.at(-1);
    expect(mail?.to).toEqual(["a@example.com", "b@example.com"]);
    expect(mail?.data).toMatch(/Subject: =\?UTF-8\?Q\?Bericht_M=C3=A4rz\?=/);
    expect(mail?.data).toContain("From: me@example.com");
    expect(mail?.data).toContain("monatsbericht-bericht.md");
    expect(mail?.data).toContain("Anbei.");

    const after = await call<ShareOverview>(`/api/runs/${runId}/share/targets`, VISITOR);
    expect(after.body.jobs[0]).toMatchObject({ target: "email", status: "done", name: "Email" });
  });

  it("refuses a file the result does not offer", async () => {
    const runId = "run-mail";
    await call(`/api/runs/${runId}/share/jobs`, VISITOR, {
      target: "email",
      items: [{ from: "write", format: "pdf" }],
      values: { to: "a@example.com", subject: "x" },
    });
    const job = await settled(runId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("not part of this result");
  });

  it("sends from the server's own address without an account, a few times per run for a visitor", async () => {
    env.mail.smtpUrl = `smtp://127.0.0.1:${smtp.port}`;
    env.mail.from = "wizards@example.com";
    try {
      const runId = await finishedRun("run-server-mail");
      const overview = await call<ShareOverview>(`/api/runs/${runId}/share/targets`, VISITOR);
      expect(overview.body.targets.find((t) => t.target === "email")?.connection).toBeNull();
      const send = async () => {
        const started = await call(`/api/runs/${runId}/share/jobs`, VISITOR, {
          target: "email",
          items: [{ from: "write", format: "txt" }],
          values: { to: "kundin@example.com", subject: "Dein Bericht" },
        });
        expect(started.body).toMatchObject({ status: "running" });
        return settled(runId);
      };
      const before = smtp.mails.length;
      for (let i = 0; i < 3; i++) {
        expect((await send()).status).toBe("done");
      }
      expect(smtp.mails.length).toBe(before + 3);
      expect(smtp.mails.at(-1)?.data).toContain("From: wizards@example.com");
      const fourth = await send();
      expect(fourth.status).toBe("failed");
      expect(smtp.mails.length).toBe(before + 3);
    } finally {
      env.mail.smtpUrl = "";
      env.mail.from = "";
    }
  });
});

describe("a share job", () => {
  it("is one at a time per run and can be stopped", async () => {
    const runId = "run-mail";
    const request = {
      target: "email",
      items: [],
      values: { to: "slow@example.com", subject: "Langsam" },
    };
    const started = await call<{ id: string; status: string }>(
      `/api/runs/${runId}/share/jobs`,
      VISITOR,
      request,
    );
    expect(started.body.status).toBe("running");
    const second = await call(`/api/runs/${runId}/share/jobs`, VISITOR, request);
    expect(second.status).toBe(400);

    const during = await call<RunView>(`/api/runs/${runId}`, VISITOR);
    expect(during.body.shareJob).toMatchObject({ id: started.body.id, status: "running" });

    await call(`/api/runs/${runId}/share/jobs/${started.body.id}/cancel`, VISITOR, {});
    const job = await settled(runId);
    expect(job).toMatchObject({ id: started.body.id, status: "cancelled", result: null });
    // What the mail server answers afterwards changes nothing.
    await new Promise((r) => setTimeout(r, 1800));
    expect((await settled(runId)).status).toBe("cancelled");
  });

  it("names a result of the run as a file for agents", async () => {
    const { parseResultRef } = await import("../src/sharing/files");
    expect(parseResultRef("result:write.md")).toEqual({ from: "write", format: "md" });
    expect(parseResultRef("result:lists.providers.xlsx")).toEqual({
      from: "lists.providers",
      format: "xlsx",
    });
    expect(parseResultRef("result:write.exe")).toBeNull();
    expect(parseResultRef("invoices/2026/a.pdf")).toBeNull();

    const tools = await import("../src/tools/store");
    const file = await client.withTenant(TENANT, async () => {
      const run = await client.db.query.run.findFirst({
        where: (r, { eq }) => eq(r.id, "run-mail"),
      });
      return tools.resolveFile(
        {
          def: run!.definition,
          state: run!.state,
          store: { wizardId: run!.wizardId, holder: "v:visitor-1" },
          runId: run!.id,
        } as never,
        "result:write.txt",
      );
    });
    expect(file.name).toBe("monatsbericht-bericht.txt");
    expect(new TextDecoder().decode(file.data)).toContain("Alles im Plan.");
  });
});

describe("share options in a wizard", () => {
  it("names targets the validator knows and templates that exist", () => {
    const ok = parseWizard(
      definition([
        { target: "email", values: { to: "{{email}}", message: "{{steps.write}}" } },
        { target: "connector:notion" },
      ]),
    );
    expect(ok.ok && ok.issues).toEqual([]);
    const bad = parseWizard(
      definition([{ target: "fax" }, { target: "email", values: { to: "{{phone}}" } }]),
    );
    expect(bad.ok && bad.issues.map((i) => i.message)).toEqual([
      expect.stringContaining('Unknown share target "fax"'),
      expect.stringContaining('"{{phone}}" refers to a field that is not asked'),
    ]);
  });
});

/** A wizard with this result; with `tested`, a finished test run of it. */
async function draftWizard(share: unknown, tested?: string): Promise<string> {
  const wizards = await import("../src/services/wizards");
  const parsed = parseWizard(definition(share));
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.issues));
  }
  return client.withTenant(TENANT, async () => {
    const wizard = await wizards.createWizard("local", { definition: parsed.wizard });
    if (tested) {
      await client.db.insert(client.schema.run).values({
        id: tested,
        wizardId: wizard.id,
        tenantId: TENANT,
        definition: parsed.wizard,
        files: [],
        version: null,
        mode: "test",
        status: "done",
        cursor: "done",
        state: {
          values: { email: "kundin@example.com" },
          outputs: { write: { text: "# Bericht\n\nAlles im Plan.", at: new Date().toISOString() } },
          history: ["start"],
          notes: {},
        },
      });
    }
    return wizard.id;
  });
}

describe("the editor's preview of a result", () => {
  it("fills the listed targets from the last test run and names what is left out", async () => {
    const id = await draftWizard(
      [
        { target: "email", label: "An mich", values: { to: "{{email}}", message: "Grüße, {{brand.name}}" } },
        { target: "storage:google-drive" },
      ],
      "run-preview",
    );
    const { status, body } = await call<SharePreview>(
      `/api/studio/wizards/${id}/share-preview?lang=en`,
      member,
    );
    expect(status).toBe(200);
    expect(body.run?.id).toBe("run-preview");
    expect(body.targets.map((t) => t.key)).toEqual(["0:email"]);
    const email = body.targets[0];
    expect(email.name).toBe("An mich");
    expect(email.fields.find((f) => f.id === "to")?.value).toBe("kundin@example.com");
    // The space has no name yet: the placeholder comes out empty, and the preview says which.
    expect(email.empty).toEqual(["brand.name"]);
    // Drive has no OAuth client here: nobody gets it.
    expect(body.left.map((l) => l.why)).toEqual(["setup"]);
    expect(body.outputs.write).toBe("# Bericht\n\nAlles im Plan.");
  });

  it("gives a visitor the default targets that need no agent, the owner all of them", async () => {
    const id = await draftWizard(undefined);
    const visitor = await call<SharePreview>(`/api/studio/wizards/${id}/share-preview`, member);
    expect(visitor.body.run).toBeNull();
    expect(visitor.body.outputs).toEqual({});
    expect(visitor.body.targets.map((t) => t.target)).toContain("email");
    expect(visitor.body.targets.every((t) => !t.agent)).toBe(true);
    expect(visitor.body.left).toContainEqual({ name: "Slack", why: "setup" });
    const owner = await call<SharePreview>(
      `/api/studio/wizards/${id}/share-preview?as=owner`,
      member,
    );
    const agents = owner.body.targets.filter((t) => t.agent).map((t) => t.name);
    for (const name of agents) {
      expect(visitor.body.left).toContainEqual({ name, why: "agent" });
    }
  });
});
