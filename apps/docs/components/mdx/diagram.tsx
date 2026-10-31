/**
 * A diagram of docs/assets/diagrams, drawn inline so its classes take the theme's colours
 * (lib/remark-diagrams.ts). On a narrow screen it keeps a readable size and scrolls sideways.
 */
export function Diagram({ svg, alt }: { svg: string; alt: string }) {
  return (
    <figure className="diagram not-prose" role="img" aria-label={alt}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own SVG files from the repository */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </figure>
  );
}
