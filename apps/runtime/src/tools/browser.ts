import { readFile } from "node:fs/promises";
import type { AssetRef, RunNote } from "@engenty-wizards/shared/run";
import { createTool } from "@mastra/core/tools";
import { generateText } from "ai";
import type { ElementHandle, Page } from "playwright-core";
import { z } from "zod";
import { type ClassifierClient, classifierClient } from "../browser/fast/classifier.js";
import type { FastLoopPage } from "../browser/fast/driver.js";
import { type FastLoopStep, runFastLoop } from "../browser/fast/run.js";
import { createFieldText } from "../browser/fast/text-helper.js";
import {
  nodeScript,
  PAGE_SCRIPT,
  type PageItem,
  type PageView,
  settleScript,
  targetScript,
} from "../browser/snapshot.js";
import type { StepContext } from "../engine/types.js";
import { env } from "../env.js";
import { costOf, textModel } from "../models.js";
import { assertPublicUrl } from "./net-guard.js";
import { attempt, type FileKeeper, imageOutput } from "./shared.js";

/** The page as an agent step reads it; retried while the page is between two documents. */
export async function readPage(page: Page): Promise<PageView> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const view = await page.evaluate<PageView | null>(PAGE_SCRIPT).catch(() => null);
    if (view) {
      return view;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url: page.url(),
    title: "",
    text: "",
    items: [],
    omitted: 0,
    scroll: { y: 0, height: 0, viewport: 0 },
  };
}

function line(item: PageItem): string {
  const parts = [`[${item.ref}]`, item.role, JSON.stringify(item.label)];
  if (item.kind === "fill") {
    parts.push(item.value ? `= ${JSON.stringify(item.value)}` : "(empty)");
  } else if (item.kind === "password") {
    parts.push(item.value ? "(filled)" : "(empty)");
  } else if (item.kind === "select") {
    const more = item.more_options ? ` | … ${item.more_options} more` : "";
    parts.push(
      `= ${JSON.stringify(item.value ?? "")}; options: ${(item.options ?? []).join(" | ")}${more}`,
    );
  }
  for (const key of ["checked", "selected", "expanded"] as const) {
    if (item[key] !== undefined) {
      parts.push(`${key}=${item[key]}`);
    }
  }
  if (item.dialog) {
    parts.push("(dialog)");
  }
  return parts.join(" ");
}

/**
 * The page as the model gets it: one line per control, named by its [number] — a dialog or
 * banner first, marked (dialog) — then the page's visible text.
 */
