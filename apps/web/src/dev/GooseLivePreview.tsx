import { FluffyEngenty } from "../engenty/fluffy-engenty";
import { builderCopy as copy } from "./engenty-builder-copy";

const GOOSE_KINDS = ["round", "dome", "drop"] as const;

interface GooseLivePreviewProps {
  animationSpeed: number;
  background: string;
  foreground: string;
  interactive: boolean;
  motion: "auto" | "play" | "pause";
  turn?: { yaw: number; pitch: number };
}

export function GooseLivePreview({
  animationSpeed,
  background,
  foreground,
  interactive,
  motion,
  turn,
}: GooseLivePreviewProps) {
  return (
    <section aria-labelledby="goose-live-heading" className="mt-10">
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          {copy.gooseLiveEyebrow}
        </p>
        <h2 id="goose-live-heading" className="text-2xl font-semibold tracking-tight">
          {copy.gooseLiveTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{copy.gooseLiveNote}</p>
      </div>
      <div className="grid gap-6">
        {GOOSE_KINDS.map((kind) => (
          <div key={kind}>
            <h3 className="mb-2 text-sm font-medium capitalize">{kind}</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {(["fur", "jelly"] as const).map((coat) => (
                <div
                  className="flex min-w-0 flex-col items-center justify-center overflow-hidden rounded-xl py-4"
                  key={coat}
                  style={{ background, color: foreground }}
                >
                  <FluffyEngenty
                    animationSpeed={animationSpeed}
                    coat={coat}
                    gooseHelmet
                    interactive={interactive}
                    kind={kind}
                    motion={motion}
                    size={320}
                    turn={turn}
                  />
                  <span className="pb-2 text-sm font-medium">
                    {copy[coat === "fur" ? "furry" : "jelly"]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
