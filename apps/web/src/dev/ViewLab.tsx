import {
  DataEditor,
  DataMenu,
  HtmlFrame,
  JsonSchemaDialog,
  OutputView,
  SurfaceView,
} from "@engenty-wizards/runner";
import type { Step } from "@engenty-wizards/shared/definition";
import type { RunTheme } from "@engenty-wizards/shared/run";
import { validateSurface } from "@engenty-wizards/shared/surface";
import { Braces } from "lucide-react";
import { useEffect, useState } from "react";
import { Mascot } from "../brand";
import { useRunTheme } from "../runner/theme";
import { fridgeShape } from "./data-shape";
import { cookWidget } from "./view-lab-cook";
import { fridgePlan, fridgeView } from "./view-lab-sample";

/** Example brands: how one view looks in three spaces. */
const THEMES: Record<string, { label: string; theme: Partial<RunTheme> }> = {
  engenty: { label: "engenty", theme: {} },
  hof: {
    label: "Hofküche",
    theme: {
      accent: "#2f5d50",
      second: "#a8661b",
      background: "#eff2ec",
      display: "Young Serif",
      body: "Instrument Sans",
    },
  },
  nacht: {
    label: "Nachtküche",
    theme: {
      accent: "#ff6b4a",
      second: "#6fd0bb",
      background: "#121419",
      display: "Bricolage Grotesque",
      body: "Figtree",
      dark: true,
    },
  },
};

const WIDTHS = { phone: 390, desktop: 960 } as const;

/** The agent step behind the plan, for drawing its result without a view. */
const PLAN_STEP = {
  id: "plan",
  type: "agent",
  title: "Menüplan",
  instructions: "Plan meals from the photos.",
  tools: [],
  output: { format: "json", schema: fridgeShape },
} as unknown as Step;

// Development only: the brands' typefaces from Google Fonts. A run page will serve them itself.
const FONTS =
  "https://fonts.googleapis.com/css2?family=Young+Serif&family=Instrument+Sans:wght@400;500;600&family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Figtree:wght@400;500;600&display=swap";

