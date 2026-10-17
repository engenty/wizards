import { SurfaceView } from "@engenty-wizards/runner";
import {
  assembleSurface,
  dataRef,
  declaredShape,
  listRef,
  type Step,
  type WizardDefinition,
} from "@engenty-wizards/shared/definition";
import type { FieldShape, ListShape } from "@engenty-wizards/shared/shape";
import type { SurfaceComponent } from "@engenty-wizards/shared/surface";
import { Code2, Eye } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { lang, t } from "../../lib/i18n";
import { cn, IconButton } from "../../ui";

type SurfaceStep = Extract<Step, { type: "surface" }>;

/** Column names that hold amounts: their sample rows get numbers, so charts have bars. */
const AMOUNT =
  /preis|price|umsatz|revenue|betrag|amount|anzahl|count|summe|sum|total|wert|value|menge|score|punkte|kosten|cost/i;

/** The keys a view charts as numbers ("valueKey"), so their sample values are numbers. */
function valueKeys(components: SurfaceComponent[]): Set<string> {
  return new Set(
    components.flatMap((c) => {
      const key = (c as Record<string, unknown>).valueKey;
      return typeof key === "string" ? [key] : [];
    }),
  );
}

const SAMPLE_NUMBERS = [1240, 860, 420, 310];

function sampleRows(columns: { key: string; label: string; number: boolean }[]): unknown[] {
  return SAMPLE_NUMBERS.slice(0, 3).map((n, i) =>
    Object.fromEntries(columns.map((c) => [c.key, c.number ? n : `${c.label} ${i + 1}`])),
  );
}

/**
 * What a view shows in the studio, where there is no run: sample values in the shape of what
 * each data key reads – rows of a kept list by its columns, an AI step's table by its columns, a
 * number as a number – so the preview looks like a run's.
 */
export function sampleData(
  def: WizardDefinition,
  step: SurfaceStep,
  components: SurfaceComponent[],
): Record<string, unknown> {
  const numeric = valueKeys(components);
  const isNumber = (key: string) => numeric.has(key) || AMOUNT.test(key);
  const fields = def.steps.flatMap((s) => (s.type === "page" ? s.fields : []));
  const sampleOf = (raw: string): unknown => {
    const ref = dataRef(raw);
    const list = listRef(ref);
    if (list) {
      const columns = def.lists?.find((l) => l.id === list)?.columns ?? [];
      return sampleRows(
        columns.map((c) => ({
          key: c.id,
          label: c.name,
          number: c.type === "number" || isNumber(c.id),
        })),
      );
    }
    if (ref === "today") {
      return new Date().toLocaleDateString(lang);
    }
    if (ref.startsWith("brand.")) {
      return t("surface.sampleBrand");
    }
    const [head, stepId, fieldId] = ref.split(".");
    if (head === "steps") {
      const source = def.steps.find((s) => s.id === stepId);
      if (source?.type !== "agent") {
        return null;
      }
      const shape = declaredShape(source);
      const sampleField = (f: FieldShape | ListShape["of"], key: string): unknown => {
        switch (f.kind) {
          case "number":
            return 42;
          case "list":
            return [1, 2, 3].map((i) =>
              f.of.kind === "object" ? sampleField(f.of, key) : `${f.of.label ?? key} ${i}`,
            );
          case "object":
            return Object.fromEntries(
              Object.entries(f.fields).map(([k, x]) => [k, sampleField(x, k)]),
            );
          case "table":
            return sampleRows(
              (f.columns ?? ["name"]).map((c) => ({ key: c, label: c, number: isNumber(c) })),
            );
          case "yesno":
            return true;
          case "choice":
          case "score":
            return f.options[0] ?? "";
          default:
            return isNumber(key) ? 42 : t("surface.sampleText");
        }
      };
      if (fieldId) {
        const f = shape?.fields[fieldId];
        return f ? sampleField(f, fieldId) : null;
      }
      return shape ? sampleField(shape, stepId) : t("surface.sampleText");
    }
    const field = fields.find((f) => f.id === ref);
    if (!field) {
      return null;
    }
    if (field.kind === "number") {
      return 42;
    }
    return field.options?.[0] ?? field.label;
  };
  return Object.fromEntries(Object.entries(step.data).map(([key, ref]) => [key, sampleOf(ref)]));
}

