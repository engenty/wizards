import { useState } from "react";
import { BASE } from "@/lib/base";
import { ENGENTY_KINDS, type EngentyKind } from "../engenty/colors";
import { FluffyEngenty, type FluffyEngentyOverrides } from "../engenty/fluffy-engenty";
import type { EngentyCoat } from "../engenty/fur-stage";
import { isGooseHelmetKind } from "../engenty/goose-helmet-fit";
import { stageFill } from "../lib/theme";
import { BuilderControls } from "./BuilderControls";
import { builderCopy as copy } from "./engenty-builder-copy";

export type BuilderMaterial = EngentyCoat | "both";
export type BuilderBackground = "light" | "neutral" | "auto" | EngentyKind;
export const builderBackground = (background: BuilderBackground, kind: EngentyKind) =>
  background === "light"
    ? "#f7f5f2"
    : background === "neutral"
      ? "#191c24"
      : stageFill(background === "auto" ? kind : background);

// Development-only material studio with shared controls for both coats.
export function EngentyBuilder() {
  const [kind, setKind] = useState<EngentyKind>("round");
  const [material, setMaterial] = useState<BuilderMaterial>("fur");
  const [overrides, setOverrides] = useState<FluffyEngentyOverrides>({});
  const [background, setBackground] = useState<BuilderBackground>("light");
  const [motion, setMotion] = useState<"auto" | "play" | "pause">("play");
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [follow, setFollow] = useState(true);
  const [goggles, setGoggles] = useState(false);
  const [gooseHelmet, setGooseHelmet] = useState(false);
  const helmetAvailable = isGooseHelmetKind(kind);
  const selectKind = (next: EngentyKind) => {
    setKind(next);
    if (!isGooseHelmetKind(next)) setGooseHelmet(false);
  };
  const coats: EngentyCoat[] = material === "both" ? ["fur", "jelly"] : [material];
  const previewSize =
    material === "both"
      ? gooseHelmet && helmetAvailable
        ? 320
        : 290
      : gooseHelmet && helmetAvailable
        ? 400
        : 330;
  const props = {
    kind,
    overrides,
    interactive: follow,
    goggles,
    gooseHelmet: gooseHelmet && helmetAvailable,
    motion,
    animationSpeed: speed,
    turn: follow ? undefined : { yaw: (yaw * Math.PI) / 180, pitch: (pitch * Math.PI) / 180 },
  };
  return (
    <main className="min-h-dvh bg-background p-4 sm:p-6 text-foreground">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">engenty · renderer studio</p>
            <h1 className="text-3xl font-semibold tracking-tight">Engenty Builder</h1>
            <p className="mt-2 text-sm text-muted-foreground">{copy.description}</p>
          </div>
          <a href={`${BASE}/`} className="text-sm underline underline-offset-4">
            {copy.back}
          </a>
        </header>
        <div className="grid items-start gap-8 lg:grid-cols-[1fr_280px]">
          <section aria-label={copy.preview} className="min-w-0">
            <fieldset className="mb-4 flex flex-wrap gap-2" aria-label={copy.material}>
              {(["fur", "jelly", "both"] as const).map((option) => (
                <button
                  type="button"
                  key={option}
                  aria-pressed={material === option}
                  className="rounded-md px-3 py-1.5 text-sm aria-pressed:bg-foreground aria-pressed:text-background"
                  onClick={() => {
                    setMaterial(option);
                    if (option !== "fur" && background === "light") setBackground("auto");
                  }}
                >
                  {copy[option === "fur" ? "furry" : option]}
                </button>
              ))}
            </fieldset>
            <div
              className="flex flex-wrap items-center justify-center rounded-xl overflow-hidden py-4"
              style={{
                background: builderBackground(background, kind),
                color: background === "light" ? "#27272a" : "#f7f5f2",
              }}
            >
              {coats.map((coat) => (
                <div key={coat} className="flex flex-col items-center">
                  <FluffyEngenty {...props} coat={coat} size={previewSize} />
                  <span className="pb-2 text-xs opacity-70">
                    {copy[coat === "fur" ? "furry" : "jelly"]}
                  </span>
                </div>
              ))}
            </div>
            {material !== "fur" && (
              <p className="mt-2 text-xs text-muted-foreground">{copy.jellyHint}</p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
              <button
                type="button"
                aria-pressed={motion === "play"}
                className="rounded-md bg-foreground px-3 py-1.5 text-background"
                onClick={() => setMotion(motion === "play" ? "pause" : "play")}
              >
                {motion === "play" ? copy.pause : copy.play}
              </button>
              <label className="flex items-center gap-2">
                {copy.speed}
                <select
                  className="rounded bg-card p-1"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  {[0.25, 0.5, 1, 1.5].map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(e) => setFollow(e.target.checked)}
                />
                {copy.follow}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={goggles}
                  onChange={(e) => {
                    setGoggles(e.target.checked);
                    if (e.target.checked) setGooseHelmet(false);
                  }}
                />
                {copy.goggles}
              </label>
              <label
                className="flex items-center gap-2"
                title={helmetAvailable ? undefined : copy.helmetShapes}
              >
                <input
                  type="checkbox"
                  checked={gooseHelmet && helmetAvailable}
                  disabled={!helmetAvailable}
                  onChange={(e) => {
                    setGooseHelmet(e.target.checked);
                    if (e.target.checked) setGoggles(false);
                  }}
                />
                {copy.helmet}
              </label>
            </div>
            {!follow && (
              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <label className="flex flex-col gap-2">
                  {copy.angle}
                  <input
                    aria-label={copy.angle}
                    type="range"
                    min={-10}
                    max={10}
                    step={1}
                    value={yaw}
                    onChange={(e) => setYaw(Number(e.target.value))}
                  />
                </label>
                <label className="flex flex-col gap-2">
                  {copy.tilt}
                  <input
                    aria-label={copy.tilt}
                    type="range"
                    min={-10}
                    max={10}
                    step={1}
                    value={pitch}
                    onChange={(e) => setPitch(Number(e.target.value))}
                  />
                </label>
              </div>
            )}
            {gooseHelmet && helmetAvailable && (
              <p className="mt-2 text-xs text-muted-foreground">{copy.helmetStageNote}</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{copy.motionHint}</p>
          </section>
          <BuilderControls
            kind={kind}
            setKind={selectKind}
            material={material}
            background={background}
            setBackground={setBackground}
            overrides={overrides}
            setOverrides={setOverrides}
          />
        </div>
        <h2 className="mt-8 text-lg font-medium">{copy.gallery}</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {ENGENTY_KINDS.map((option) => (
            <button
              type="button"
              aria-pressed={kind === option}
              className="flex flex-col items-center overflow-hidden rounded-lg py-3 text-sm focus-visible:outline-2"
              style={{
                background: builderBackground(background, option),
                color: background === "light" ? "#27272a" : "#f7f5f2",
              }}
              onClick={() => selectKind(option)}
              key={option}
            >
              {coats.map((coat) => (
                <FluffyEngenty
                  key={coat}
                  kind={option}
                  coat={coat}
                  size={145}
                  overrides={overrides}
                  interactive={follow}
                  motion={motion}
                  animationSpeed={speed}
                  turn={props.turn}
                  goggles={goggles}
                  gooseHelmet={gooseHelmet && isGooseHelmetKind(option)}
                />
              ))}
              <span>{option}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
