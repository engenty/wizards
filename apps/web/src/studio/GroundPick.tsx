import { Check } from "lucide-react";
import { type Key, t } from "../lib/i18n";
import {
  BRANDED_GROUNDS,
  type BrandedGround,
  setBrandedGround,
  useBrandedGround,
} from "../lib/theme";
import { cn } from "../ui";

const NAME: Record<BrandedGround, Key> = {
  cobalt: "theme.ground.cobalt",
  violet: "theme.ground.violet",
  berry: "theme.ground.berry",
  petrol: "theme.ground.petrol",
  emerald: "theme.ground.emerald",
  brick: "theme.ground.brick",
  citron: "theme.ground.citron",
};

/**
 * The colours of the branded theme as round swatches: each its ground with the accent of its
 * buttons, and its name on hover. Picking one also picks the branded theme.
 */
export function GroundPick({ onPick }: { onPick?: () => void }) {
  const picked = useBrandedGround();
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5 border-0 p-0">
      <legend className="sr-only">{t("theme.ground")}</legend>
      {BRANDED_GROUNDS.map(({ ground, stage, accent }) => (
        <button
          aria-label={t(NAME[ground])}
          aria-pressed={ground === picked}
          className={cn(
            "relative grid size-7 cursor-pointer place-items-center rounded-full ring-1 ring-border transition-transform hover:scale-110 motion-reduce:transition-none",
            ground === picked && "ring-2 ring-ink",
          )}
          key={ground}
          onClick={() => {
            setBrandedGround(ground);
            onPick?.();
          }}
          style={{ background: stage }}
          title={t(NAME[ground])}
          type="button"
        >
          {ground === picked ? (
            <Check className="size-3.5" style={{ color: accent }} strokeWidth={3} />
          ) : (
            <span className="size-2 rounded-full" style={{ background: accent }} />
          )}
        </button>
      ))}
    </fieldset>
  );
}
