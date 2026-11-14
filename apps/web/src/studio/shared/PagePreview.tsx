import type { PageSpace, PageWizard } from "@engenty/wizards-shared/page-data";
import { kindColour, lookOf } from "@engenty/wizards-shared/page-look";
import { PAGE_STYLES } from "@engenty/wizards-shared/page-styles";
import { textsOf } from "@engenty/wizards-shared/page-texts";
import type { SpacePage } from "@engenty/wizards-shared/spaces";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Mascot } from "../../brand";
import { api } from "../../lib/api";
import { initialsOf, type Space } from "../../lib/session";

/*
 * The organization's page as visitors see it on wizards.page, drawn here with the page's own
 * stylesheet, look and words (`@engenty/wizards-shared/page-*`, which the portal draws it with)
 * from the data the runtime sends Manage. In a shadow root, so neither the studio's styles nor the
 * page's reach the other. Where no wizard is on the page yet, its band and words stand alone.
 */

export const pagePreviewKey = (spaceId: string) => ["page-preview", spaceId];

/** The page's typefaces: a font face declared inside a shadow root does not load, so in the head. */
function useFonts(href: string) {
  useEffect(() => {
    if (document.head.querySelector(`link[data-page-fonts="${href}"]`)) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.pageFonts = href;
    document.head.append(link);
  }, [href]);
}

/** Its children in a shadow root of their own, with the page's stylesheet. */
function Shadow({ vars, children }: { vars: string; children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  useEffect(() => {
    if (host && !root) {
      setRoot(host.shadowRoot ?? host.attachShadow({ mode: "open" }));
    }
  }, [host, root]);
  return (
    <div ref={setHost} className="min-h-full">
      {root
        ? createPortal(
            <>
              <style>{`${PAGE_STYLES}\n.pg{${vars};background:var(--ground);color:var(--ink);font-family:var(--f-body);-webkit-font-smoothing:antialiased;line-height:1.4;min-height:100%}.pg a{pointer-events:none}`}</style>
              <div className="pg">{children}</div>
            </>,
            root,
          )
        : null}
    </div>
  );
}

export function PagePreview({
  space,
  page,
  empty,
}: {
  space: Space;
  page: SpacePage;
  /** Where no wizard is on the page yet. */
  empty: string;
}) {
  const preview = useQuery({
    queryKey: pagePreviewKey(space.id),
    queryFn: () =>
      api.get<{ organization: { name: string; space: PageSpace | null } | null }>(
        `/api/studio/spaces/${space.id}/page`,
      ),
  });
  const shown = preview.data?.organization?.space ?? null;
  const name = shown?.brand.name || preview.data?.organization?.name || page.title;
  const look = lookOf(shown?.brand.theme ?? null);
  useFonts(look.fontsHref);
  const t = textsOf(page.lang ?? "de", page.form);
  const wizards = shown?.wizards ?? [];
  const [first, ...rest] = wizards;
  const minutes = wizards.map((w) => w.effort.minutes);
  return (
    <Shadow vars={look.vars}>
      <div className="band">
        <header className="wp top">
          <span className="brand">
            {shown?.brand.logoUrl ? (
              <img src={shown.brand.logoUrl} alt={name} />
            ) : (
              <>
                <span className="mark" aria-hidden="true">
                  {initialsOf(name)}
                </span>
                {name}
              </>
            )}
          </span>
        </header>
        <div className="wp hero">
          <p className="lbl">
            <b>{page.title}</b>
            {name !== page.title ? (
              <>
                <i aria-hidden="true" />
                {name}
              </>
            ) : null}
          </p>
          <h1>{page.headline || page.title}</h1>
          {page.intro ? <p>{page.intro}</p> : null}
          {wizards.length ? (
            <ul className="meta">
              <li>{t.wizards(wizards.length)}</li>
              <li>{t.minutesRange(Math.min(...minutes), Math.max(...minutes))}</li>
              <li>{t.noAccount}</li>
            </ul>
          ) : null}
        </div>
      </div>
      <main className="wp main">
        {first ? (
          <Featured w={first} t={t} />
        ) : (
          <div
            className="card"
            style={{ padding: "28px 32px", color: "var(--muted)", fontSize: 15 }}
          >
            {empty}
          </div>
        )}
        {rest.length ? (
          <section className="sec">
            <h2>{t.all}</h2>
            <ul className="rows">
              {rest.map((w) => (
                <Row key={w.slug} w={w} t={t} />
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </Shadow>
  );
}

type Texts = ReturnType<typeof textsOf>;

/** What a wizard gives, by name, in the colour of its kind. */
function Gets({ w }: { w: PageWizard }) {
  return (
    <div className="gets">
      {w.results.slice(0, 4).map((r) => (
        <span key={r.title} style={{ color: kindColour(r.kind) }}>
          <span style={{ color: "var(--ink)" }}>{r.title}</span>
        </span>
      ))}
    </div>
  );
}

function Featured({ w, t }: { w: PageWizard; t: Texts }) {
  return (
    <article className="card feat">
      <div className="perch">
        <Mascot kind={w.avatar} size={150} interactive={false} />
      </div>
      <div className="feat-main">
        <h2>{w.title}</h2>
        {w.description ? <p className="lead">{w.description}</p> : null}
        <div className="does">
          <span className="lbl2">{t.youDo}</span>
          <div>
            {t.task(w.effort.fields, w.effort.reviews, w.effort.uploads)}{" "}
            <span>· {t.minutesLong(w.effort.minutes)}</span>
          </div>
        </div>
        {w.results.length ? (
          <div className="does">
            <span className="lbl2">{t.youGet}</span>
            <Gets w={w} />
          </div>
        ) : null}
        <div className="cta">
          <a className="pill" href={w.runUrl}>
            {t.start}
          </a>
          <small>{t.pause}</small>
        </div>
      </div>
      <div className="feat-side">
        <span className="lbl2">{t.howItGoes}</span>
        <ul className="steps">
          {w.steps.map((s) => (
            <li key={s.title} style={{ animation: "none" }}>
              {s.title}
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function Row({ w, t }: { w: PageWizard; t: Texts }) {
  const short = t.short(w.effort.fields, w.effort.uploads);
  return (
    <li className="card row">
      <span className="peek">
        <Mascot kind={w.avatar} size={72} interactive={false} />
      </span>
      <div className="row-main">
        <h3>{w.title}</h3>
        {w.description ? <p className="row-desc">{w.description}</p> : null}
        {w.results.length ? <Gets w={w} /> : null}
        <ul className="row-meta">
          <li>{[short, t.minutes(w.effort.minutes)].filter(Boolean).join(" · ")}</li>
        </ul>
      </div>
      <a className="pill" href={w.runUrl}>
        {t.start}
      </a>
    </li>
  );
}