export function pageForModel(view: PageView) {
  const more = view.omitted
    ? `\n… ${view.omitted} more not listed: close what is open, scroll, or read the page again.`
    : "";
  return {
    url: view.url,
    title: view.title,
    elements: view.items.map(line).join("\n") + more,
    text: view.text,
    scroll: `${view.scroll.y} of ${view.scroll.height} px, ${view.scroll.viewport} px in view`,
  };
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** A wait that timed out is a rejection, so waits can be raced. */
function found<T>(wait: Promise<T>): Promise<T> {
  const p = wait.then((v) => v ?? Promise.reject(new Error("none")));
  p.catch(() => undefined);
  return p;
}

/**
 * Lets the page come to rest after an input: no DOM changes and no animation for a moment, or
 * the next document loaded where the input navigated.
 */
async function settle(page: Page) {
  await page.evaluate(settleScript(null)).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
}

/**
 * Fetches a URL with the browser's sign-in, outside any page. Page requests pass the context's
 * host guard; this one does not, so every redirect hop is checked here.
 */
async function signedInGet(page: Page, url: string) {
  let next = url;
  for (let hop = 0; hop < 6; hop++) {
    const safe = await assertPublicUrl(next);
    const res = await page
      .context()
      .request.get(safe.toString(), { timeout: 60_000, maxRedirects: 0 });
    const location = res.headers().location;
    if (res.status() < 300 || res.status() >= 400 || !location) {
      return res;
    }
    next = new URL(location, safe).toString();
  }
  throw new Error("Too many redirects.");
}

type Target = { x: number; y: number } | { error: string; by?: string };

/** Why a [number] cannot be used, for the model. */
function targetError(n: number, target: { error: string; by?: string }): string {
  switch (target.error) {
    case "covered":
      return `[${n}] is covered by "${target.by}". Deal with that first — a cookie or consent banner: click its least consent (only necessary / reject all).`;
    case "disabled":
      return `[${n}] is disabled right now.`;
    case "gone":
      return `[${n}] is not on the page any more. Use the numbers of the page below.`;
    default:
      return `[${n}] cannot be seen on the page.`;
  }
}

/**
 * Where to put the pointer for a [number]: scrolled into view and not covered by anything — so
 * a click never lands on whatever lies over it.
 */
function pointAt(page: Page, n: number): Promise<Target> {
  return page.evaluate<Target>(targetScript(n)).catch(() => ({ error: "gone" }));
}

/** The element a [number] names, for what Playwright does best (fill, select). */
async function handleOf(page: Page, n: number): Promise<ElementHandle<HTMLElement> | null> {
  const handle = await page.evaluateHandle<HTMLElement | null>(nodeScript(n)).catch(() => null);
  return (handle?.asElement() as ElementHandle<HTMLElement> | null) ?? null;
}

/** Clicks at a point; a tab the click opens is where the agent goes on. */
async function clickAt(ctx: StepContext, page: Page, point: { x: number; y: number }) {
  const opened: Page[] = [];
  const onPage = (p: Page) => {
    opened.push(p);
  };
  page.context().on("page", onPage);
  try {
    await page.mouse.click(point.x, point.y);
    await settle(page);
  } finally {
    page.context().off("page", onPage);
  }
  const popup = opened.at(-1);
  if (popup) {
    ctx.resources.adopt(popup);
    await popup.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    return popup;
  }
  return page;
}

const credentialField = z.object({
  ref: z.number().describe("The field's [number] from your latest page."),
  label: z.string().min(1).max(60).describe("What the person sees, e.g. E-Mail."),
  kind: z
    .enum(["username", "password", "otp", "text"])
    .describe("password only fills a password input."),
});

type FillError = "origin_changed" | "field_missing" | "not_an_input" | "not_a_password_field";

/**
 * Types the person's values into the page. A password goes only into a password input, and
 * only while the page is still the site the person was shown. Each field is marked as the
 * person's, so no reading of the page gives its value to a model. Failures are codes: a browser
 * error message could quote the value it failed to type.
 */
async function fillCredentials(
  page: Page,
  origin: string,
  fields: z.infer<typeof credentialField>[],
  values: Record<string, string>,
): Promise<{ filled: string[] } | { error: FillError | "fill_failed" }> {
  if (originOf(page.url()) !== origin) {
    return { error: "origin_changed" };
  }
  const filled: string[] = [];
  for (const [index, field] of fields.entries()) {
    const value = values[`field_${index + 1}`];
    if (typeof value !== "string" || !value) {
      continue;
    }
    const handle = await handleOf(page, field.ref);
    const element = handle
      ? await handle
          .evaluate((el) => ({ tag: el.tagName, type: (el as HTMLInputElement).type ?? "" }))
          .catch(() => null)
      : null;
    if (!(handle && element)) {
      return { error: "field_missing" };
    }
    if (element.tag !== "INPUT" && element.tag !== "TEXTAREA") {
      return { error: "not_an_input" };
    }
    if (field.kind === "password" && element.type !== "password") {
      return { error: "not_a_password_field" };
    }
    try {
      await handle.evaluate((el) => {
        const w = window as unknown as { __wzPersonal?: WeakSet<Element> };
        w.__wzPersonal ??= new WeakSet();
        w.__wzPersonal.add(el);
      });
      await handle.fill(value, { timeout: 10_000 });
    } catch {
      return { error: "fill_failed" };
    }
    filled.push(field.label);
  }
  return { filled };
}

const NOBODY =
  "Nobody is at the keyboard for this run, so a sign-in cannot be asked for. Go on without it and report what the person has to do.";
const DECLINED =
  "The person did not sign in. Do not ask again for this site; go on without it and say in your result what is missing and what the person can do.";
const TOOK_OVER =
  "The person took the browser over and has handed it back; nothing you asked for was done. The page may have changed — here it is as it stands now. Go on from here.";

const RUN_FAST_DESCRIPTION =
  "Hand a small, concrete browser sub-goal to the fast executor: on the CURRENT page it reads the visible controls, picks one element per step with a classifier (no language model), types field values taken from your goal, and repeats until the goal is visibly satisfied or it is unsure. Use it for mechanical sequences — click a cookie banner away, fill and submit a form, pick a date in a calendar, choose an autocomplete suggestion, set filters and dropdowns, open a matching result. Give one page's worth of work per call with every value spelled out (dates, names, filters); it never invents data. Returns status `done`, or `uncertain`/`blocked`/`budget`/`error` with the page and a note naming the step it could not decide. Then do THAT ONE step with the other browser_* tools and call browser_run_fast again with the same goal — do not finish the rest by hand. Open the page with browser_open first; it does not open URLs.";

/** One line of at most 60 characters, for the run's log. */
function short(text: string): string {
  const one = text.trim().replace(/\s+/g, " ");
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

/** What a step of the fast loop did, for the run's log. */
function fastStepNote(step: FastLoopStep): RunNote | null {
  const name = short(step.target_label ?? "");
  switch (step.operation) {
    case "CLICK":
      return name ? { code: "clicksOn", params: { name } } : { code: "clicks" };
    case "TYPE_TEXT":
      return { code: "types" };
    case "SELECT":
      return name ? { code: "selects", params: { option: name } } : null;
    case "SCROLL_UP":
    case "SCROLL_DOWN":
      return { code: "scrolls" };
    case "WAIT":
      return { code: "waitsForPage" };
    default:
      return null;
  }
}

export async function browserTools(ctx: StepContext, assets: AssetRef[], files: FileKeeper) {
  const page = () => ctx.resources.browserPage();
  const tools: Record<string, any> = {};
  /** What each [number] was called on the latest reading, for the run's log. */
  const names = new Map<number, string>();
  const read = async (p: Page) => {
    const view = await readPage(p);
    for (const item of view.items) {
      names.set(item.ref, item.label);
    }
    return pageForModel(view);
  };
  // There is one page. A model may ask for several browser actions at once; they run one after
  // the other, in the order asked — else a navigation would cut a download short.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T | { error: string }> => {
    const next = queue.then(() => attempt(run));
    queue = next;
    return next;
  };
  // While the person drives the browser, nothing the agent asks for happens; when they hand it
  // back, the agent gets the page as they left it instead.
  const acting = <T>(run: () => Promise<T>) =>
    inTurn(async () => {
      if (await ctx.resources.agentTurn(ctx.signal)) {
        return { note: TOOK_OVER, page: await read(await page()) };
      }
      return run();
    });
  const atRef = async (p: Page, n: number) => {
    const target = await pointAt(p, n);
    return "error" in target ? { error: targetError(n, target), page: await read(p) } : target;
  };

  tools.browser_open = createTool({
    id: "browser_open",
    description:
      "Open a URL in the browser and return the page: its controls, each with a [number], and its text. A cookie banner in the way: click its least consent (only necessary / reject all) first. Sites the person signed in to on an earlier run may still be signed in.",
    inputSchema: z.object({ url: z.string() }),
    execute: ({ url }) =>
      acting(async () => {
        const safe = await assertPublicUrl(url);
        // The page first, so whoever watches the browser on this line finds one.
        const p = await page();
        await ctx.emit("tool", { code: "opens", params: { name: safe.hostname } });
        await p.goto(safe.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
        await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        return read(p);
      }),
  });

  tools.browser_read = createTool({
    id: "browser_read",
    description:
      "Read the current page again: its controls with their [numbers] and its text. A number stays with its element as long as the element is on the page.",
    inputSchema: z.object({}),
    execute: () => acting(async () => read(await page())),
  });

  tools.browser_click = createTool({
    id: "browser_click",
    description:
      "Click an element by its [number]. It is scrolled into view first; a click on something covered by a banner or dialog is refused and names what covers it.",
    inputSchema: z.object({ ref: z.number() }),
    execute: ({ ref: n }) =>
      acting(async () => {
        const p = await page();
        const target = await atRef(p, n);
        if ("error" in target) {
          return target;
        }
        const name = short(names.get(n) ?? "");
        await ctx.emit("tool", name ? { code: "clicksOn", params: { name } } : { code: "clicks" });
        return read(await clickAt(ctx, p, target));
      }),
  });

  tools.browser_type = createTool({
    id: "browser_type",
    description:
      "Type text into a field by its [number], replacing what is in it; set submit to press Enter afterwards. Never for passwords or codes — those the person enters through browser_request_credentials.",
    inputSchema: z.object({ ref: z.number(), text: z.string(), submit: z.boolean().optional() }),
    execute: ({ ref: n, text, submit }) =>
      acting(async () => {
        const p = await page();
        const target = await atRef(p, n);
        if ("error" in target) {
          return target;
        }
        const el = await handleOf(p, n);
        if (!el) {
          return { error: targetError(n, { error: "gone" }), page: await read(p) };
        }
        if ((await el.evaluate((e) => (e as HTMLInputElement).type)) === "password") {
          return {
            error: `[${n}] is a password field: the person fills it through browser_request_credentials.`,
          };
        }
        const said = short(text);
        await ctx.emit(
          "tool",
          said ? { code: "typesText", params: { text: said } } : { code: "types" },
        );
        await el.fill(text, { timeout: 10_000 });
        if (submit) {
          await el.press("Enter");
        }
        await settle(p);
        return read(ctx.resources.openPage() ?? p);
      }),
  });

  tools.browser_select = createTool({
    id: "browser_select",
    description:
      "Choose an option in a dropdown (a select element) by its [number] and the option's name as the page lists it. For a dropdown the page draws itself (no options listed), click it open and click the option instead.",
    inputSchema: z.object({ ref: z.number(), option: z.string() }),
    execute: ({ ref: n, option }) =>
      acting(async () => {
        const p = await page();
        const target = await atRef(p, n);
        if ("error" in target) {
          return target;
        }
        const el = await handleOf(p, n);
        if (!el) {
          return { error: targetError(n, { error: "gone" }), page: await read(p) };
        }
        await ctx.emit("tool", { code: "selects", params: { option: short(option) } });
        const chosen =
          (await el.selectOption({ label: option }, { timeout: 5000 }).catch(() => null)) ??
          (await el.selectOption(option, { timeout: 5000 }).catch(() => null));
        if (!chosen?.length) {
          return { error: `[${n}] has no option "${option}".`, page: await read(p) };
        }
        await settle(p);
        return read(ctx.resources.openPage() ?? p);
      }),
  });

  tools.browser_scroll = createTool({
    id: "browser_scroll",
    description:
      "Scroll the page down or up by most of a screen, or bring the element with this [number] into view. For results further down, lists that load as you scroll, and footers.",
    inputSchema: z.object({
      direction: z.enum(["down", "up"]).optional(),
      ref: z.number().optional(),
    }),
    execute: ({ direction, ref: n }) =>
      acting(async () => {
        const p = await page();
        await ctx.emit("tool", { code: "scrolls" });
        if (n !== undefined) {
          const target = await atRef(p, n);
          if ("error" in target) {
            return target;
          }
        } else {
          const size = p.viewportSize() ?? { width: 1280, height: 900 };
          await p.mouse.move(Math.floor(size.width / 2), Math.floor(size.height / 2));
          await p.mouse.wheel(0, (direction === "up" ? -0.8 : 0.8) * size.height);
        }
        await settle(p);
        return read(p);
      }),
  });

  tools.browser_press = createTool({
    id: "browser_press",
    description:
      "Press a key on the page: Enter to send, Escape to close a popup, Tab to move on, the arrows to move through a list of suggestions.",
    inputSchema: z.object({
      key: z.enum([
        "Enter",
        "Escape",
        "Tab",
        "Backspace",
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "PageDown",
        "PageUp",
        "Space",
      ]),
    }),
    execute: ({ key }) =>
      acting(async () => {
        const p = await page();
        await ctx.emit("tool", { code: "presses", params: { key } });
        await p.keyboard.press(key === "Space" ? " " : key);
        await settle(p);
        return read(ctx.resources.openPage() ?? p);
      }),
  });

  tools.browser_back = createTool({
    id: "browser_back",
    description: "Go back to the previous page, like the browser's back button.",
    inputSchema: z.object({}),
    execute: () =>
      acting(async () => {
        const p = await page();
        await ctx.emit("tool", { code: "goesBack" });
        const went = await p
          .goBack({ waitUntil: "domcontentloaded", timeout: 20_000 })
          .catch(() => null);
        if (!went) {
          return { error: "There is no page to go back to.", page: await read(p) };
        }
        return read(p);
      }),
  });

  tools.browser_wait = createTool({
    id: "browser_wait",
    description:
      "Wait for the page: until a text appears on it (results that load, a confirmation), or for a few seconds. Then returns the page.",
    inputSchema: z.object({
      text: z.string().optional().describe("Wait until this text is on the page."),
      seconds: z.number().min(1).max(15).optional().describe("How long at most; default 5."),
    }),
    execute: ({ text, seconds }) =>
      acting(async () => {
        const p = await page();
        await ctx.emit("tool", { code: "waitsForPage" });
        const ms = (seconds ?? 5) * 1000;
        let note: string | undefined;
        if (text) {
          const appeared = await p
            .getByText(text)
            .first()
            .waitFor({ timeout: ms })
            .then(() => true)
            .catch(() => false);
          note = appeared ? undefined : `"${text}" did not appear within ${ms / 1000} s.`;
        } else {
          await p.waitForTimeout(ms);
        }
        await settle(p);
        return { ...(note ? { note } : {}), page: await read(p) };
      }),
  });

  tools.browser_screenshot = createTool({
    id: "browser_screenshot",
    description:
      "Look at the current page: returns a picture of it to you. Use it when the text is not enough (charts, a layout you cannot make sense of, a captcha or cookie wall). Set save to also hand the picture to the person as part of the result.",
    inputSchema: z.object({ save: z.boolean().optional(), name: z.string().optional() }),
    execute: ({ save, name }) =>
      inTurn(async () => {
        const p = await page();
        await ctx.emit("tool", { code: "looksAtPage" });
        const png = await p.screenshot({ type: "png" });
        let saved: string | undefined;
        if (save) {
          const asset = await ctx.saveAsset({
            kind: "image",
            mime: "image/png",
            name: name ?? "screenshot.png",
            data: png,
          });
          assets.push(asset);
          saved = asset.id;
        }
        return { url: p.url(), saved, screenshot: Buffer.from(png).toString("base64") };
      }),
    toModelOutput: imageOutput("screenshot"),
  });

  const handOver = async (input: {
    reason: string;
    fields: z.infer<typeof credentialField>[];
    submitRef?: number;
  }) => {
    const p = await page();
    const origin = originOf(p.url());
    if (!origin) {
      return { error: "no_site", note: "Open the site's sign-in page first." };
    }
    for (const field of input.fields) {
      if (!(await handleOf(p, field.ref))) {
        return {
          error: "fields_not_found",
          note: `[${field.ref}] is not on the page any more. Read the page again and ask with its numbers.`,
        };
      }
    }
    await ctx.emit("tool", {
      code: "waitsForSignIn",
      params: { name: new URL(origin).hostname },
    });
    const answer = await ctx.ask({
      kind: "login",
      reason: input.reason,
      site: { host: new URL(origin).hostname, title: await p.title() },
      fields: input.fields.map((f, i) => ({
        id: `field_${i + 1}`,
        label: f.label,
        secret: f.kind === "password",
      })),
    });
    if (!answer) {
      return { status: "needs_person", note: NOBODY };
    }
    if (answer.type === "skip" || answer.type === "timeout") {
      return { status: "declined", note: DECLINED };
    }
    // The person may have gone on in a tab the site opened.
    const current = ctx.resources.openPage() ?? p;
    let note = "The person signed in on the page themselves.";
    if (answer.type === "fill") {
      const result = await fillCredentials(current, origin, input.fields, answer.values);
      if ("error" in result) {
        return {
          error: result.error,
          note: "Nothing you can read was entered. Read the page again and ask with its current numbers.",
        };
      }
      if (result.filled.length && input.submitRef !== undefined) {
        const target = await pointAt(current, input.submitRef);
        if (!("error" in target)) {
          await clickAt(ctx, current, target).catch(() => undefined);
        }
      }
      await settle(current);
      await current.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      note = `The person entered ${result.filled.join(", ")} straight into the page${input.submitRef !== undefined ? " and it was submitted" : ""}. You do not see what they typed and must not try to read it back.`;
    }
    if (answer.remember) {
      await ctx.resources.keepSession().catch(() => undefined);
    }
    return { status: "done", note, page: await read(ctx.resources.openPage() ?? current) };
  };

  tools.browser_request_credentials = createTool({
    id: "browser_request_credentials",
    description:
      "THE way to get a login into a page: ask the person to enter a username, e-mail, password or one-time code into fields on your current page, WITHOUT you seeing it. The person sees the page live, the site's address and a form; what they type goes straight into the page, never to you. Give each field's [number] from your latest page, and submit_ref to press the sign-in or next button afterwards. A login spread over several pages (e-mail, then password, then code) is one call per page. WAITS for the person. Never ask for a password any other way.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .max(300)
        .describe("One sentence for the person, in their language: which site and why."),
      fields: z.array(credentialField).min(1).max(4),
      submit_ref: z
        .number()
        .optional()
        .describe("[number] of the button to press once the fields are filled."),
    }),
    execute: ({ reason, fields, submit_ref }) =>
      acting(() => handOver({ reason, fields, submitRef: submit_ref })),
  });

  tools.browser_request_user = createTool({
    id: "browser_request_user",
    description:
      "Hand the page to the person for something no form can do: a captcha, 'continue with Google', a passkey, a cookie wall you cannot get past. They click and type in the live page and say when they are done. For a plain login form use browser_request_credentials instead. WAITS for the person.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .max(300)
        .describe("One sentence for the person, in their language: what to do on the page."),
    }),
    execute: ({ reason }) => acting(() => handOver({ reason, fields: [] })),
  });

  tools.browser_download = createTool({
    id: "browser_download",
    description:
      "Download a file (an invoice PDF, an export) with the browser's sign-in and keep it: click the element with this [number], or fetch this URL. The file is stored under `path` in the wizard's files and added to this step's result.",
    inputSchema: z.object({
      ref: z.number().optional().describe("[number] of the download link or button."),
      url: z.string().optional().describe("Direct URL of the file, instead of ref."),
      path: z
        .string()
        .describe("Where to keep it, e.g. invoices/2026-09/2026-09-03_Notion_INV-123.pdf"),
      source: z.string().optional().describe("Where it came from, in words, for the person."),
    }),
    execute: ({ ref: n, url, path, source }) =>
      acting(async () => {
        const p = await page();
        let data: Buffer;
        let mime: string | undefined;
        if (url) {
          await ctx.emit("tool", {
            code: "downloads",
            params: { name: path.split("/").pop() ?? "" },
          });
          const res = await signedInGet(p, new URL(url, p.url()).toString());
          if (!res.ok()) {
            return { error: `The server answered ${res.status()}.` };
          }
          data = await res.body();
          mime = res.headers()["content-type"]?.split(";")[0];
        } else if (n !== undefined) {
          const target = await atRef(p, n);
          if ("error" in target) {
            return target;
          }
          await ctx.emit("tool", {
            code: "downloads",
            params: { name: path.split("/").pop() ?? "" },
          });
          // A click may start a download, open the file in a new tab, or both.
          const download = found(p.waitForEvent("download", { timeout: 12_000 }));
          const popup = found(p.context().waitForEvent("page", { timeout: 5000 }));
          await p.mouse.click(target.x, target.y);
          const opened = await Promise.race([popup, download.then(() => null)]).catch(() => null);
          const got = await Promise.any([
            download,
            ...(opened ? [found(opened.waitForEvent("download", { timeout: 8000 }))] : []),
          ]).catch(() => null);
          if (got) {
            data = await readFile(await got.path());
            await opened?.close().catch(() => undefined);
          } else {
            // No download event: the click opened the file in a tab (a PDF viewer).
            const shown = opened ?? p;
            await settle(shown);
            const res = await signedInGet(p, shown.url());
            mime = res.headers()["content-type"]?.split(";")[0];
            if (!res.ok() || mime === "text/html") {
              await opened?.close().catch(() => undefined);
              return { error: "The click did not give a file.", page: await read(p) };
            }
            data = await res.body();
            await opened?.close().catch(() => undefined);
          }
        } else {
          return { error: "Give ref or url." };
        }
        if (mime === "text/html") {
          return { error: "That is a web page, not a file — you may not be signed in." };
        }
        const kept = await files.keep(path, data, {
          mime,
          source: source ?? `Download von ${new URL(p.url()).hostname}`,
        });
        return { saved: kept.path, mime: kept.mime, size: kept.size };
      }),
  });

  // The fast loop, where a decision model can be reached: a classifier picks each step.
  const classifier: ClassifierClient | null = env.browserFastLoop
    ? await classifierClient(ctx.signal)
    : null;
  if (classifier) {
    const fieldText = createFieldText({
      spans: { client: classifier },
      ask: async (instructions, prompt) => {
        const resolved = await textModel("classifier", ctx.call);
        const result = await generateText({
          model: resolved.model,
          system: instructions,
          prompt,
          temperature: 0,
          maxOutputTokens: 1024,
          abortSignal: ctx.signal,
        });
        await ctx.chargeUsd(costOf(resolved, result.usage));
        return result.text;
      },
    });
    tools.browser_run_fast = createTool({
      id: "browser_run_fast",
      description: RUN_FAST_DESCRIPTION,
      inputSchema: z.object({
        goal: z
          .string()
          .min(1)
          .max(2000)
          .describe(
            "The sub-goal for the current page, with every concrete value it needs (e.g. 'Close the cookie banner with only the necessary cookies, type lego millennium falcon into the search and search').",
          ),
        max_steps: z.number().int().min(1).max(100).optional().describe("Step budget; default 40."),
      }),
      execute: ({ goal, max_steps }) =>
        acting(async () => {
          const p = await page();
          await ctx.emit("tool", { code: "fastLoop", params: { goal: short(goal) } });
          const result = await runFastLoop({
            client: classifier,
            fieldText,
            goal,
            maxSteps: max_steps ?? 40,
            minMargin: 0.1,
            page: p as unknown as FastLoopPage,
            shouldStop: () => ctx.signal.aborted || ctx.resources.seatHolder() === "person",
            onStep: (step) => {
              const note = fastStepNote(step);
              if (note) {
                ctx.emit("tool", note).catch(() => undefined);
              }
            },
          });
          return {
            status: result.status,
            note: result.note,
            steps: result.history.map(
              (h) =>
                `${h.step}. ${h.operation} ${h.action}${h.text ? ` = "${h.text}"` : ""}${h.page_changed === false ? " (nothing changed)" : ""}`,
            ),
            page: await read(ctx.resources.openPage() ?? p),
          };
        }),
    });
  }

  return tools;
}
