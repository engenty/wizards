import { type Browser, type BrowserContext, chromium } from "playwright-core";
import { env } from "../env.js";
import { assertPublicUrl } from "../tools/net-guard.js";

/**
 * One Chromium for the whole server: the engenty-browser container over CDP when
 * `BROWSER_CDP_URL` is set, else a local headless Chrome. Every user of it opens
 * its own context, so runs never share cookies or storage. Service workers are blocked: their
 * requests would not pass a context's route guard.
 */
let browserPromise: Promise<Browser> | null = null;

async function connect(): Promise<Browser> {
  const browser = env.browserCdpUrl
    ? await chromium.connectOverCDP(env.browserCdpUrl)
    : await chromium.launch({
        executablePath: env.chromePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
      });
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = connect().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function newContext(
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  const browser = await getBrowser();
  return browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
    ...options,
  });
}

/**
 * Verdicts are kept only briefly: a name's addresses can change, and a page that rebinds its own
 * name to a private address must not ride on an old "public".
 */
const HOST_CHECK_TTL_MS = 30_000;
const hostChecks = new Map<string, { at: number; check: Promise<boolean> }>();

function publicHost(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return Promise.resolve(false);
  }
  const now = Date.now();
  const cached = hostChecks.get(host);
  if (cached && now - cached.at < HOST_CHECK_TTL_MS) {
    return cached.check;
  }
  const check = assertPublicUrl(url).then(
    () => true,
    () => false,
  );
  hostChecks.set(host, { at: now, check });
  if (hostChecks.size > 2000) {
    hostChecks.clear();
  }
  return check;
}

/**
 * A context for browsing the web on a person's behalf: every request, whoever started it (the
 * agent, a redirect, the person clicking), may only reach public hosts over http(s). Pages may
 * still use their own data: and blob: URLs; every other scheme (file:, ftp:, ...) is refused.
 */
export async function webContext(
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  const context = await newContext({ acceptDownloads: true, ...options });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^(data|blob):/i.test(url) || (/^https?:/i.test(url) && (await publicHost(url)))) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  return context;
}

/**
 * A context for rendering generated HTML: every network request is refused. The HTML is
 * self-contained by design, and nothing it runs may reach the server's network.
 */
export async function offlineContext(
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  const context = await newContext({ javaScriptEnabled: true, ...options });
  await context.route("**/*", (route) => route.abort("blockedbyclient"));
  return context;
}

export async function closeBrowser() {
  const b = await browserPromise?.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => undefined);
}
