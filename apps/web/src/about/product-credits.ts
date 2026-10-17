/**
 * The credits written by hand, shown above the generated list of dependencies
 * (oss-credits.json, `pnpm about:data`): the product itself and what it is mainly built with.
 */

import type { Key } from "../lib/i18n";

export interface ProductCredit {
  name: string;
  /** Its line in the studio's strings. */
  description: Key;
  homepage: string;
  license: string;
}

/** The product and the engenty code it builds on. */
export const ENGENTY_CREDITS: ProductCredit[] = [
  {
    name: "engenty wizards",
    description: "credit.engenty-wizards",
    homepage: "https://github.com/engenty/wizards",
    license: "FSL-1.1-MIT",
  },
  {
    name: "engenty",
    description: "credit.engenty",
    homepage: "https://github.com/engenty/engenty",
    license: "FSL-1.1-MIT",
  },
];

/** The main open-source building blocks. */
export const HIGHLIGHT_CREDITS: ProductCredit[] = [
  {
    name: "Mastra",
    description: "credit.mastra",
    homepage: "https://github.com/mastra-ai/mastra",
    license: "Apache-2.0",
  },
  {
    name: "AI SDK",
    description: "credit.ai-sdk",
    homepage: "https://github.com/vercel/ai",
    license: "Apache-2.0",
  },
  {
    name: "Model Context Protocol",
    description: "credit.model-context-protocol",
    homepage: "https://github.com/modelcontextprotocol/typescript-sdk",
    license: "MIT",
  },
  {
    name: "Hono",
    description: "credit.hono",
    homepage: "https://github.com/honojs/hono",
    license: "MIT",
  },
  {
    name: "Drizzle ORM",
    description: "credit.drizzle-orm",
    homepage: "https://github.com/drizzle-team/drizzle-orm",
    license: "Apache-2.0",
  },
  {
    name: "libSQL",
    description: "credit.libsql",
    homepage: "https://github.com/tursodatabase/libsql",
    license: "MIT",
  },
  {
    name: "Playwright",
    description: "credit.playwright",
    homepage: "https://github.com/microsoft/playwright",
    license: "Apache-2.0",
  },
  {
    name: "React",
    description: "credit.react",
    homepage: "https://github.com/facebook/react",
    license: "MIT",
  },
  {
    name: "Vite",
    description: "credit.vite",
    homepage: "https://github.com/vitejs/vite",
    license: "MIT",
  },
  {
    name: "Tailwind CSS",
    description: "credit.tailwind-css",
    homepage: "https://github.com/tailwindlabs/tailwindcss",
    license: "MIT",
  },
  {
    name: "React Flow",
    description: "credit.react-flow",
    homepage: "https://github.com/xyflow/xyflow",
    license: "MIT",
  },
  {
    name: "TanStack Query",
    description: "credit.tanstack-query",
    homepage: "https://github.com/TanStack/query",
    license: "MIT",
  },
  {
    name: "xterm.js",
    description: "credit.xterm-js",
    homepage: "https://github.com/xtermjs/xterm.js",
    license: "MIT",
  },
  {
    name: "Lucide",
    description: "credit.lucide",
    homepage: "https://github.com/lucide-icons/lucide",
    license: "ISC",
  },
  {
    name: "Geist & Geist Mono",
    description: "credit.geist-geist-mono",
    homepage: "https://github.com/vercel/geist-font",
    license: "OFL-1.1",
  },
  {
    name: "Space Grotesk",
    description: "credit.space-grotesk",
    homepage: "https://github.com/floriankarsten/space-grotesk",
    license: "OFL-1.1",
  },
  {
    name: "git-cliff",
    description: "credit.git-cliff",
    homepage: "https://github.com/orhun/git-cliff",
    license: "MIT OR Apache-2.0",
  },
];
