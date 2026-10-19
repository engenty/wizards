import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { luminance } from "@engenty/wizards-shared/projects";
import { useEffect } from "react";
import { Mascot } from "../../brand";
import { SpiderWeb } from "../../runner/effects";
import { loadWizardFont } from "../../runner/fonts";

const LIGHT = { ground: "#faf8f5", ink: "#1f1b16", soft: "#6b6259" };
const DARK = { ground: "#17131d", ink: "#f4efe8", soft: "#b4aabd" };

/**
 * A small run page in the wizard's look: its ground, a heading and a line of text in its
 * typefaces, the start button in its accent, its engenty, and its effects drawn small. What the
 * wizard leaves to the space shows in the runner's own look.
 */
export function LookPreview({ def }: { def: WizardDefinition }) {
  const style = def.style ?? {};
  const dark = style.dark ?? (style.background ? luminance(style.background) < 0.18 : false);
  const tone = dark ? DARK : LIGHT;
  const ground = style.background ?? tone.ground;
  const accent = style.accent ?? "#e0531b";
  const effects = new Set(style.effects ?? []);
  const glow = effects.has("glow");
  useEffect(() => {
    loadWizardFont(style.displayFont);
    loadWizardFont(style.bodyFont);
  }, [style.displayFont, style.bodyFont]);
  return (
    <div
      className="relative h-28 overflow-hidden rounded-xl ring-1 ring-border-soft"
      style={{ background: ground, color: tone.ink }}
    >
      {effects.has("fog") ? (
        <div
          className="absolute inset-x-0 bottom-0 h-1/2 blur-md"
          style={{
            background: `radial-gradient(ellipse 60% 70% at 30% 100%, color-mix(in oklch, ${tone.ink} 22%, transparent), transparent 70%), radial-gradient(ellipse 50% 60% at 75% 100%, color-mix(in oklch, ${accent} 18%, transparent), transparent 70%)`,
          }}
        />
      ) : null}
      {effects.has("webs") ? (
        <>
          <SpiderWeb
            side="left"
            className="absolute top-0 left-0 w-14 opacity-60 [stroke-width:1.4]"
          />
          <SpiderWeb
            side="right"
            className="-scale-x-100 absolute top-0 right-0 w-14 opacity-60 [stroke-width:1.4]"
          />
        </>
      ) : null}
      <div className="relative flex h-full items-center gap-4 px-5">
        <div className="shrink-0">
          <Mascot kind={def.avatar} costume={def.costume} size={52} interactive={false} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[1.125rem] leading-tight"
            style={{
              fontFamily: style.displayFont ? `"${style.displayFont}"` : "var(--f-display)",
              textShadow: glow
                ? `0 0 0.6em color-mix(in oklch, ${accent} 75%, transparent)`
                : undefined,
            }}
          >
            {def.title}
          </div>
          <div
            className="mt-0.5 truncate text-[0.8125rem]"
            style={{
              fontFamily: style.bodyFont ? `"${style.bodyFont}"` : "var(--f-ui)",
              color: tone.soft,
            }}
          >
            {def.description || def.intro}
          </div>
          <div
            className="mt-2 inline-flex h-6 w-20 items-center justify-center rounded-full"
            style={{
              background: accent,
              boxShadow: glow
                ? `0 0 0.9rem color-mix(in oklch, ${accent} 65%, transparent)`
                : undefined,
            }}
          >
            <span className="text-[0.75rem]" style={{ color: dark ? "#1a0d06" : "#fff" }}>
              →
            </span>
          </div>
        </div>
        {effects.has("bats") ? (
          <div className="absolute top-2 right-16 rotate-[-8deg]">
            <Mascot kind="round" costume="bat" size={30} interactive={false} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
