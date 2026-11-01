import { describe, expect, it } from "vitest";
import { htmlToContent } from "../src/render/convert";

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
