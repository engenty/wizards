import type { WizardEffect } from "@engenty/wizards-shared/style";
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

/** The engenties that fly across with bat wings: which one, where, how big, when. */
const BATS: { kind: EngentyKind; top: number; size: number; seconds: number; delay: number }[] = [
  { kind: "round", top: 16, size: 64, seconds: 17, delay: 1 },
  { kind: "drop", top: 42, size: 48, seconds: 21, delay: 7 },
  { kind: "tower", top: 26, size: 56, seconds: 19, delay: 12.5 },
];

/**
 * What a wizard's style draws around its pages (`WIZARD_EFFECTS`): spider webs in the top corners
 * with a spider letting itself down, engenties flying across with bat wings, fog along the
 * bottom. `glow` is CSS on the root alone (`fx-glow`). Nothing here takes a click.
 */
export function WizardEffects({ effects }: { effects: readonly WizardEffect[] | undefined }) {
  const on = new Set(effects ?? []);
  if (!on.has("webs") && !on.has("bats") && !on.has("fog")) {
    return null;
  }
  return (
    <>
      {on.has("fog") ? <div aria-hidden="true" className="wizard-fog" /> : null}
      <div aria-hidden="true" className="wizard-fx">
        {on.has("webs") ? (
          <>
            <SpiderWeb side="left" />
            <SpiderWeb side="right" />
            <Spider />
          </>
        ) : null}
        {on.has("bats")
          ? BATS.map((b) => (
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
                  <Engenty kind={b.kind} costume="bat" size={b.size} />
                </div>
              </div>
            ))
          : null}
      </div>
    </>
  );
}
