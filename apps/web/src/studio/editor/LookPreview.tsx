import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { luminance } from "@engenty/wizards-shared/projects";
import type { Theme } from "@engenty/wizards-shared/theme";
import { useEffect } from "react";
import { Mascot } from "../../brand";
import { SpiderWeb } from "../../runner/effects";
import { loadWizardFont } from "../../runner/fonts";

const LIGHT = { ground: "#faf8f5", ink: "#1f1b16", soft: "#6b6259" };
const DARK = { ground: "#17131d", ink: "#f4efe8", soft: "#b4aabd" };

/**
 * A small run page in the wizard's look: its ground, a heading and a line of text in its fonts,
 * the start button in its accent, its engenty, and its effects drawn small — in the pages the
 * theme prefers. Without a theme it shows the runner's own look. Drawn from values only: no
 * theme ever reaches the studio's page as CSS.
 */
export function LookPreview({ def, theme }: { def: WizardDefinition; theme: Theme | undefined }) {
  const mode =
    theme?.light && !theme.dark
      ? "light"
      : theme?.dark && !theme.light
        ? "dark"
        : (theme?.prefer ?? "light");
  const colours = theme?.[mode] ?? {};
  const dark = colours.background ? luminance(colours.background) < 0.18 : mode === "dark";
  const tone = dark ? DARK : LIGHT;
  const ground = colours.background ?? tone.ground;
  const accent = colours.accent ?? "#e0531b";
  const effects = new Map((theme?.effects ?? []).map((e) => [e.id, e]));
  const glow = effects.has("glow");
  const heading =
    theme?.fonts?.heading && theme.fonts.heading !== "brand" ? theme.fonts.heading : null;
  const text = theme?.fonts?.text && theme.fonts.text !== "brand" ? theme.fonts.text : null;
  useEffect(() => {
    loadWizardFont(heading);
    loadWizardFont(text);
  }, [heading, text]);
  const corners = effects.get("corners")?.kind;
  const figures = effects.get("figures");
  return (
    <div
      className="relative h-28 overflow-hidden rounded-xl ring-1 ring-border-soft"
      style={{ background: ground, color: colours.text ?? tone.ink }}
    >
      {effects.has("fog") ? (
        <div
          className="absolute inset-x-0 bottom-0 h-1/2 blur-md"
          style={{
            background: `radial-gradient(ellipse 60% 70% at 30% 100%, color-mix(in oklch, ${tone.ink} 22%, transparent), transparent 70%), radial-gradient(ellipse 50% 60% at 75% 100%, color-mix(in oklch, ${accent} 18%, transparent), transparent 70%)`,
          }}
        />
      ) : null}
      {corners === "webs" ? (
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
            className={`truncate text-[1.125rem] leading-tight ${theme?.shape?.headings === "uppercase" ? "uppercase tracking-wide" : ""}`}
            style={{
              fontFamily: heading ? `"${heading}"` : "var(--f-display)",
              textShadow: glow
                ? `0 0 0.6em color-mix(in oklch, ${accent} 75%, transparent)`
                : undefined,
            }}
          >
            {def.title}
          </div>
          <div
            className="mt-0.5 truncate text-[0.8125rem]"
            style={{ fontFamily: text ? `"${text}"` : "var(--f-ui)", color: tone.soft }}
          >
            {def.description || def.intro}
          </div>
          <div
            className="mt-2 inline-flex h-6 w-20 items-center justify-center"
            style={{
              background: accent,
              borderRadius: theme?.shape?.radius === "sharp" ? "0.3rem" : "999px",
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
        {figures ? (
          <div className="absolute top-2 right-16 rotate-[-8deg]">
            <Mascot
              kind="round"
              costume={typeof figures.costume === "string" ? (figures.costume as never) : undefined}
              size={30}
              interactive={false}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
