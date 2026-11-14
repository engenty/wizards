/** @jsxImportSource hono/jsx */

import { PAGE_STYLES } from "@engenty/wizards-shared/page-styles";
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

const STYLES = PAGE_STYLES;

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
