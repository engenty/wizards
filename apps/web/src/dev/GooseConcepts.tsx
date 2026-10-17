import furSheet from "./assets/goose-concept-red-fur.webp";
import jellySheet from "./assets/goose-concept-red-jelly.webp";
import { builderCopy as copy } from "./engenty-builder-copy";
import { GooseAviators } from "./GooseAviators";

const LOOKS = ["classic", "helmetAviator", "noHelmet", "singleLens"] as const;

export function GooseConcepts() {
  return (
    <section aria-labelledby="goose-heading" className="mt-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {copy.gooseEyebrow}
          </p>
          <h2 id="goose-heading" className="text-2xl font-semibold tracking-tight">
            Goose
          </h2>
        </div>
        <p className="max-w-md text-sm text-muted-foreground">{copy.gooseIntro}</p>
      </div>
      <div className="grid gap-5">
        {(
          [
            ["fur", furSheet],
            ["jelly", jellySheet],
          ] as const
        ).map(([coat, sheet]) => (
          <div key={coat}>
            <h3 className="mb-2 text-sm font-semibold">
              {copy[coat === "fur" ? "furry" : "jelly"]}
            </h3>
            <div className="overflow-x-auto rounded-xl bg-[#f6efe2]">
              <div className="relative min-w-[780px]">
                <img
                  alt={`${copy[coat === "fur" ? "furry" : "jelly"]}: ${copy.gooseArtAlt}`}
                  className="block h-auto w-full"
                  height={1161}
                  loading="lazy"
                  src={sheet}
                  width={1354}
                />
                <GooseAviators coat={coat} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{copy.gooseConceptNote}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {LOOKS.map((look, index) => (
          <div className="px-1" key={look}>
            <p className="font-mono text-xs text-muted-foreground">0{index + 1} / GOOSE</p>
            <h3 className="mt-1 font-semibold">{copy.goose[look].name}</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {copy.goose[look].description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
