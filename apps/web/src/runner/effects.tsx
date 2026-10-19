import type { EngentyCostume } from "@engenty/wizards-shared/definition";
import type { ThemeEffect } from "@engenty/wizards-shared/theme";
import type { EngentyKind } from "../engenty/colors";
import { Engenty } from "../engenty/engenty";
import "./effects.css";

/** The same few numbers 0–1 for the same seed: a web looks alike on every visit. */
function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A spider web spun from the top left corner of a 200 × 200 box: spokes fanning across the
 * quarter, rings sagging between them toward the corner.
 */
function webPath(seed: number): string {
  const spokes = Array.from({ length: 7 }, (_, k) => {
    const a = ((k + 0.2 + rand(seed + k) * 0.5) / 7.2) * (Math.PI / 2);
    return { a, len: 200 * (0.84 + 0.16 * rand(seed + k + 20)) };
  });
  const parts = spokes.map(
    (s) => `M0 0L${(Math.cos(s.a) * s.len).toFixed(1)} ${(Math.sin(s.a) * s.len).toFixed(1)}`,
  );
  for (let ring = 1; ring <= 9; ring++) {
    const r = 200 * (ring / 9.6) ** 1.08;
    spokes.slice(1).forEach((s2, k) => {
      const s1 = spokes[k];
      const r1 = Math.min(r, s1.len);
      const r2 = Math.min(r, s2.len);
      const mid = (s1.a + s2.a) / 2;
      const sag = r * 0.86;
      if (k === 0) {
        parts.push(`M${(Math.cos(s1.a) * r1).toFixed(1)} ${(Math.sin(s1.a) * r1).toFixed(1)}`);
      }
      parts.push(
        `Q${(Math.cos(mid) * sag).toFixed(1)} ${(Math.sin(mid) * sag).toFixed(1)} ${(Math.cos(s2.a) * r2).toFixed(1)} ${(Math.sin(s2.a) * r2).toFixed(1)}`,
      );
    });
  }
  return parts.join("");
}

const WEBS = { left: webPath(1), right: webPath(9) };

