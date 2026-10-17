import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";

// The pages live in docs/content at the repo root, as in the engenty repo.
export const docs = defineDocs({
  dir: "../../docs/content",
  docs: {
    schema: frontmatterSchema.extend({
      // The release whose code the page was last checked against: `0.2.48`. A page without one
      // does not build. `pnpm docs:check` lists the pages behind the current release.
      version: z.string().regex(/^\d+\.\d+\.\d+$/, "version: a release like 0.2.48"),
    }),
  },
});

export default defineConfig({
  mdxOptions: {
    // Run before GFM/heading so ```mermaid fences become <Mermaid /> reliably.
    remarkPlugins: (preset) => [remarkMdxMermaid, ...preset],
  },
});
