import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The first visit reads a company's website into its space: its name, what it does, its logo,
// colours, fonts, facts and big pictures. sfg.at as saved in test/fixtures/sfg (WordPress with a
// Tailwind theme): the logo is an inline drawing coloured by the stylesheet, the colours sit behind
// var() chains, the hero image's alt text names a logo, the stylesheet names its font by its
// weights too, and the facts (the full name, the register entry, the management) are on the
// imprint.

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
const LEGAL_NAME = "Steirische Wirtschaftsförderungsgesellschaft m.b.H.";
const PURPOSE =
  "Die Dienstleistungen der Steirische Wirtschaftsförderungsgesellschaft m.b.H. unterstützen auf Basis des Wirtschaftsförderungsgesetzes des Landes Steiermark steirische Unternehmen bei der Beschleunigung ihres wirtschaftlichen Erfolges. Mehr als 25.000 Betriebe mit (Stamm-)Sitz in der Steiermark sind direkte Zielgruppe des Unternehmens, insbesondere in den Bereichen gewerbliche und industrielle Produktion, Handwerk, Handel und unternehmensbezogene Dienstleistung. Die Steirische Wirtschaftsförderungsgesellschaft m.b.H. unterliegt der Kontrolle des Steiermärkischer Landesrechnungshofs.";
const PROFILES = {
  linkedin: "https://www.linkedin.com/company/sfg---steirische-wirtschaftsförderung",
  facebook: "https://www.facebook.com/SteirischeWirtschaftsfoerderungSFG",
  instagram: "https://www.instagram.com/sfg.wirtschaftsfoerderung",
  youtube: "https://www.youtube.com/user/sfgkommunikation",
};

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

// The model the setup asks after the patterns: none (the patterns' reading stands) unless a test
// gives it an answer.
const llm = vi.hoisted(() => ({ answer: null as unknown, prompts: [] as string[] }));
vi.mock("../src/models.js", async (original) => {
  const models = await original<typeof import("../src/models.js")>();
  return {
    ...models,
    textModel: async () => {
      if (llm.answer === null) {
        throw new models.ModelUnavailableError("No model in this test.");
      }
      return {
        model: new MockLanguageModelV3({
          doGenerate: async (options) => {
            llm.prompts.push(JSON.stringify(options.prompt));
            return {
              content: [{ type: "text", text: JSON.stringify(llm.answer) }],
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
              warnings: [],
            };
          },
        }),
        ref: "test/scripted",
        vendor: "test",
        gateway: false,
        metered: true,
      };
    },
  };
});

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

describe("the fonts", () => {
  it("are the family the site serves, its weight-named faces, icons and hacks left out", async () => {
    serveSite();
    const { fonts } = (await website.readWebsite(`${SITE}/`)).brand;
    // style.css also names "Geomanist-Medium" (Geomanist at 500), the icon font "icons" and the
    // object-fit polyfill's `font-family: "object-fit: cover;"`.
    expect(fonts).toEqual([{ family: "Geomanist", weights: [400, 500, 700], headings: true }]);
    expect(onboarding.brandFonts(fonts, "de")).toEqual([
      { family: "Geomanist", role: "Überschriften und Fließtext", weights: [400, 500, 700] },
    ]);
  });

  it("give a second family where it is the headings' one", async () => {
    pages.clear();
    pages.set("https://studio.example/", {
      mime: "text/html",
      body:
        '<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;family=Playfair+Display:wght@700&amp;display=swap">' +
        "<style>body{font-family:Inter,sans-serif}h1,h2{font-family:'Playfair Display',serif}" +
        ".btn{font-family:Inter-SemiBold}.fa{font-family:'Font Awesome 6 Free'}</style></head>" +
        `<body><h1>Studio</h1><p>${"Wir gestalten Räume, in denen Menschen gern arbeiten. ".repeat(12)}</p></body></html>`,
    });
    const { fonts } = (await website.readWebsite("https://studio.example/")).brand;
    expect(fonts.map((f) => f.family)).toEqual(["Inter", "Playfair Display"]);
    expect(onboarding.brandFonts(fonts, "en")).toEqual([
      { family: "Inter", role: "Body text", weights: [400, 600] },
      { family: "Playfair Display", role: "Headings", weights: [700] },
    ]);
  });
});

