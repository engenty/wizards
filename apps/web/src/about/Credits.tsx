import { ExternalLink } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { Empty, Input, Spinner } from "../ui";
import { ENGENTY_CREDITS, HIGHLIGHT_CREDITS, type ProductCredit } from "./product-credits";

interface OssCredit {
  name: string;
  version: string;
  license: string;
  homepage?: string;
}

interface OssCreditGroup {
  id: string;
  kind: "root" | "app" | "package";
  label: string;
  packages: OssCredit[];
}

/** apps/web/src/about/oss-credits.json, written by `pnpm about:data`. */
interface OssCreditsData {
  shared: OssCredit[];
  groups: OssCreditGroup[];
}

const matches = (query: string, ...texts: (string | undefined)[]) =>
  texts.some((text) => text?.toLowerCase().includes(query));

function CreditRow({
  name,
  homepage,
  version,
  license,
  description,
}: {
  name: string;
  homepage?: string;
  version?: string;
  license: string;
  description?: string;
}) {
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        {homepage ? (
          <a
            href={homepage}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-[0.875rem] text-ink underline-offset-4 hover:underline"
          >
            {name}
            <ExternalLink aria-hidden className="size-3 text-ink-4" />
          </a>
        ) : (
          <span className="font-medium text-[0.875rem] text-ink">{name}</span>
        )}
        {version ? <span className="text-[0.75rem] text-ink-3 tabular-nums">{version}</span> : null}
        <span className="text-[0.75rem] text-ink-3">{license}</span>
      </div>
      {description ? <p className="mt-0.5 text-[0.8125rem] text-ink-3">{description}</p> : null}
    </li>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="border-border-soft border-b pb-2 font-display font-semibold text-[1rem]">
        {title}
      </h3>
      {hint ? <p className="mt-2 text-[0.8125rem] text-ink-3">{hint}</p> : null}
      {children}
    </section>
  );
}

function ProductList({ credits }: { credits: ProductCredit[] }) {
  return (
    <ul className="divide-y divide-border-soft">
      {credits.map((credit) => (
        <CreditRow
          key={credit.name}
          name={credit.name}
          homepage={credit.homepage}
          license={credit.license}
          description={t(credit.description)}
        />
      ))}
    </ul>
  );
}

function PackageList({ label, packages }: { label: string; packages: OssCredit[] }) {
  return (
    <div className="mt-4">
      <h4 className="font-medium text-[0.75rem] text-ink-3 tracking-wide">{label}</h4>
      <ul className="divide-y divide-border-soft">
        {packages.map((pkg) => (
          <CreditRow key={pkg.name} {...pkg} />
        ))}
      </ul>
    </div>
  );
}

/**
 * engenty wizards and the open-source software it builds on: the Credits tab of the About
 * dialog. `active`: shown now — the list loads then, and the search clears when it is put away.
 */
export function Credits({ active }: { active: boolean }) {
  const [data, setData] = useState<OssCreditsData | null>(null);
  const [query, setQuery] = useState("");

  // The list of dependencies is its own chunk, fetched when the credits first show.
  useEffect(() => {
    if (!active || data) {
      return;
    }
    let cancelled = false;
    void import("./oss-credits.json").then((mod) => {
      if (!cancelled) {
        setData(mod.default as OssCreditsData);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active, data]);

  useEffect(() => {
    if (!active) {
      setQuery("");
    }
  }, [active]);

  const q = query.trim().toLowerCase();
  const product = (credits: ProductCredit[]) =>
    q ? credits.filter((c) => matches(q, c.name, c.license, t(c.description))) : credits;
  const oss = (packages: OssCredit[]) =>
    q ? packages.filter((p) => matches(q, p.name, p.license, p.version)) : packages;

  const own = product(ENGENTY_CREDITS);
  const builtWith = product(HIGHLIGHT_CREDITS);
  const lists = data
    ? [
        { id: "shared", label: t("about.creditsShared"), packages: oss(data.shared) },
        ...data.groups.map((group) => ({
          id: group.id,
          label: group.label,
          packages: oss(group.packages),
        })),
      ].filter((list) => list.packages.length > 0)
    : [];
  const nothing = own.length === 0 && builtWith.length === 0 && lists.length === 0;

  return (
    <>
      <p className="mb-4 text-[0.875rem] text-ink-3">{t("about.creditsHint")}</p>
      <Input
        type="search"
        value={query}
        placeholder={t("about.search")}
        onChange={(e) => setQuery(e.target.value)}
      />
      {own.length > 0 ? (
        <Section title={t("about.creditsProduct")}>
          <ProductList credits={own} />
        </Section>
      ) : null}
      {builtWith.length > 0 ? (
        <Section title={t("about.creditsBuiltWith")}>
          <ProductList credits={builtWith} />
        </Section>
      ) : null}
      {data === null ? (
        <div className="flex justify-center py-10 text-ink-3">
          <Spinner />
        </div>
      ) : lists.length > 0 ? (
        <Section title={t("about.creditsDeps")} hint={q ? undefined : t("about.creditsDepsHint")}>
          {lists.map((list) => (
            <PackageList key={list.id} label={list.label} packages={list.packages} />
          ))}
        </Section>
      ) : null}
      {data !== null && nothing ? <Empty>{t("about.noMatches")}</Empty> : null}
    </>
  );
}
