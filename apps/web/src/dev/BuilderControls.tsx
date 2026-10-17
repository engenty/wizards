import type { Dispatch, SetStateAction } from "react";
import { ENGENTY_KINDS, type EngentyKind } from "../engenty/colors";
import type { FluffyEngentyOverrides } from "../engenty/fluffy-engenty";
import { ENGENTY_FORMS } from "../engenty/forms";
import { JELLY_DEFAULTS } from "../engenty/jelly-defaults";
import { stageFill } from "../lib/theme";
import type { BuilderBackground, BuilderMaterial } from "./EngentyBuilder";
import { builderCopy as copy } from "./engenty-builder-copy";

const KNOBS = [
  { key: "fur", label: copy.fur, min: 2, max: 24, step: 0.5 },
  { key: "density", label: copy.density, min: 30, max: 120, step: 1 },
  { key: "thick", label: copy.thick, min: 0.4, max: 2.6, step: 0.05 },
  { key: "inflate", label: copy.inflate, min: 12, max: 55, step: 1 },
  { key: "wind", label: copy.wind, min: 0, max: 2, step: 0.05 },
  { key: "softness", label: copy.softness, min: 0, max: 1.5, step: 0.05 },
  { key: "clarity", label: copy.clarity, min: 0, max: 1, step: 0.05 },
] as const;

interface Props {
  kind: EngentyKind;
  setKind: (kind: EngentyKind) => void;
  material: BuilderMaterial;
  background: BuilderBackground;
  setBackground: (background: BuilderBackground) => void;
  overrides: FluffyEngentyOverrides;
  setOverrides: Dispatch<SetStateAction<FluffyEngentyOverrides>>;
}

export function BuilderControls({
  kind,
  setKind,
  material,
  background,
  setBackground,
  overrides,
  setOverrides,
}: Props) {
  const values = {
    density: 88,
    thick: 1.8,
    inflate: material === "fur" ? 20 : JELLY_DEFAULTS.inflate,
    wind: 0.5,
    clarity: JELLY_DEFAULTS.clarity,
    softness: JELLY_DEFAULTS.softness,
    fur: ENGENTY_FORMS[kind].fur,
    ...overrides,
  };
  const knobs = KNOBS.filter(
    (knob) =>
      material === "both" ||
      (material === "fur"
        ? knob.key !== "clarity" && knob.key !== "softness"
        : knob.key === "clarity" || knob.key === "inflate" || knob.key === "softness"),
  );
  return (
    <aside className="flex flex-col gap-4" aria-label={copy.controls}>
      <label className="flex flex-col gap-2 text-sm">
        {copy.form}
        <select
          className="rounded bg-card p-2"
          value={kind}
          onChange={(e) => setKind(e.target.value as EngentyKind)}
        >
          {ENGENTY_KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-sm">
        {copy.background}
        <select
          className="rounded bg-card p-2"
          value={background}
          onChange={(e) => setBackground(e.target.value as BuilderBackground)}
        >
          <option value="light">{copy.light}</option>
          <option value="neutral">{copy.dark}</option>
          <option value="auto">{copy.match}</option>
          {ENGENTY_KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-wrap gap-2" aria-label={copy.palette}>
        {ENGENTY_KINDS.map((option) => (
          <button
            type="button"
            key={option}
            title={option}
            aria-label={`${copy.background}: ${option}`}
            aria-pressed={background === option}
            onClick={() => setBackground(option)}
            className="size-6 rounded-full ring-offset-2 aria-pressed:ring-2 aria-pressed:ring-current"
            style={{ background: stageFill(option) }}
          />
        ))}
      </fieldset>
      {knobs.map((knob) => (
        <label className="flex flex-col gap-2 text-sm" key={knob.key} htmlFor={`fur-${knob.key}`}>
          <span className="flex justify-between">
            <span>{knob.label}</span>
            <output className="font-mono text-muted-foreground">{values[knob.key]}</output>
          </span>
          <input
            id={`fur-${knob.key}`}
            type="range"
            min={knob.min}
            max={knob.max}
            step={knob.step}
            value={values[knob.key]}
            onChange={(e) =>
              setOverrides((previous) => ({ ...previous, [knob.key]: Number(e.target.value) }))
            }
          />
        </label>
      ))}
      <button
        type="button"
        className="self-start text-sm underline underline-offset-4"
        onClick={() => setOverrides({})}
      >
        {copy.reset}
      </button>
      <pre className="overflow-auto rounded bg-muted p-3 text-xs">{`<FluffyEngenty\n  coat="${material === "both" ? "fur" : material}"\n  kind="${kind}"\n  size={330}\n  overrides={${JSON.stringify(overrides, null, 2)}}\n/>`}</pre>
    </aside>
  );
}