describe("the name and the about text", () => {
  it("are the name the site gives itself and the imprint's account of what the company does", async () => {
    serveSite();
    const reading = await website.readWebsite(`${SITE}/`);
    expect(reading.siteName).toBe("SFG");
    const contact = await website.readContact(reading);
    // The meta description is a slogan and the home page's teasers are short.
    expect(onboarding.aboutOf(reading.description, reading.text, contact.purpose)).toBe(PURPOSE);
  });

  it("keep the slogan only where nothing longer is there", () => {
    const slogan = "Wir brennen für die Zukunft – wir rennen für die Steiermark.";
    expect(onboarding.aboutOf(slogan, "# Willkommen\n\nKurz.", "")).toBe(slogan);
    const prose =
      "Die Tischlerei Holz fertigt seit 1950 Möbel nach Maß, von der Küche bis zum Ladenbau, und plant sie mit ihren Kundinnen und Kunden Stück für Stück.";
    expect(onboarding.aboutOf(slogan, `[Start](/)\n\n${prose}`, PURPOSE)).toBe(prose);
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
      company: LEGAL_NAME,
      register: "FN 44903 i",
      court: "Landes- als Handelsgericht Graz",
      management: "Christoph Ludwig",
      purpose: PURPOSE,
      // The home page's footer links them; the imprint's text names LinkedIn otherwise.
      ...PROFILES,
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
      company: "Tischlerei Holz GmbH",
    });
  });

  it("read a German imprint's register entry and managing directors", () => {
    const html =
      "<body><h1>Impressum</h1><p>Muster Software GmbH, Hauptstraße 5, 10115 Berlin</p>" +
      "<p>Geschäftsführer: Anna Berger und Dr. Max Muster</p>" +
      "<p>Registergericht: Amtsgericht Charlottenburg<br>Registernummer: HRB 123456 B</p>" +
      '<p><a href="https://www.facebook.com/sharer.php?u=x">Teilen</a>' +
      '<a href="https://de.linkedin.com/company/muster-software?trk=x">LinkedIn</a></p></body>';
    expect(website.contactOf(html, "https://muster.de/impressum")).toMatchObject({
      company: "Muster Software GmbH",
      register: "HRB 123456 B",
      court: "Amtsgericht Charlottenburg",
      management: "Anna Berger und Dr. Max Muster",
      linkedin: "https://de.linkedin.com/company/muster-software",
    });
    expect(website.contactOf(html, "https://muster.de/impressum").facebook).toBeUndefined();
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

  it("add what an imprint states beyond the basics, keyed by their labels", () => {
    const found = { register: "HRB 123456 B", court: "Amtsgericht Charlottenburg", x: "https://x.com/muster" };
    expect(onboarding.withFacts([], found, "de").facts).toEqual([
      { key: "handelsregisternummer", label: "Handelsregisternummer", value: "HRB 123456 B" },
      { key: "registergericht", label: "Registergericht", value: "Amtsgericht Charlottenburg" },
      { key: "x", label: "X", value: "https://x.com/muster" },
    ]);
    expect(
      onboarding.withFacts([{ key: "hrb", label: "Commercial register number", value: "" }], found, "en")
        .facts,
    ).toEqual([
      { key: "hrb", label: "Commercial register number", value: "HRB 123456 B" },
      { key: "register_court", label: "Register court", value: "Amtsgericht Charlottenburg" },
      { key: "x", label: "X", value: "https://x.com/muster" },
    ]);
  });
});