/** A spider web in a top corner; the studio's look preview draws it small with its own class. */
export function SpiderWeb({ side, className }: { side: "left" | "right"; className?: string }) {
  return (
    <svg
      className={className ?? `wizard-web wizard-web-${side}`}
      viewBox="0 0 200 200"
      aria-hidden="true"
    >
      <path d={WEBS[side]} fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function Spider() {
  return (
    <div className="wizard-spider">
      <div className="wizard-spider-thread" />
      <svg viewBox="-30 -10 60 60" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" fill="none">
          {[0, 1, 2, 3].map((l) => (
            <g key={l}>
              <path d={`M0 ${8 + l * 5} Q-16 ${-2 + l * 6} -24 ${14 + l * 6}`} />
              <path d={`M0 ${8 + l * 5} Q16 ${-2 + l * 6} 24 ${14 + l * 6}`} />
            </g>
          ))}
        </g>
        <ellipse cx="0" cy="22" rx="11" ry="14" fill="currentColor" />
        <circle cx="0" cy="6" r="7" fill="currentColor" />
        <circle cx="-2.6" cy="7" r="1.6" className="wizard-spider-eye" />
        <circle cx="2.6" cy="7" r="1.6" className="wizard-spider-eye" />
      </svg>
    </div>
  );
}

/** A corner of frost: ice needles growing from the top corner of a 200 × 200 box. */
function Frost({ side }: { side: "left" | "right" }) {
  const needles = Array.from({ length: 9 }, (_, k) => {
    const a = ((k + 0.5) / 9) * (Math.PI / 2);
    const len = 70 + rand(k + 40) * 110;
    const x = Math.cos(a) * len;
    const y = Math.sin(a) * len;
    const bx = Math.cos(a) * len * 0.55;
    const by = Math.sin(a) * len * 0.55;
    const tw = 14 + rand(k + 50) * 16;
    return `M0 0L${x.toFixed(1)} ${y.toFixed(1)}M${bx.toFixed(1)} ${by.toFixed(1)}l${(Math.cos(a + 0.6) * tw).toFixed(1)} ${(Math.sin(a + 0.6) * tw).toFixed(1)}M${bx.toFixed(1)} ${by.toFixed(1)}l${(Math.cos(a - 0.6) * tw).toFixed(1)} ${(Math.sin(a - 0.6) * tw).toFixed(1)}`;
  }).join("");
  return (
    <svg className={`wizard-frost wizard-web-${side}`} viewBox="0 0 200 200" aria-hidden="true">
      <path d={needles} fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** A few dozen specks that rise, fall or twinkle: embers, snow, confetti, stars. */
function Particles({ kind }: { kind: string }) {
  const count = kind === "stars" ? 28 : 22;
  return (
    <div className={`wizard-particles wizard-particles-${kind}`}>
      {Array.from({ length: count }, (_, k) => (
        <span
          key={k}
          style={{
            left: `${(rand(k + 1) * 100).toFixed(2)}%`,
            top: kind === "stars" ? `${(rand(k + 2) * 100).toFixed(2)}%` : undefined,
            animationDuration: `${(kind === "stars" ? 2.5 : 9) + rand(k + 3) * 8}s`,
            animationDelay: `${(-rand(k + 4) * 16).toFixed(2)}s`,
            scale: (0.6 + rand(k + 5) * 0.9).toFixed(2),
            ["--hue" as string]: `${Math.round(rand(k + 6) * 360)}`,
          }}
        />
      ))}
    </div>
  );
}

const FLYERS: { kind: EngentyKind; top: number; size: number; seconds: number; delay: number }[] = [
  { kind: "round", top: 16, size: 64, seconds: 17, delay: 1 },
  { kind: "drop", top: 42, size: 48, seconds: 21, delay: 7 },
  { kind: "tower", top: 26, size: 56, seconds: 19, delay: 12.5 },
];
const PEEKERS: { kind: EngentyKind; side: "left" | "right"; seconds: number; delay: number }[] = [
  { kind: "flame", side: "right", seconds: 14, delay: 2 },
  { kind: "sprout", side: "left", seconds: 16, delay: 9 },
];

/** engenties in a costume: flying across the page, or peeking in from a bottom corner now and then. */
function Figures({ costume, motion }: { costume: EngentyCostume | undefined; motion: string }) {
  if (motion === "peek") {
    return (
      <>
        {PEEKERS.map((p) => (
          <div
            key={p.kind}
            className={`wizard-peek wizard-peek-${p.side}`}
            style={{ animationDuration: `${p.seconds}s`, animationDelay: `${p.delay}s` }}
          >
            <Engenty kind={p.kind} costume={costume} size={96} />
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      {FLYERS.map((b) => (
        <div
          key={b.kind}
          className="wizard-bat"
          style={{
            top: `${b.top}%`,
            animationDuration: `${b.seconds}s`,
            animationDelay: `${b.delay}s`,
          }}
        >
          <div className="wizard-bat-bob">
            <Engenty kind={b.kind} costume={costume} size={b.size} />
          </div>
        </div>
      ))}
    </>
  );
}

const COSTUMES: readonly string[] = ["witch", "devil", "bat", "pumpkin"];

/**
 * What a wizard's look draws around its pages, from the runner's effect library (THEME_EFFECTS):
 * corners (spider webs with a spider, frost), particles (embers, snow, confetti, stars), figures
 * (engenties in a costume flying across or peeking in) and fog. `glow` and `pattern` are CSS on
 * the root alone (`useRunTheme`). An effect or option this runner does not know is left out.
 * Nothing here takes a click.
 */
export function WizardEffects({
  effects,
  contained,
}: {
  effects: readonly ThemeEffect[] | undefined;
  /** Drawn inside one element of the page (the studio's test run), not over the whole window. */
  contained?: boolean;
}) {
  const drawn = (effects ?? []).filter((e) =>
    ["corners", "particles", "figures", "fog"].includes(e.id),
  );
  if (!drawn.length) {
    return null;
  }
  const option = (e: ThemeEffect, key: string) =>
    typeof e[key] === "string" ? String(e[key]) : "";
  return (
    <>
      {drawn.some((e) => e.id === "fog") ? (
        <div
          aria-hidden="true"
          className={contained ? "wizard-fog wizard-fx-contained" : "wizard-fog"}
        />
      ) : null}
      <div aria-hidden="true" className={contained ? "wizard-fx wizard-fx-contained" : "wizard-fx"}>
        {drawn.map((e, n) => {
          const key = `${e.id}-${n}`;
          if (e.id === "corners") {
            const kind = option(e, "kind") || "webs";
            return kind === "frost" ? (
              <div key={key}>
                <Frost side="left" />
                <Frost side="right" />
              </div>
            ) : kind === "webs" ? (
              <div key={key}>
                <SpiderWeb side="left" />
                <SpiderWeb side="right" />
                <Spider />
              </div>
            ) : null;
          }
          if (e.id === "particles") {
            const kind = option(e, "kind") || "embers";
            return ["embers", "snow", "confetti", "stars"].includes(kind) ? (
              <Particles key={key} kind={kind} />
            ) : null;
          }
          if (e.id === "figures") {
            const costume = option(e, "costume");
            return (
              <Figures
                key={key}
                costume={COSTUMES.includes(costume) ? (costume as EngentyCostume) : undefined}
                motion={option(e, "motion") || "fly"}
              />
            );
          }
          return null;
        })}
      </div>
    </>
  );
}
