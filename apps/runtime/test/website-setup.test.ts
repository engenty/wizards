import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The first visit reads a company's website into its space: its logo, colours, facts and big
// pictures. sfg.at as saved in test/fixtures/sfg (WordPress with a Tailwind theme): the logo is an
// inline drawing coloured by the stylesheet, the colours sit behind var() chains, the hero image's
// alt text names a logo, and the facts are on the imprint.

const dir = mkdtempSync(join(tmpdir(), "wizards-website-setup-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/sfg/${name}`, import.meta.url), "utf8");

const SITE = "https://www.sfg.at";
const THEME = `${SITE}/wp-content/themes/sfg/assets/dist/styles`;
const HERO = `${SITE}/wp-content/uploads/2025/09/ips_website-2400-x-1600-px_ohne-text-1620x1080.jpg`;
const SHARE = `${SITE}/wp-content/uploads/2019/11/atm_vid_image_03.jpg`;

// The fetch guard would resolve DNS; the test answers for the web itself.
const pages = new Map<string, { mime: string; body: string | Uint8Array }>();
const fetched: string[] = [];
vi.mock("../src/tools/net-guard", () => ({
  safeFetch: async (url: string) => {
    fetched.push(url);
    const page = pages.get(url);
    if (!page) {
      throw new Error("unreachable");
    }
    const res = new Response(page.body, { headers: { "content-type": page.mime } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  },
}));

function serveSite(overrides: Record<string, string> = {}) {
  pages.clear();
  pages.set(`${SITE}/`, { mime: "text/html", body: fixture("home.html") });
  pages.set(`${SITE}/impressum/`, { mime: "text/html", body: fixture("impressum.html") });
  pages.set(`${SITE}/kontakt/`, { mime: "text/html", body: fixture("kontakt.html") });
  pages.set(`${THEME}/style.css?ver=9745a0bbf2171613cb4c47801ea0cde7`, {
    mime: "text/css",
    body: fixture("style.css"),
  });
  pages.set(`${THEME}/tailwind.css?ver=1789977577`, {
    mime: "text/css",
    body: fixture("tailwind.css"),
  });
  for (const [url, body] of Object.entries(overrides)) {
    pages.set(url, { mime: "text/html", body });
  }
}

const svgOf = (url: string) => Buffer.from(url.split(",")[1], "base64").toString();

let website: typeof import("../src/agents/website");
let onboarding: typeof import("../src/services/onboarding");

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";

const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://localhost:5181${path}`, {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  website = await import("../src/agents/website");
  onboarding = await import("../src/services/onboarding");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request("http://localhost:5181/api/local/enter?k=test-key"));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const projects = await import("../src/services/projects");
  spaceId = (await client.withTenant("local", () => projects.defaultProject("local"))).id;
}, 60_000);

describe("the logo", () => {
  it("is the drawing in the header's home link, in the colours the stylesheet gives it", async () => {
    serveSite();
    const reading = await website.readWebsite(`${SITE}/`, undefined, { inline: true });
    const [first] = reading.brand.logos;
    expect(first.url).toMatch(/^data:image\/svg\+xml;base64,/);
    // fill-accent → var(--color-accent) → var(--sfg-color-accent) → var(--sfg-accent);
    // text-foreground → var(--color-foreground) → var(--sfg-black), for its currentColor text.
    expect(svgOf(first.url)).toMatch(/^<svg fill="#a6c93f" color="#2b2b32" xmlns=/);
    // The language switch is a home link too; its check mark is no logo.
    expect(reading.brand.logos).toHaveLength(1);
  });

  it("is never the hero picture whose alt text names a logo", async () => {
    serveSite();
    for (const inline of [true, false]) {
      const reading = await website.readWebsite(`${SITE}/`, undefined, { inline });
      expect(reading.brand.logos.map((l) => l.url)).not.toContain(HERO);
    }
    expect((await website.scanLogos(`${SITE}/`)).map((l) => l.url)).not.toContain(HERO);
    expect((await website.scanImages(`${SITE}/`)).map((i) => i.url)).toContain(HERO);
  });
});

describe("the brand material", () => {
  it("is the share image and the hero, not the teasers", async () => {
    serveSite();
    const reading = await website.readWebsite(`${SITE}/`);
    expect(reading.brand.images.filter((i) => i.hero).map((i) => i.url)).toEqual([SHARE, HERO]);
    expect(reading.brand.images.length).toBeGreaterThan(2);
  });
});

describe("the colours", () => {
  it("follows var() chains and color-mix() to the colours the page draws", async () => {
    serveSite();
    const { variables } = (await website.readWebsite(`${SITE}/`)).brand;
    const value = (name: string) => variables.find((v) => v.name === name)?.value;
    expect(value("--sfg-color-accent")).toBe("#a6c93f");
    expect(value("--sfg-color-secondary")).toBe("#432a74");
    // color-mix(in oklch, var(--sfg-color-accent) 20%, white), as the theme compiles it; one
    // colour by two names is listed once.
    expect(variables.filter((v) => v.name.endsWith("accent-200"))).toEqual([
      { name: "--color-accent-200", value: "#edf4d9" },
    ]);
    // tailwind.css comes after style.css: its root definition wins, as in the browser.
    expect(value("--sfg-color-primary")).toBe("#2b2b32");
  });

  it("leaves out WordPress's preset palette", async () => {
    serveSite();
    const { variables, frequent } = (await website.readWebsite(`${SITE}/`)).brand;
    expect(variables.some((v) => v.name.startsWith("--wp--preset--"))).toBe(false);
    expect(frequent).not.toContain("#cf2e2e");
  });

  it("gives the setup the accent and the secondary colour", async () => {
    serveSite();
    const reading = await website.readWebsite(`${SITE}/`);
    expect(onboarding.brandColors(reading.brand).map((c) => c.value)).toEqual([
      "#a6c93f",
      "#432a74",
    ]);
  });
});

describe("the facts", () => {
  it("come from the imprint, read once the home page leaves gaps", async () => {
    serveSite();
    const reading = await website.readWebsite(`${SITE}/`);
    expect(reading.links[0].url).toBe(`${SITE}/kontakt/`);
    expect(reading.links.map((l) => l.url)).toContain(`${SITE}/impressum/`);
    fetched.length = 0;
    expect(await website.readContact(reading)).toEqual({
      street: "Nikolaiplatz 2",
      postcode: "8020",
      city: "Graz",
      phone: "+43 316 7093-0",
      email: "office@sfg.at",
      vatId: "ATU53720004",
    });
    // The imprint said it all: the contact page is not fetched.
    expect(fetched).toEqual([`${SITE}/impressum/`]);
  });

  it("are completed from the contact page where the imprint lacks one", async () => {
    serveSite({
      [`${SITE}/impressum/`]: fixture("impressum.html").replace(/<p>E-Mail:[\s\S]*?<\/p>/, ""),
    });
    const reading = await website.readWebsite(`${SITE}/`);
    fetched.length = 0;
    expect((await website.readContact(reading)).email).toBe("office@sfg.at");
    expect(fetched).toEqual([`${SITE}/impressum/`, `${SITE}/kontakt/`]);
  });

  it("take the company's own address and number on a page that lists its people too", () => {
    expect(website.contactOf(fixture("kontakt.html"), `${SITE}/kontakt/`)).toEqual({
      street: "Nikolaiplatz 2",
      postcode: "8020",
      city: "Graz",
      phone: "+43 316 7093-0",
      email: "office@sfg.at",
    });
  });

  it("take structured data first", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "LocalBusiness",
          address: {
            "@type": "PostalAddress",
            streetAddress: "Hauptstraße 12/3",
            postalCode: "4020",
            addressLocality: "Linz",
          },
          telephone: "+43 732 123456",
          email: "mailto:hallo@tischlerei.at",
          vatID: "ATU12345678",
        },
      ],
    })}</script><body><p>Musterweg 1, 1010 Wien</p></body>`;
    expect(website.contactOf(html, "https://tischlerei.at/")).toEqual({
      street: "Hauptstraße 12/3",
      postcode: "4020",
      city: "Linz",
      phone: "+43 732 123456",
      email: "hallo@tischlerei.at",
      vatId: "ATU12345678",
    });
  });

  it("read an address written out and an e-mail written to dodge robots", () => {
    const html =
      "<body><footer><p>Tischlerei Holz GmbH<br>Am Bahnhof 3a<br>D-80331 München</p>" +
      "<p>T: 089 123 45 67 · Fax: 089 123 45 68</p><p>E-Mail: info (at) holz.de</p>" +
      "<p>USt-IdNr.: DE 123 456 789</p></footer></body>";
    expect(website.contactOf(html, "https://www.holz.de/")).toEqual({
      street: "Am Bahnhof 3a",
      postcode: "80331",
      city: "München",
      phone: "089 123 45 67",
      email: "info@holz.de",
      vatId: "DE123456789",
    });
  });

  it("fill what the space lacks and keep what it has", () => {
    const { facts, added } = onboarding.withFacts(
      [
        { key: "telefon", label: "Telefon", value: "+43 1 999" },
        { key: "plz", label: "PLZ", value: "" },
        { key: "oeffnungszeiten", label: "Öffnungszeiten", value: "Mo–Fr 8–17" },
      ],
      { street: "Nikolaiplatz 2", postcode: "8020", phone: "+43 316 7093-0", website: SITE },
      "de",
    );
    expect(facts).toEqual([
      { key: "telefon", label: "Telefon", value: "+43 1 999" },
      { key: "plz", label: "PLZ", value: "8020" },
      { key: "oeffnungszeiten", label: "Öffnungszeiten", value: "Mo–Fr 8–17" },
      { key: "adresse", label: "Adresse", value: "Nikolaiplatz 2" },
      { key: "website", label: "Website", value: SITE },
    ]);
    expect(added).toBe(3);
    expect(onboarding.withFacts([], { vatId: "ATU53720004" }, "en").facts).toEqual([
      { key: "uid", label: "VAT ID", value: "ATU53720004" },
    ]);
  });
});

describe("reading a website into the space", () => {
  it("fills name, colours, facts, the logo and the brand material", async () => {
    serveSite();
    const { createCanvas } = await import("@napi-rs/canvas");
    const picture = new Uint8Array(await createCanvas(4, 3).encode("png"));
    pages.set(SHARE, { mime: "image/png", body: picture });
    pages.set(HERO, { mime: "image/png", body: picture });

    const res = await send("POST", `/api/studio/projects/${spaceId}/website`, {
      url: `${SITE}/`,
      lang: "de",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "SFG",
      about: true,
      colors: 2,
      logo: true,
      facts: 7,
      assets: 2,
    });

    const projects = (await (await send("GET", "/api/studio/projects")).json()) as {
      id: string;
      brand: { colors: { value: string }[] };
      facts: { key: string; label: string; value: string }[];
    }[];
    const space = projects.find((p) => p.id === spaceId);
    expect(space?.brand.colors.map((c) => c.value)).toEqual(["#a6c93f", "#432a74"]);
    expect(space?.facts).toEqual([
      { key: "adresse", label: "Adresse", value: "Nikolaiplatz 2" },
      { key: "plz", label: "PLZ", value: "8020" },
      { key: "ort", label: "Ort", value: "Graz" },
      { key: "uid", label: "USt-IdNr.", value: "ATU53720004" },
      { key: "telefon", label: "Telefon", value: "+43 316 7093-0" },
      { key: "e_mail", label: "E-Mail", value: "office@sfg.at" },
      { key: "website", label: "Website", value: SITE },
    ]);

    const { files } = (await (await send("GET", `/api/studio/projects/${spaceId}/files`)).json()) as {
      files: {
        id: string;
        kind: string;
        mime: string;
        source: string | null;
        description: string;
      }[];
    };
    const logos = files.filter((f) => f.kind === "logo");
    expect(logos).toHaveLength(1);
    expect(logos[0].mime).toBe("image/svg+xml");
    const drawing = await (
      await send("GET", `/api/studio/projects/${spaceId}/files/${logos[0].id}/content`)
    ).text();
    expect(drawing).toMatch(/<svg[^>]*fill="#a6c93f"/);
    expect(drawing).toMatch(/<svg[^>]*color="#2b2b32"/);
    expect(
      files.filter((f) => f.kind === "asset").map((f) => [f.source, f.description]),
    ).toEqual([
      [SHARE, "share image of www.sfg.at"],
      [HERO, "Logo Innovationspreis Steiermark"],
    ]);
  });
});
