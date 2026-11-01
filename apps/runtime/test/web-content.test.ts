import { describe, expect, it } from "vitest";
import { absolutePictures, htmlToContent, picturesOf } from "../src/render/convert";

// What `server.web.read` hands a plugin as `content`: the page without the site's frame.

const page = (body: string) => `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`;

describe("a web page's content", () => {
  it("leaves out the site's header, menus, skip link, footer and cookie notice", () => {
    const md = htmlToContent(
      page(`
        <a class="skip-link screen-reader-text" href="#content">Zum Inhalt springen</a>
        <header class="site-header"><a href="/"><img src="/logo.svg" alt=""></a>
          <nav><ul><li><a href="/">Home</a></li><li><a href="/work">Work</a></li></ul></nav>
        </header>
        <nav class="menu--dropdown" aria-hidden="true"><a href="/about">About</a></nav>
        <div id="content">
          <article><header><h1>4OH!4 – Good Food Found</h1></header>
            <p>Eine öffentlich zugängliche Kantine.</p></article>
        </div>
        <div class="cookie-notice">Wir verwenden Cookies. <button>OK</button></div>
        <footer><a href="/impressum">Impressum</a></footer>`),
    );
    expect(md).toBe("# 4OH!4 – Good Food Found\n\nEine öffentlich zugängliche Kantine.");
  });

  it("takes the main part where the page marks one", () => {
    const md = htmlToContent(
      page(`<div class="top">Angebot der Woche</div><main><h2>Preise</h2><p>Ab 9 €.</p></main>
        <div class="bottom">Newsletter</div>`),
    );
    expect(md).toBe("## Preise\n\nAb 9 €.");
  });
});

describe("a web page's pictures", () => {
  const base = "https://example.com/blog/post";
  const read = (body: string) => {
    const content = htmlToContent(absolutePictures(page(body), base));
    return { content, images: picturesOf(content) };
  };

  it("points each picture at one absolute address, the largest srcset entry up to 2000 px", () => {
    const { content, images } = read(`<main>
      <img src="/a-800.jpg" srcset="/a-800.jpg 800w, /a-1600.jpg 1600w, /a-3200.jpg 3200w" alt="Messestand 2026">
      <img src="data:image/gif;base64,R0lGOD" data-src="pics/b.webp" alt="Team">
      <img src="c.png" srcset="c.png, c@2x.png 2x" alt="">
    </main>`);
    expect(images).toEqual([
      { url: "https://example.com/a-1600.jpg", alt: "Messestand 2026" },
      { url: "https://example.com/blog/pics/b.webp", alt: "Team" },
      { url: "https://example.com/blog/c@2x.png", alt: "" },
    ]);
    expect(content).toContain("![Messestand 2026](https://example.com/a-1600.jpg)");
  });

  it("leaves out icons, sprites, drawings and tiny pictures, and the frame's pictures", () => {
    const { content, images } = read(`
      <header><img src="/logo.png" alt="Logo"></header>
      <main><p>Text <a href="/protection" title="Protected"><img src="/lock.svg" alt=""></a></p>
        <img src="/icons/phone.png" alt="">
        <img src="/sprite.svg" alt="">
        <img class="wp-smiley emoji" src="/x.png" alt="">
        <img src="/arrow.png" width="16" height="16" alt="">
        <img src="/thumb.jpg" width="120" srcset="/thumb.jpg 120w, /big.jpg 1200w" alt="Groß">
        <img src="/photo(1).jpg" alt="Foto">
        <img src="/220px-pool.jpg" width="220" height="165" srcset="/330px-pool.jpg 1.5x, /440px-pool.jpg 2x" alt="Becken">
        <img src="/bullet.png" width="80" height="60" srcset="/bullet@2x.png 2x" alt="">
      </main>`);
    expect(images.map((i) => i.url)).toEqual([
      "https://example.com/big.jpg",
      "https://example.com/photo%281%29.jpg",
      "https://example.com/440px-pool.jpg",
    ]);
    expect(content).not.toContain("logo");
    expect(content).toMatch(/^Text\n/);
  });
});
