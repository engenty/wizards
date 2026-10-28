import { Moon, Sun } from "lucide-react";
import { lazy, Suspense } from "react";
import type { EngentyKind } from "./engenty/colors";
import type { EngentyCostume } from "./engenty/costume-fit";
import { Engenty } from "./engenty/engenty";
import type { EngentyCoat } from "./engenty/fur-stage";
import { EngentyLogoMark } from "./engenty/logo";
import { t } from "./lib/i18n";
import { setTheme, stageFill, useTheme, useThemePinned } from "./lib/theme";
import { IconButton } from "./ui";

export const BRAND = {
  name: "engenty wizards",
  short: "wizards",
};

const Fluffy = lazy(() =>
  import("./engenty/fluffy-engenty").then((m) => ({ default: m.FluffyEngenty })),
);

/**
 * The engenty a wizard wears. Large sizes get a coat that suits the page: fur
 * on the light paper, jelly on the dark theme's engenty-coloured ground. A
 * jelly asked for in light stands on a coloured stage of its own — the gel
 * only reads against an intense, dark fill. Small ones stay flat, where a coat
 * would read as noise.
 */
export function Mascot({
  kind,
  size = 64,
  fluffy,
  coat,
  costume,
  helmet = false,
  interactive = true,
}: {
  kind: string;
  size?: number;
  fluffy?: boolean;
  coat?: EngentyCoat;
  /** A Halloween costume. */
  costume?: EngentyCostume;
  /** Goose's flight helmet. */
  helmet?: boolean;
  interactive?: boolean;
}) {
  const k = (kind || "round") as EngentyKind;
  const theme = useTheme();
  const wear = coat ?? (theme === "dark" ? "jelly" : "fur");
  if (fluffy && size >= 120 && (wear === "fur" || theme === "dark")) {
    return (
      <Suspense
        fallback={
          <Engenty costume={costume} helmet={helmet} kind={k} size={Math.round(size * 0.62)} />
        }
      >
        <Fluffy
          costume={costume}
          gooseHelmet={helmet}
          coat={wear}
          kind={k}
          size={size}
          quality="medium"
          interactive={interactive}
        />
      </Suspense>
    );
  }
  if (fluffy && size >= 120) {
    const inner = Math.round(size * 1.08);
    return (
      <div
        aria-hidden="true"
        className="relative flex items-center justify-center overflow-hidden"
        style={{
          background: stageFill(k),
          borderRadius: size * 0.28,
          height: size,
          width: size,
        }}
      >
        <span
          className="pointer-events-none absolute rounded-full bg-white"
          style={{
            filter: `blur(${size * 0.18}px)`,
            height: size * 0.8,
            opacity: 0.16,
            right: -size * 0.3,
            top: -size * 0.3,
            width: size * 0.8,
          }}
        />
        <div className="relative" style={{ marginTop: size * 0.04 }}>
          <Suspense
            fallback={
              <Engenty costume={costume} helmet={helmet} kind={k} size={Math.round(inner * 0.62)} />
            }
          >
            <Fluffy
              costume={costume}
              gooseHelmet={helmet}
              coat="jelly"
              kind={k}
              size={inner}
              quality="medium"
              interactive={interactive}
            />
          </Suspense>
        </div>
      </div>
    );
  }
  return <Engenty costume={costume} helmet={helmet} kind={k} size={size} animated={interactive} />;
}

/**
 * `place`: where in the product the person is, named after the wordmark. `mark`: false where the
 * mark stands elsewhere already (the studio's app bar), so only the wordmark is written.
 */
export function Logo({
  onClick,
  place,
  mark = true,
}: {
  onClick?: () => void;
  place?: string;
  mark?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 items-center gap-2.5 whitespace-nowrap rounded-full pr-2 text-ink"
    >
      {mark ? <EngentyLogoMark size={30} /> : null}
      <span className="font-display font-semibold text-[1.0625rem] tracking-tight">
        engenty<span className="text-ember">.</span>
        {/* With a place to name, a phone has no room for the product's own name. */}
        <span
          className={
            place
              ? "ml-1 font-normal text-ink-3 max-sm:hidden"
              : "ml-1 font-normal text-ink-3 max-[420px]:hidden"
          }
        >
          {BRAND.short}
        </span>
        {place ? (
          <>
            <span className="mx-2 font-normal text-ink-4 max-sm:hidden">/</span>
            <span className="font-medium text-ink max-sm:ml-1.5">{place}</span>
          </>
        ) : null}
      </span>
    </button>
  );
}

export function ThemeToggle() {
  const theme = useTheme();
  // A wizard that sets dark or light pages keeps them so.
  const pinned = useThemePinned();
  // Back to dark goes to the branded one, the default.
  const next = theme === "dark" ? "light" : "branded";
  if (pinned) {
    return null;
  }
  return (
    <IconButton
      label={t(next === "branded" ? "theme.branded" : "theme.light")}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </IconButton>
  );
}