function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <span className="mr-1 text-[0.75rem] text-ink-3 uppercase tracking-[0.08em]">{label}</span>
      {options.map(([id, name]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={
            value === id
              ? "h-8 rounded-full bg-ink px-3 text-[0.8125rem] text-paper"
              : "h-8 rounded-full bg-card px-3 text-[0.8125rem] text-ink-2 ring-1 ring-border-soft"
          }
        >
          {name}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * The view lab (development only): a wizard's result view with mock data, at phone or desktop
 * width, in three brands. Where new view components are drawn before steps can return the data.
 */
export function ViewLab() {
  const [brand, setBrand] = useState<keyof typeof THEMES>("engenty");
  const [width, setWidth] = useState<keyof typeof WIDTHS>("phone");
  useRunTheme(THEMES[brand].theme);
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONTS;
    document.head.append(link);
    return () => link.remove();
  }, []);
  const issues = validateSurface(fridgeView, fridgeShape);
  const [ticks, setTicks] = useState<Record<string, unknown>>({});
  const [plan, setPlan] = useState<Record<string, unknown>>(fridgePlan);
  const [cook, setCook] = useState<Record<string, unknown>>({});
  const [schemaOpen, setSchemaOpen] = useState(false);
  // The widget as the run would serve it: a file of its own, here a blob.
  const [cookUrl, setCookUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([cookWidget(fridgePlan.recipes[0], THEMES[brand].theme)], { type: "text/html" }),
    );
    setCookUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [brand]);
  return (
    <main className="min-h-dvh bg-paper px-4 py-6 text-ink">
      <div className="mx-auto flex max-w-[64rem] flex-col gap-6">
        <header className="flex flex-col gap-3">
          <p className="text-[0.75rem] text-ink-3">engenty wizards · development</p>
          <h1 className="font-display font-semibold text-[1.75rem] tracking-tight">View lab</h1>
          <p className="max-w-prose text-[0.9375rem] text-ink-3">
            Kühlschrank-Koch's result: nested data in the shape its output.schema gives
            (data-shape.ts). Components from the view catalog, themed from a brand.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Picker
              label="Brand"
              value={brand}
              options={Object.entries(THEMES).map(([id, t]) => [
                id as keyof typeof THEMES,
                t.label,
              ])}
              onChange={setBrand}
            />
            <Picker
              label="Width"
              value={width}
              options={[
                ["phone", "Phone"],
                ["desktop", "Desktop"],
              ]}
              onChange={setWidth}
            />
          </div>
          {issues.length ? (
            <ul className="rounded-xl bg-amber-tint px-4 py-3 text-[0.875rem]">
              {issues.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          ) : null}
        </header>
        <div
          className="mx-auto w-full overflow-hidden rounded-[1.75rem] bg-paper ring-1 ring-border-soft"
          style={{ maxWidth: WIDTHS[width] }}
        >
          <div className="h-[3px] bg-ember" />
          <div className="flex flex-col gap-6 px-4 py-6 sm:px-6">
            <div className="flex items-center gap-4">
              <Mascot kind="round" size={56} />
              <h2 className="text-balance font-display font-semibold text-[1.75rem] leading-tight tracking-tight">
                3 Tage gut essen
              </h2>
            </div>
            <SurfaceView
              surface={{ components: fridgeView, data: plan }}
              assetUrl={() => ""}
              onState={setTicks}
            />
          </div>
        </div>
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display font-semibold text-[1.25rem]">
              The same data in the admin
            </h2>
            <DataMenu
              items={[
                {
                  label: "JSON Schema",
                  icon: <Braces className="size-4 shrink-0" />,
                  onClick: () => setSchemaOpen(true),
                },
              ]}
            />
            <JsonSchemaDialog
              shape={fridgeShape}
              title="Menüplan"
              open={schemaOpen}
              onClose={() => setSchemaOpen(false)}
            />
          </div>
          <p className="max-w-prose text-[0.875rem] text-ink-3">
            A run's step output as the studio would show it, drawn from the step's schema: flat
            lists as tables, entries with lists of their own as cards that open, words as chips, a
            link to a recipe by its title. Edits here change the view above.
          </p>
          <div className="mx-auto w-full overflow-hidden rounded-xl bg-card ring-1 ring-border-soft">
            <DataEditor shape={fridgeShape} value={plan} onChange={setPlan} />
          </div>
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="font-display font-semibold text-[1.25rem]">Without a view</h2>
          <p className="max-w-prose text-[0.875rem] text-ink-3">
            The same result when the step has no view: what a run shows from the schema alone.
            Things as cards, words as chips, steps as numbered lines; a table only for figures.
          </p>
          <div
            className="mx-auto w-full rounded-[1.75rem] bg-paper p-4 ring-1 ring-border-soft sm:p-6"
            style={{ maxWidth: WIDTHS[width] }}
          >
            <OutputView base="" step={PLAN_STEP} output={{ json: plan, at: "" }} />
          </div>
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="font-display font-semibold text-[1.25rem]">A widget with layout "page"</h2>
          <p className="max-w-prose text-[0.875rem] text-ink-3">
            Cook mode for the first recipe: part of the page, as tall as its content, never scaled.
            Its state (step reached, ingredients ticked) goes to the page with wizard.save and comes
            back as wizard.state when it loads again (switch the brand to reload it).
          </p>
          <div
            className="mx-auto w-full overflow-hidden rounded-[1.75rem] ring-1 ring-border-soft"
            style={{ maxWidth: WIDTHS[width] }}
          >
            {cookUrl ? (
              <HtmlFrame
                key={cookUrl}
                src={cookUrl}
                page={null}
                height={420}
                flow
                state={cook}
                onState={setCook}
              />
            ) : null}
          </div>
        </section>
        <details className="rounded-xl bg-card px-4 py-3 ring-1 ring-border-soft">
          <summary className="cursor-pointer text-[0.875rem] text-ink-2">
            What is kept with the run
          </summary>
          <pre className="mt-3 overflow-x-auto text-[0.75rem] text-ink-2">
            {JSON.stringify({ view: ticks, cook }, null, 2)}
          </pre>
        </details>
        <details className="rounded-xl bg-card px-4 py-3 ring-1 ring-border-soft">
          <summary className="cursor-pointer text-[0.875rem] text-ink-2">
            The view, as the architect writes it
          </summary>
          <pre className="mt-3 overflow-x-auto text-[0.75rem] text-ink-2">
            {JSON.stringify(fridgeView, null, 2)}
          </pre>
        </details>
      </div>
    </main>
  );
}
