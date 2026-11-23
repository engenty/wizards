import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentPages, FillRefused, installedChrome } from "./index.js";

// A real Chrome: these run where one is installed (a Mac with Chrome) and are skipped elsewhere.
describe.skipIf(!installedChrome())("AgentPages", () => {
  let site: Server;
  let other: Server;
  let siteUrl = "";
  let otherUrl = "";
  const pages = new AgentPages();
  const typed: string[] = [];

  const serve = (html: (other: string) => string) =>
    createServer((req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          typed.push(body);
          res.end("<p>Signed in</p>");
        });
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(html(otherUrl));
    });

  beforeAll(async () => {
    other = serve(() => '<form><label>Code <input name="code"></label></form>');
    site = serve(
      (o) =>
        `<form method="post"><label>Email <input name="u"></label><label>Password <input type="password" name="p"></label><button>Sign in</button></form><iframe src="${o}" title="other"></iframe>`,
    );
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await pages.close();
    site.close();
    other.close();
  });

  const tool = (name: string) => {
    const found = pages.tools().find((t) => t.name === name);
    if (!found) throw new Error(name);
    return found;
  };

  it("offers no tool that runs the model's JavaScript", () => {
    expect(pages.tools().map((t) => t.name)).not.toContain("browser_evaluate");
  });

  it("fills a field on the expected website, and refuses another website and a frame of one", async () => {
    await tool("browser_open").run("t1", { url: siteUrl });
    const { snapshot } = (await tool("browser_snapshot").run("t1", {})) as { snapshot: string };
    const ref = (name: string) => new RegExp(`${name}"? (@e\\d+)`).exec(snapshot)?.[1] as string;
    expect(await pages.url("t1")).toBe(`${siteUrl}/`);

    await expect(pages.fillPrivately("t1", ref("Password"), "pw", otherUrl)).rejects.toThrow(
      FillRefused,
    );

    const frameField = /textbox "Code" (@e\d+)/.exec(snapshot)?.[1];
    if (frameField)
      await expect(pages.fillPrivately("t1", frameField, "123456", siteUrl)).rejects.toThrow(
        /another website/,
      );

    await pages.fillPrivately("t1", ref("Email"), "ada@example.com", siteUrl);
    await pages.fillPrivately("t1", ref("Password"), "s3cret-pass", siteUrl);
    await pages.click("t1", ref("Sign in"));
    await tool("browser_wait").run("t1", { text: "Signed in" });
    expect(typed.at(-1)).toBe("u=ada%40example.com&p=s3cret-pass");
  }, 60_000);
});