describe("reading a website into the space", () => {
  it("fills name, about, colours, fonts, facts, the logo and the brand material without a model", async () => {
    llm.answer = null;
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
      fonts: 1,
      logo: true,
      facts: 15,
      assets: 2,
      sectors: expect.any(Array),
    });

    const projects = (await (await send("GET", "/api/studio/projects")).json()) as {
      id: string;
      brand: {
        name: string;
        about: string;
        colors: { value: string }[];
        fonts: { family: string; role: string; weights: number[] }[];
      };
      facts: { key: string; label: string; value: string }[];
    }[];
    const space = projects.find((p) => p.id === spaceId);
    expect(space?.brand.name).toBe("SFG");
    expect(space?.brand.about).toBe(PURPOSE);
    expect(space?.brand.colors.map((c) => c.value)).toEqual(["#a6c93f", "#432a74"]);
    expect(space?.brand.fonts).toMatchObject([
      { family: "Geomanist", role: "Überschriften und Fließtext", weights: [400, 500, 700] },
    ]);
    expect(space?.facts).toEqual([
      { key: "adresse", label: "Adresse", value: "Nikolaiplatz 2" },
      { key: "plz", label: "PLZ", value: "8020" },
      { key: "ort", label: "Ort", value: "Graz" },
      { key: "uid", label: "USt-IdNr.", value: "ATU53720004" },
      { key: "telefon", label: "Telefon", value: "+43 316 7093-0" },
      { key: "e_mail", label: "E-Mail", value: "office@sfg.at" },
      { key: "website", label: "Website", value: SITE },
      // The space goes by "SFG"; the imprint's full name is the page's imprint name.
      { key: "firmenname", label: "Firmenname", value: LEGAL_NAME },
      { key: "firmenbuchnummer", label: "Firmenbuchnummer", value: "FN 44903 i" },
      { key: "firmenbuchgericht", label: "Firmenbuchgericht", value: "Landes- als Handelsgericht Graz" },
      { key: "geschaeftsfuehrung", label: "Geschäftsführung", value: "Christoph Ludwig" },
      { key: "linkedin", label: "LinkedIn", value: PROFILES.linkedin },
      { key: "facebook", label: "Facebook", value: PROFILES.facebook },
      { key: "instagram", label: "Instagram", value: PROFILES.instagram },
      { key: "youtube", label: "YouTube", value: PROFILES.youtube },
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

describe("the model after the patterns", () => {
  const answer = {
    name: "SFG",
    company: LEGAL_NAME,
    about:
      "Die SFG ist die Wirtschaftsförderung des Landes Steiermark. Sie unterstützt steirische Unternehmen bei Gründung, Forschung und Wachstum.",
    facts: [
      // Read by the patterns already, under the same or another label.
      { label: "Telefon", value: "+43 316 7093-0" },
      { label: "Firmenbuch", value: "FN 44903i" },
      { label: "Medieninhaber", value: LEGAL_NAME },
      // New, and on the imprint.
      { label: "Eigentümer", value: "Land Steiermark" },
      // Not on any page: dropped.
      { label: "Öffnungszeiten", value: "Mo–Fr 8–17 Uhr" },
    ],
    fonts: [
      { family: "geomanist", role: "Überschriften und Fließtext" },
      { family: "Comic Sans", role: "Zitate" },
    ],
  };

  it("completes the space with what the pages state, and nothing else", async () => {
    serveSite();
    llm.answer = answer;
    llm.prompts.length = 0;
    // A space without facts and fonts yet.
    await send("PATCH", `/api/studio/projects/${spaceId}`, { facts: [], brand: { fonts: [] } });
    const res = await send("POST", `/api/studio/projects/${spaceId}/website`, {
      url: `${SITE}/`,
      lang: "de",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "SFG", about: true, fonts: 1, facts: 16 });
    // The model reads the imprint and what the patterns found.
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain("Unternehmensgegenstand");
    expect(llm.prompts[0]).toContain("FN 44903 i");

    const projects = (await (await send("GET", "/api/studio/projects")).json()) as {
      id: string;
      brand: { about: string; fonts: { family: string; role: string; weights: number[] }[] };
      facts: { key: string; label: string; value: string }[];
    }[];
    const space = projects.find((p) => p.id === spaceId);
    expect(space?.brand.about).toBe(answer.about);
    expect(space?.brand.fonts).toMatchObject([
      { family: "Geomanist", role: "Überschriften und Fließtext", weights: [400, 500, 700] },
    ]);
    expect(space?.facts.map((f) => f.label)).toEqual([
      "Adresse",
      "PLZ",
      "Ort",
      "USt-IdNr.",
      "Telefon",
      "E-Mail",
      "Website",
      "Firmenname",
      "Firmenbuchnummer",
      "Firmenbuchgericht",
      "Geschäftsführung",
      "LinkedIn",
      "Facebook",
      "Instagram",
      "YouTube",
      "Eigentümer",
    ]);
    expect(space?.facts.at(-1)).toEqual({
      key: "eigentuemer",
      label: "Eigentümer",
      value: "Land Steiermark",
    });
    llm.answer = null;
  });

  it("keeps only names and facts whose words are on the pages", async () => {
    const { grounded } = await import("../src/agents/company");
    const pages = [
      {
        url: SITE,
        text: "Impressum\n\nMuster GmbH\n\n[LinkedIn](https://www.linkedin.com/company/muster-gro%C3%9Fhandel)",
      },
    ];
    expect(
      grounded(
        {
          name: "Muster AG",
          company: "Muster GmbH",
          about: "Kurz.",
          facts: [
            { label: "LinkedIn", value: "https://www.linkedin.com/company/muster-großhandel" },
            { label: "Geschäftsführung", value: "Max Muster" },
          ],
          fonts: [{ family: "Inter", role: "Fließtext" }],
        },
        pages,
        [{ family: "Inter", weights: [400] }],
      ),
    ).toEqual({
      company: "Muster GmbH",
      facts: [{ label: "LinkedIn", value: "https://www.linkedin.com/company/muster-großhandel" }],
      fonts: [{ family: "Inter", role: "Fließtext", weights: [400] }],
    });
  });

  it("leaves the patterns' reading where the model's answer is unusable", async () => {
    const { readCompany } = await import("../src/agents/company");
    llm.answer = "no profile here";
    expect(
      await readCompany({
        lang: "de",
        pages: [{ url: SITE, text: "Impressum" }],
        found: { name: "SFG", about: "", facts: [], fonts: [] },
      }),
    ).toBeNull();
    llm.answer = null;
  });
});
