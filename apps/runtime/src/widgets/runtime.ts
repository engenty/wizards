/**
 * `window.wizard` — the whole contract between a widget and the platform. Injected ahead of the
 * widget's own scripts; reads its payload from <script type="application/json" id="wizard-payload">.
 *
 *   wizard.data            the run's data (keys from the widget step's `data` map)
 *   wizard.brand           { name, accent, logo, colors, facts, theme } — logo as a data URL or
 *                          null, colors [{ name, value }], facts { key: value }, theme { accent,
 *                          second, background, display, body, dark } as the run page uses it
 *   wizard.state           what the person did last time (ticks, an open tab), kept with the run
 *   wizard.save(state)     keeps `state` with the run (small JSON); the next visit reads it
 *   wizard.share(text)     hands text to the device's share sheet (or copies it)
 *   wizard.ai              "generated" | "edited" when the run's media in `data` was made or
 *                          changed by a model, else null — a film labels itself with it
 *   wizard.mode            "view" in the browser, "export" while a PNG/PDF/MP4 is rendered
 *   wizard.file(path)      text of a workspace file (JSON, CSV, SVG, …)
 *   wizard.json(path)      a workspace JSON file, parsed
 *   wizard.url(path)       a workspace file as a data URL (images, fonts, audio)
 *   wizard.ready()         call once the first frame is drawn; exports wait for it
 *   wizard.timeline({ duration, seek, poster?, audio? })
 *                          an animation of `duration` seconds; seek(t) must draw time t —
 *                          synchronously, or as a promise that resolves once it is drawn (a
 *                          film waits for its clips). Enables the MP4 export; `poster` is the
 *                          second the PNG/PDF show (default 0). A film names its sound in
 *                          `audio`: [{ src, start, duration?, from?, volume? }] — `from` is the
 *                          second of the source a cut plays from.
 */
export const WIDGET_RUNTIME = `(function () {
  var el = document.getElementById("wizard-payload");
  var payload = el ? JSON.parse(el.textContent) : { data: {}, brand: {}, files: {}, base: "" };
  var files = payload.files || {};
  var resolveReady;
  var readyPromise = new Promise(function (r) { resolveReady = r; });
  var timeline = null;
  function find(path) {
    var p = String(path || "").replace(/^\\.?\\/+/, "");
    return files[p] || files[payload.base + p] || null;
  }
  function utf8ToB64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  window.wizard = {
    data: payload.data || {},
    brand: payload.brand || {},
    ai: payload.ai || null,
    mode: window.__WIZARD_EXPORT ? "export" : "view",
    file: function (path) {
      var f = find(path);
      if (!f) return undefined;
      return f.text != null ? f.text : b64ToUtf8(f.b64);
    },
    json: function (path) {
      var t = this.file(path);
      return t == null ? undefined : JSON.parse(t);
    },
    url: function (path) {
      var f = find(path);
      if (!f) return "";
      return "data:" + f.mime + ";base64," + (f.b64 != null ? f.b64 : utf8ToB64(f.text));
    },
    state: window.__WIZARD_STATE || {},
    save: function (state) {
      this.state = state;
      if (parent !== window) parent.postMessage({ wizard: "state", state: state }, "*");
    },
    share: function (text) {
      if (parent !== window) parent.postMessage({ wizard: "share", text: String(text) }, "*");
    },
    ready: function () { resolveReady(); },
    timeline: function (t) {
      if (t && typeof t.seek === "function" && t.duration > 0) timeline = t;
    },
    __ready: readyPromise,
    __timeline: function () { return timeline; }
  };
  // A sandboxed frame can start at 0×0 and get its real size later without a "resize" event;
  // widgets that fit themselves to the window would stay at scale 0. Fire it for them.
  var lastW = innerWidth, lastH = innerHeight;
  addEventListener("resize", function () { lastW = innerWidth; lastH = innerHeight; });
  // A widget laid out as part of the page tells the page how tall its content is.
  var lastTall = 0;
  function tell() {
    var tall = Math.ceil(document.documentElement.scrollHeight);
    if (parent !== window && tall !== lastTall) {
      lastTall = tall;
      parent.postMessage({ wizard: "height", height: tall }, "*");
    }
  }
  addEventListener("load", tell);
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      if (innerWidth !== lastW || innerHeight !== lastH) {
        lastW = innerWidth;
        lastH = innerHeight;
        dispatchEvent(new Event("resize"));
      }
      tell();
    }).observe(document.documentElement);
  }
})();`;
