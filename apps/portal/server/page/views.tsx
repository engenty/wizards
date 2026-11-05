/** @jsxImportSource hono/jsx */

import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { isDemoRun, type PageSpace, type PageTeam, type PageWizard } from "./data.js";
import { engentySvg, GAZE_JS } from "./engenty.js";
import { kindColour, type Look, lookOf, shownFormats } from "./look.js";
import { type Texts, textsOf } from "./texts.js";

/**
 * A team's space page, as decided on the launch canvas: the
 * anatomy of the gallery's entry page, a band in the accent colour, the first listed wizard
 * lifted over its edge with its result files beside it, the other wizards one per row, the
 * imprint from the space's facts.
 */

const STYLES = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--f-body);-webkit-font-smoothing:antialiased;line-height:1.4}
a{color:inherit}
h1,h2,h3{font-family:var(--f-display);margin:0;letter-spacing:-0.02em;font-weight:600}
p,ul,ol{margin:0}
ul,ol{padding:0;list-style:none}
.wp{max-width:1152px;margin:0 auto;padding:0 24px}
.band{background:var(--band);color:var(--on-band)}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px;padding-top:28px}
.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font-family:var(--f-display);font-weight:600;font-size:19px}
.brand img{height:36px;max-width:180px;object-fit:contain}
.mark{width:36px;height:36px;border-radius:9px;background:var(--on-band);color:var(--band);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-family:var(--f-body)}
.site{font-size:14px;opacity:.8;text-decoration:none}
.hero{padding-top:64px;padding-bottom:150px;display:flex;flex-direction:column;gap:18px}
.lbl{font-size:12px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;opacity:.72;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px}
.lbl b{font-weight:500;opacity:1}
.lbl i{width:3px;height:3px;border-radius:999px;background:currentColor;opacity:.6}
.hero h1{font-size:clamp(34px,4.6vw,56px);line-height:1.04;letter-spacing:-0.03em;max-width:820px}
.hero p{font-size:18px;max-width:36rem;opacity:.9}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;font-size:14px;opacity:.9}
.meta li{display:inline-flex;align-items:center;gap:6px}
.ico{width:16px;height:16px;flex:none}
.main{margin-top:-96px;padding-bottom:64px}
.card{background:var(--card);border-radius:16px;box-shadow:inset 0 0 0 1px var(--line),0 10px 24px -18px rgba(0,0,0,.35);position:relative}
.feat{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);box-shadow:inset 0 0 0 1px var(--line),0 30px 70px -36px rgba(0,0,0,.45)}
.feat-main{padding:32px 36px;display:flex;flex-direction:column;gap:18px;min-width:0}
.feat-side{background:var(--side);border-radius:0 16px 16px 0;padding:28px;display:flex;flex-direction:column;gap:14px;justify-content:center}
.perch{position:absolute;right:20px;top:-88px;z-index:2;pointer-events:none}
.peek{position:absolute;right:20px;top:-18px;pointer-events:none}
.lbl2{font-size:11.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.feat h2{font-size:clamp(26px,3vw,36px);line-height:1.08}
.lead{font-size:16px;line-height:1.5;color:var(--ink-2);max-width:34rem}
.does{display:flex;flex-direction:column;gap:6px;padding-top:4px;font-size:15px}
.does span{color:var(--muted)}
.stage{display:grid}
.act{grid-area:1/1;display:flex;flex-direction:column;gap:14px;min-width:0}
.steps{display:flex;flex-direction:column;gap:9px}
.steps li{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;animation:enter .6s cubic-bezier(.2,.7,.2,1) both calc(var(--i) * .5s)}
.tick{flex:none;width:18px;height:18px;border-radius:5px;border:1.5px solid var(--line);background:var(--card);display:inline-flex;align-items:center;justify-content:center;color:var(--accent)}
.tick svg{width:12px;height:12px;opacity:0;animation:tick .35s ease forwards calc(var(--i) * .5s + .35s)}
.steps-act{animation:out .5s ease forwards var(--t)}
.results-act{animation:rise .7s cubic-bezier(.2,.7,.2,1) both var(--t)}
@keyframes tick{to{opacity:1}}
@keyframes enter{from{opacity:0;transform:translateY(8px)}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@keyframes out{to{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion:reduce){.tick svg,.steps li,.results-act{animation:none;opacity:1}.steps-act{display:none}}
.prev{background:var(--card);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 10px 24px -16px rgba(0,0,0,.35);text-decoration:none;color:inherit}
.prev .res{font-size:13.5px}
.grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:4px}.grid i{display:block;height:6px;border-radius:2px;background:var(--line)}.grid i:nth-child(-n+3){height:7px;background:color-mix(in oklab,var(--accent) 30%,var(--line))}
.pl{display:flex;flex-direction:column;gap:5px}.pl i{display:block;height:5px;border-radius:3px;background:var(--line)}
.frame{height:56px;border-radius:8px;background:color-mix(in oklab,var(--accent) 12%,var(--ground));display:flex;align-items:center;justify-content:center;color:var(--accent)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.tiles i{display:block;height:22px;border-radius:4px;background:var(--line)}
.wave{display:flex;align-items:center;gap:3px;height:28px}.wave i{display:block;width:3px;border-radius:2px;background:color-mix(in oklab,var(--accent) 50%,var(--line))}
.ex{font-size:13px;color:var(--muted);text-decoration:none}.ex b{color:var(--ink);font-weight:600}
.cta{display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding-top:6px}
.cta small{font-size:13px;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:8px;height:48px;padding:0 24px;border-radius:999px;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:15px;text-decoration:none;white-space:nowrap}
.pill:hover{filter:brightness(.92)}
.res{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;line-height:1.35}
.kic{flex:none;width:20px;height:20px}
.files{font-size:12px;font-weight:500;color:var(--muted);letter-spacing:.02em}
.side-note{font-size:13px;color:var(--muted);line-height:1.5}
.sec{margin-top:80px}
.sec h2{font-family:var(--f-body);font-size:12px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.rows{margin-top:28px;display:flex;flex-direction:column;gap:28px}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end;padding:24px 28px}
.row-main{display:flex;flex-direction:column;gap:8px;min-width:0;padding-right:60px}
.row-title{font-size:13px;color:var(--muted)}
.row h3{font-size:26px;line-height:1.12}
.gets{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin-top:2px}
.gets span{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:600}
.row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-top:4px;font-size:13px;color:var(--ink-2)}
.row-meta li{display:inline-flex;align-items:center;gap:5px}
.row-desc{font-size:14.5px;line-height:1.45;color:var(--ink-2)}
.foot{padding-bottom:32px;font-size:12.5px;color:var(--muted)}
.foot-grid{display:grid;grid-template-columns:1fr 2fr 1fr;column-gap:40px;row-gap:28px;border-top:1px solid var(--line);padding-top:40px}
.foot h4{margin:0 0 12px;font-size:12px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.foot ul{display:flex;flex-direction:column;gap:6px}
.foot .two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 24px}
.foot a{color:var(--muted)}
.made{margin-top:40px;border-top:1px solid var(--line);padding-top:20px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px}
.made span{display:inline-flex;align-items:center;gap:8px}
.nothing{min-height:100vh;display:flex;flex-direction:column}
.nothing main{flex:1;display:flex;align-items:center;justify-content:center;padding:28px}
.nothing-box{max-width:420px;display:flex;flex-direction:column;gap:14px;align-items:flex-start}
.nothing h1{font-size:32px;line-height:1.1}
.nothing p{font-size:16px;line-height:1.55;color:var(--ink-2)}
@media (max-width:900px){.feat{grid-template-columns:1fr}.feat-side{border-radius:0 0 16px 16px}.row{grid-template-columns:1fr}.row .pill{justify-self:start}.foot-grid{grid-template-columns:1fr}.foot .two{grid-template-columns:1fr}}
@media (max-width:640px){.wp{padding-left:16px;padding-right:16px}.hero{padding-top:40px;padding-bottom:120px}.main{margin-top:-72px}.feat-main{padding:24px 20px}.feat-side{padding:24px 20px}.perch{right:10px;top:-62px}.perch svg{width:104px;height:104px}.row{padding:20px}.row-main{padding-right:48px}.row h3{font-size:22px}.sec{margin-top:56px}}
`;

function Doc(props: {
  title: string;
  lang: string;
  look: Look;
  description?: string;
  children: Child;
}) {
  return (
    <html lang={props.lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {props.description ? <meta name="description" content={props.description} /> : null}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link rel="stylesheet" href={props.look.fontsHref} />
        <style>{raw(STYLES)}</style>
      </head>
      <body style={props.look.vars}>
        {props.children}
        <script>{raw(GAZE_JS)}</script>
      </body>
    </html>
  );
}

const Engenty = (props: { avatar: string; size: number }) =>
  raw(engentySvg(props.avatar, props.size));

const Clock = () => (
  <svg
    class="ico"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const Arrow = () => (
  <svg
    class="ico"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

/** The icons the gallery draws per item format (lucide: Type, FileText, Table2, Image, Video, AudioLines, ChartColumn). */
const KIND_ICON: Record<string, string> = {
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  document:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  table:
    '<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  video:
    '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  audio:
    '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
  dashboard:
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
};

/** What the result is, as its icon in the kind's colour; the files it comes as, small beside its name. */
function Kind(props: { kind: string; t: Texts }) {
  const name = props.t.kind[props.kind] ?? props.kind;
  return (
    <svg
      class="kic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      role="img"
      aria-label={name}
      style={`color:${kindColour(props.kind)}`}
    >
      <title>{name}</title>
      {raw(KIND_ICON[props.kind] ?? KIND_ICON.document)}
    </svg>
  );
}
const Files = (props: { formats: string[] }) =>
  props.formats.length ? (
    <small class="files">{shownFormats(props.formats).join(", ")}</small>
  ) : null;

/** The runtime's last step is the result step, named "Files"; the page names the results instead. */
function stepsOf(w: PageWizard): PageWizard["steps"] {
  const last = w.steps[w.steps.length - 1];
  if (!last || !/^(files|dateien)$/i.test(last.title.trim())) {
    return w.steps;
  }
  const rest = w.steps.slice(0, -1);
  return w.results.length
    ? [...rest, { title: w.results.map((r) => r.title).join(", "), by: "ai" as const }]
    : rest;
}

function Steps(props: { w: PageWizard }) {
  return (
    <ol class="steps">
      {stepsOf(props.w).map((step, i) => (
        <li>
          <span class="tick" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={`animation-delay:${(0.4 + i * 0.5).toFixed(1)}s`}
            >
              <path d="M5 12l5 5L20 7" />
            </svg>
          </span>
          {step.title}
        </li>
      ))}
    </ol>
  );
}

/** What a result looks like, drawn from its kind: a page, a table, a picture, a film. */
function Sketch(props: { kind: string }) {
  switch (props.kind) {
    case "table":
      return (
        <span class="grid" aria-hidden="true">
          {Array.from({ length: 12 }, () => (
            <i />
          ))}
        </span>
      );
    case "image":
    case "video":
      return (
        <span class="frame" aria-hidden="true">
          {props.kind === "video" ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 16l5-5 4 4 3-3 6 6" />
            </svg>
          )}
        </span>
      );
    case "dashboard":
      return (
        <span class="tiles" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      );
    case "audio":
      return (
        <span class="wave" aria-hidden="true">
          {[8, 16, 24, 14, 26, 10, 20, 12, 22, 8, 16, 6].map((h) => (
            <i style={`height:${h}px`} />
          ))}
        </span>
      );
    default:
      return (
        <span class="pl" aria-hidden="true">
          <i style="width:60%" />
          <i style="width:86%" />
          <i style="width:74%" />
          <i style="width:40%" />
        </span>
      );
  }
}

function Results(props: { w: PageWizard; t: Texts }) {
  const { w, t } = props;
  const results = w.results.length
    ? w.results
    : [{ title: w.title, kind: "document", formats: [] }];
  return (
    <>
      <span class="lbl2">{t.youGet}</span>
      {results.map((r) => (
        <div class="prev">
          <span class="res">
            <Kind kind={r.kind} t={t} />
            {r.title}
            <Files formats={r.formats} />
          </span>
          <Sketch kind={r.kind} />
        </div>
      ))}
      {w.exampleUrl ? (
        <a class="ex" href={w.exampleUrl}>
          {t.exampleNote} <b>{t.example} →</b>
        </a>
      ) : null}
    </>
  );
}

/** Each result as a chip with its name, in one row. */
function Gets(props: { w: PageWizard; t: Texts }) {
  return (
    <div class="gets">
      {props.w.results.map((r) => (
        <span>
          <Kind kind={r.kind} t={props.t} />
          {r.title}
          <Files formats={r.formats} />
        </span>
      ))}
    </div>
  );
}

/** Where the start button leads: the run, or the page's own note for a demo placeholder. */
const startOf = (space: PageSpace, w: PageWizard) =>
  isDemoRun(w.runUrl) ? `/${space.slug}/${w.slug}` : w.runUrl;

function Featured(props: { space: PageSpace; w: PageWizard; t: Texts }) {
  const { space, w, t } = props;
  return (
    <article class="card feat">
      <div class="perch">
        <Engenty avatar={w.avatar} size={150} />
      </div>
      <div class="feat-main">
        <h2>{w.title}</h2>
        {w.description ? <p class="lead">{w.description}</p> : null}
        <div class="does">
          <span class="lbl2">{t.youDo}</span>
          <div>
            {t.task(w.effort.fields, w.effort.reviews, w.effort.uploads)}{" "}
            <span>· {t.minutesLong(w.effort.minutes)}</span>
          </div>
        </div>
        {w.results.length ? (
          <div class="does">
            <span class="lbl2">{t.youGet}</span>
            <Gets w={w} t={t} />
          </div>
        ) : null}
        <div class="cta">
          <a class="pill" href={startOf(space, w)}>
            {t.start}
            <Arrow />
          </a>
          <small>{t.pause}</small>
        </div>
      </div>
      <div class="feat-side">
        {w.steps.length > 1 ? (
          <div class="stage" style={`--t:${(stepsOf(w).length * 0.5 + 1.4).toFixed(1)}s`}>
            <div class="act steps-act" aria-hidden="true">
              <span class="lbl2">{t.howItGoes}</span>
              <Steps w={w} />
            </div>
            <div class="act results-act">
              <Results w={w} t={t} />
            </div>
          </div>
        ) : (
          <Results w={w} t={t} />
        )}
      </div>
    </article>
  );
}

function Row(props: { space: PageSpace; w: PageWizard; t: Texts }) {
  const { space, w, t } = props;
  const short = t.short(w.effort.fields, w.effort.uploads);
  return (
    <li class="card row">
      <span class="peek">
        <Engenty avatar={w.avatar} size={72} />
      </span>
      <div class="row-main">
        <h3>{w.title}</h3>
        {w.description ? <p class="row-desc">{w.description}</p> : null}
        {w.results.length ? <Gets w={w} t={t} /> : null}
        <ul class="row-meta">
          <li>
            <Clock />
            {[short, t.minutes(w.effort.minutes)].filter(Boolean).join(" · ")}
          </li>
          {w.exampleUrl ? (
            <li>
              <a href={w.exampleUrl}>{t.example}</a>
            </li>
          ) : null}
        </ul>
      </div>
      <a class="pill" href={startOf(space, w)}>
        {t.start}
        <Arrow />
      </a>
    </li>
  );
}

function Footer(props: { team: PageTeam; space: PageSpace | null; t: Texts }) {
  const { team, space, t } = props;
  const imprint = space?.imprint;
  const site = imprint?.website?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <footer class="wp foot">
      <div class="foot-grid">
        <nav aria-label={t.imprint}>
          <h4>{t.imprint}</h4>
          <ul>
            <li>{imprint?.name ?? team.name}</li>
            {imprint?.lines.map((l) => (
              <li>{l}</li>
            ))}
          </ul>
        </nav>
        {space ? (
          <nav aria-label="Wizards">
            <h4>Wizards</h4>
            <ul class="two">
              {space.wizards.map((w) => (
                <li>
                  <a href={startOf(space, w)}>{w.title}</a>
                </li>
              ))}
            </ul>
          </nav>
        ) : (
          <div />
        )}
        <nav aria-label={t.page}>
          <h4>{t.page}</h4>
          <ul>
            {site ? (
              <li>
                <a href={imprint?.website}>{site}</a>
              </li>
            ) : null}
            <li>
              <a href="https://engenty.ai">engenty.ai</a>
            </li>
          </ul>
        </nav>
      </div>
      <div class="made">
        <span>
          <Engenty avatar="round" size={22} />
          {t.poweredBy}
        </span>
      </div>
    </footer>
  );
}

export function SpacePage(props: { team: PageTeam; space: PageSpace; siteUrl: string | null }) {
  const { team, space } = props;
  const t = textsOf(space.lang, space.form);
  const look = lookOf(space.brand.theme);
  const [first, ...rest] = space.wizards;
  const minutes = space.wizards.map((w) => w.effort.minutes);
  const name = space.brand.name || team.name;
  const site = props.siteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <Doc
      title={`${space.title} · ${name}`}
      lang={space.lang}
      look={look}
      description={space.intro ?? space.headline}
    >
      <div class="band">
        <header class="wp top">
          <a class="brand" href={`/${space.slug}`}>
            {space.brand.logoUrl ? (
              <img src={space.brand.logoUrl} alt={name} />
            ) : (
              <>
                <span class="mark" aria-hidden="true">
                  {initials(name)}
                </span>
                {name}
              </>
            )}
          </a>
          <span style="display:inline-flex;gap:20px;align-items:center">
            {site ? (
              <a class="site" href={props.siteUrl ?? "#"}>
                {site}
              </a>
            ) : null}
          </span>
        </header>
        <div class="wp hero">
          <p class="lbl">
            <b>{space.title}</b>
            {name !== space.title ? (
              <>
                <i aria-hidden="true" />
                {name}
              </>
            ) : null}
          </p>
          <h1>{space.headline ?? space.title}</h1>
          {space.intro ? <p>{space.intro}</p> : null}
          <ul class="meta">
            <li>{t.wizards(space.wizards.length)}</li>
            <li>
              <Clock />
              {t.minutesRange(Math.min(...minutes), Math.max(...minutes))}
            </li>
            <li>{t.noAccount}</li>
          </ul>
        </div>
      </div>
      <main class="wp main">
        <Featured space={space} w={first} t={t} />
        {rest.length ? (
          <section class="sec">
            <h2>{t.all}</h2>
            <ul class="rows">
              {rest.map((w) => (
                <Row space={space} w={w} t={t} />
              ))}
            </ul>
          </section>
        ) : null}
      </main>
      <Footer team={team} space={space} t={t} />
    </Doc>
  );
}

/**
 * The address has no page; `paused`: an admin held the team's page; `down`: the Manage-App doesn't
 * answer just now.
 */
export function NothingPage(props: { lang: string; paused?: boolean; down?: boolean }) {
  const t = textsOf(props.lang);
  const look = lookOf(null);
  const title = props.down ? t.down : props.paused ? t.paused : t.nothing;
  const note = props.down ? t.downNote : props.paused ? t.pausedNote : t.nothingNote;
  return (
    <Doc title={title} lang={props.lang} look={look}>
      <div class="nothing">
        <header class="wp top">
          <a class="brand" href="https://engenty.ai">
            <Engenty avatar="round" size={30} />
            engenty wizards
          </a>
        </header>
        <main>
          <div class="nothing-box">
            <Engenty avatar="pebble" size={72} />
            <h1>{title}</h1>
            <p>{note}</p>
            <a class="pill" href="https://engenty.ai">
              {t.whatIs}
            </a>
          </div>
        </main>
      </div>
    </Doc>
  );
}

/** Development only: a wizard of an example page that is not built yet. */
export function NotBuiltPage(props: { space: PageSpace; w: PageWizard }) {
  const t = textsOf(props.space.lang, props.space.form);
  const look = lookOf(props.space.brand.theme);
  return (
    <Doc title={props.w.title} lang={props.space.lang} look={look}>
      <div class="nothing">
        <header class="wp top">
          <a class="brand" href={`/${props.space.slug}`}>
            {props.space.brand.name}
          </a>
        </header>
        <main>
          <div class="nothing-box">
            <Engenty avatar={props.w.avatar} size={72} />
            <h1>{t.notBuilt}</h1>
            <p>
              <b>{props.w.title}</b>. {t.notBuiltNote}
            </p>
            <a class="pill" href={`/${props.space.slug}`}>
              ← {t.back}
            </a>
          </div>
        </main>
      </div>
    </Doc>
  );
}