/** JSON in colors: keys, strings, numbers, literals and punctuation. */
function highlight(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  const token =
    /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],])/g;
  let last = 0;
  for (const m of json.matchAll(token)) {
    const at = m.index ?? 0;
    if (at > last) {
      out.push(json.slice(last, at));
    }
    const [all, str, colon, num, lit, punct] = m;
    if (str !== undefined) {
      out.push(
        <span key={at} className={colon ? "text-sky-300" : "text-amber-200"}>
          {str}
        </span>,
      );
      if (colon) {
        out.push(
          <span key={`${at}:`} className="text-slate-400">
            {colon}
          </span>,
        );
      }
    } else if (num !== undefined) {
      out.push(
        <span key={at} className="text-emerald-300">
          {num}
        </span>,
      );
    } else if (lit !== undefined) {
      out.push(
        <span key={at} className="text-violet-300">
          {lit}
        </span>,
      );
    } else if (punct !== undefined) {
      out.push(
        <span key={at} className="text-slate-400">
          {punct}
        </span>,
      );
    } else {
      out.push(all);
    }
    last = at + all.length;
  }
  out.push(json.slice(last));
  return out;
}

/**
 * An editable JSON text with highlighting: the colored text lies under a transparent field of
 * the same font and size, which takes the typing and scrolls both.
 */
function JsonEditor({
  value,
  onChange,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const under = useRef<HTMLPreElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const sync = () => {
    if (under.current && area.current) {
      under.current.scrollTop = area.current.scrollTop;
      under.current.scrollLeft = area.current.scrollLeft;
    }
  };
  const shared =
    "m-0 whitespace-pre break-normal px-3 py-2.5 font-mono text-[0.75rem] leading-[1.6] [tab-size:2]";
  return (
    <div className="relative h-[28rem] overflow-hidden rounded-lg bg-[oklch(20%_0.03_260)] ring-1 ring-border focus-within:ring-focus">
      <pre
        ref={under}
        aria-hidden
        className={cn(shared, "absolute inset-0 overflow-hidden text-slate-200")}
      >
        {highlight(value)}
        {"\n"}
      </pre>
      <textarea
        ref={area}
        spellCheck={false}
        aria-label={t("editor.surfaceJson")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onScroll={sync}
        className={cn(
          shared,
          "absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-white outline-none selection:bg-sky-400/30",
        )}
      />
    </div>
  );
}

/**
 * A view step: its preview with sample data, or its JSON – components or the pieces a decision
 * picks from, and the data – edited as code and kept only when it is valid JSON.
 */
export function SurfaceBody({
  def,
  step,
  set,
  section,
}: {
  def: WizardDefinition;
  step: SurfaceStep;
  set: (s: Step) => void;
  section: (title: string, children: ReactNode) => ReactNode;
}) {
  const shown = {
    ...(step.components ? { components: step.components } : {}),
    ...(step.candidates ? { candidates: step.candidates, groups: step.groups } : {}),
    data: step.data,
  };
  const json = JSON.stringify(shown, null, 2);
  const [draft, setDraft] = useState(json);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "code">("preview");
  // The assistant or another tab changed the view: the code shows it, unless it is being edited.
  useEffect(() => {
    if (document.activeElement?.getAttribute("aria-label") !== t("editor.surfaceJson")) {
      setDraft(json);
      setError(null);
    }
  }, [json]);
  const components = useMemo(
    () =>
      step.components ??
      assembleSurface(
        step.candidates ?? [],
        (step.candidates ?? []).map((c) => c.id),
      ),
    [step.components, step.candidates],
  );
  const data = useMemo(() => sampleData(def, step, components), [def, step, components]);
  /** Keeps the code when it is valid JSON; false when it is not. */
  const commit = (): boolean => {
    if (draft === json) {
      return true;
    }
    try {
      const next = JSON.parse(draft) as Partial<typeof shown>;
      setError(null);
      set({ ...step, ...next } as Step);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  const toggle =
    mode === "preview" ? (
      <IconButton
        label={t("surface.code")}
        className="absolute top-2 right-2 z-10 size-8"
        onClick={() => setMode("code")}
      >
        <Code2 className="size-4" />
      </IconButton>
    ) : (
      <IconButton
        label={t("surface.preview")}
        className="absolute top-2 right-4 z-10 size-8 text-slate-300 hover:bg-white/10 hover:text-white"
        onClick={() => {
          if (commit()) {
            setMode("preview");
          }
        }}
      >
        <Eye className="size-4" />
      </IconButton>
    );
  return section(
    t("type.surface"),
    mode === "preview" ? (
      <>
        <div className="relative rounded-xl bg-paper p-4 ring-1 ring-border-soft">
          {toggle}
          <SurfaceView surface={{ components, data }} assetUrl={() => ""} />
        </div>
        <p className="text-[0.75rem] text-ink-4">{t("surface.sampleNote")}</p>
      </>
    ) : (
      <>
        <div className="relative">
          {toggle}
          <JsonEditor value={draft} onChange={setDraft} onBlur={() => void commit()} />
        </div>
        {error ? <p className="text-[0.75rem] text-rose">{error}</p> : null}
      </>
    ),
  );
}
