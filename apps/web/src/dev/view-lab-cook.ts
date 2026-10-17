import type { RunTheme } from "@engenty-wizards/shared/run";
import type { fridgePlan } from "./view-lab-sample";

type Recipe = (typeof fridgePlan.recipes)[number];

/**
 * A cook-mode widget with `layout: "page"`, as the architect would write it, for the view lab. It
 * carries a small stand-in for `window.wizard` (data, brand.theme, state, save, share and the
 * height it tells the page) — the real one comes from apps/runtime/src/widgets/runtime.ts.
 */
export function cookWidget(recipe: Recipe, theme: Partial<RunTheme>): string {
  const payload = JSON.stringify({ recipe, theme }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  :root { --accent: #e0531b; --second: #2f7a4a; --ground: #faf8f5; --card: #fff; --ink: #24201c; --muted: #7a7068; --line: #e6dfd5;
    --display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; --body: ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 var(--body); color: var(--ink); background: var(--ground); }
  .wrap { padding: 18px 16px 22px; display: grid; gap: 16px; }
  .top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .top b { font: 600 18px/1.2 var(--display); }
  .top span { color: var(--muted); font-size: 13px; white-space: nowrap; }
  .dots { display: flex; gap: 5px; }
  .dots i { flex: 1; height: 4px; border-radius: 4px; background: var(--line); }
  .dots i.on { background: var(--accent); }
  .step { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px 18px; display: grid; gap: 14px; min-height: 220px; align-content: center; }
  .step small { color: var(--muted); letter-spacing: .14em; text-transform: uppercase; font-size: 11px; }
  .step p { margin: 0; font: 600 clamp(22px, 5vw, 30px)/1.3 var(--display); }
  .timer { justify-self: start; border: 0; border-radius: 999px; padding: 10px 16px; font: 600 14px var(--body); background: color-mix(in oklch, var(--accent) 14%, var(--card)); color: var(--ink); cursor: pointer; font-variant-numeric: tabular-nums; }
  .timer.run { background: var(--accent); color: #fff; }
  .nav { display: grid; grid-template-columns: 1fr 1.4fr; gap: 8px; }
  .nav button { border: 1px solid var(--line); border-radius: 999px; padding: 13px; font: 600 15px var(--body); background: var(--card); color: var(--ink); cursor: pointer; }
  .nav button.go { background: var(--accent); border-color: var(--accent); color: #fff; }
  .nav button:disabled { opacity: .4; cursor: default; }
  details { border-top: 1px solid var(--line); padding-top: 10px; color: var(--muted); font-size: 14px; }
  details label { display: flex; gap: 10px; padding: 5px 0; color: var(--ink); }
  input { accent-color: var(--second); }
  .done { text-align: center; font: 600 22px var(--display); padding: 30px 0; }
</style></head><body><div class="wrap" id="app"></div>
<script>
  // Stand-in for the platform's window.wizard (see the comment in view-lab-cook.ts).
  (function () {
    var p = ${payload};
    var tell = function () { parent.postMessage({ wizard: "height", height: Math.ceil(document.documentElement.scrollHeight) }, "*"); };
    window.wizard = {
      data: { recipe: p.recipe }, brand: { theme: p.theme }, mode: "view",
      state: window.__WIZARD_STATE || {},
      save: function (s) { this.state = s; parent.postMessage({ wizard: "state", state: s }, "*"); },
      share: function (t) { parent.postMessage({ wizard: "share", text: String(t) }, "*"); },
      ready: function () {}
    };
    addEventListener("load", tell);
    new ResizeObserver(tell).observe(document.documentElement);
  })();
</script>
<script>
  var w = window.wizard, r = w.data.recipe, t = w.brand.theme || {};
  var root = document.documentElement.style;
  if (t.accent) root.setProperty("--accent", t.accent);
  if (t.second) root.setProperty("--second", t.second);
  if (t.display) root.setProperty("--display", '"' + t.display + '", ui-sans-serif, system-ui, sans-serif');
  if (t.body) root.setProperty("--body", '"' + t.body + '", ui-sans-serif, system-ui, sans-serif');
  if (t.dark) { root.setProperty("--ground", t.background || "#121419"); root.setProperty("--card", "#1c1f27"); root.setProperty("--ink", "#f4f1ea"); root.setProperty("--muted", "#a3a09a"); root.setProperty("--line", "#2e323d"); }
  else if (t.background) root.setProperty("--ground", "color-mix(in oklch, " + t.background + " 40%, #fff)");
  var s = Object.assign({ step: 0, have: {} }, w.state);
  var timer = null, left = 0;
  function save() { w.save({ step: s.step, have: s.have }); }
  function esc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function draw() {
    var app = document.getElementById("app");
    if (s.step >= r.steps.length) {
      app.innerHTML = '<div class="done">Guten Appetit!</div><div class="nav"><button id="back">Zurück</button><button class="go" id="again">Nochmal von vorn</button></div>';
      document.getElementById("back").onclick = function () { s.step = r.steps.length - 1; save(); draw(); };
      document.getElementById("again").onclick = function () { s.step = 0; save(); draw(); };
      return;
    }
    var st = r.steps[s.step];
    app.innerHTML =
      '<div class="top"><b>' + esc(r.title) + '</b><span>' + r.time_minutes + ' Min</span></div>' +
      '<div class="dots">' + r.steps.map(function (_, i) { return '<i class="' + (i <= s.step ? "on" : "") + '"></i>'; }).join("") + '</div>' +
      '<div class="step"><small>Schritt ' + (s.step + 1) + ' von ' + r.steps.length + '</small><p>' + esc(st.text) + '</p>' +
      (st.minutes ? '<button class="timer" id="timer">⏱ ' + st.minutes + ':00 · Timer starten</button>' : '') + '</div>' +
      '<details><summary>Zutaten (' + r.ingredients.length + ')</summary>' +
      r.ingredients.map(function (g, i) { return '<label><input type="checkbox" data-i="' + i + '"' + (s.have[i] ? " checked" : "") + '> ' + esc(g.amount) + ' ' + esc(g.name) + '</label>'; }).join("") +
      '</details>' +
      '<div class="nav"><button id="prev"' + (s.step ? "" : " disabled") + '>Zurück</button><button class="go" id="next">' + (s.step === r.steps.length - 1 ? "Fertig" : "Weiter") + '</button></div>';
    document.getElementById("prev").onclick = function () { s.step--; save(); draw(); };
    document.getElementById("next").onclick = function () { s.step++; save(); draw(); };
    document.querySelectorAll("input[data-i]").forEach(function (box) {
      box.onchange = function () { s.have[box.dataset.i] = box.checked; save(); };
    });
    var b = document.getElementById("timer");
    if (b) b.onclick = function () {
      if (timer) { clearInterval(timer); timer = null; b.classList.remove("run"); b.textContent = "⏱ " + st.minutes + ":00 · Timer starten"; return; }
      left = st.minutes * 60; b.classList.add("run");
      var tick = function () { b.textContent = "⏱ " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " · stoppen"; if (left-- <= 0) { clearInterval(timer); timer = null; b.textContent = "Zeit ist um"; } };
      tick(); timer = setInterval(tick, 1000);
    };
  }
  draw();
</script></body></html>`;
}
