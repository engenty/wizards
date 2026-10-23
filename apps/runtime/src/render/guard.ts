/**
 * Every generated HTML document (documents, dashboards, widgets) gets this before anyone sees
 * it: scripts may run, but the page can load nothing and send nothing — everything it shows is
 * inlined. Links open in a new tab instead of inside the preview frame.
 */
export const HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src data: blob:; worker-src blob:";

/** The response header for a generated document opened on its own: an opaque origin, scripts allowed. */
export const HTML_RESPONSE_CSP = `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; ${HTML_CSP}`;

/**
 * `media`: one more origin images, video and audio may come from — a video's page gets this
 * run's clips from the renderer that way; they are too large to inline.
 */
export function guardHtml(html: string, media?: string): string {
  const csp = media
    ? HTML_CSP.replace("img-src", `img-src ${media}`).replace("media-src", `media-src ${media}`)
    : HTML_CSP;
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}
