// dist/runner.css: the look of a wizard's page for a host without Tailwind — the utilities the
// components use, the light tokens as values, the helper rules of the studio's app.css — every
// rule scoped to `.engenty-runner`, so a website's own styles and the runner's never meet.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/postcss";
import postcss from "postcss";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOPE = ".engenty-runner";

/** Every selector under the scope; the roots (`:root`, `html`, `body`) become the scope itself. */
const scoped = {
  postcssPlugin: "engenty-scope",
  Rule(rule) {
    if (rule.parent?.type === "atrule" && /keyframes|property|font-face/.test(rule.parent.name)) {
      return;
    }
    if (rule.scoped) {
      return;
    }
    rule.selectors = rule.selectors.map((s) => {
      const bare = s.trim();
      if (bare === ":root" || bare === "html" || bare === "body" || bare === ":host") {
        return SCOPE;
      }
      if (bare.startsWith(SCOPE)) {
        return bare;
      }
      // `.dark .x` keeps its theme class outside the scope.
      return `${SCOPE} ${bare}`;
    });
    rule.scoped = true;
  },
};

const source = readFileSync(join(root, "src/standalone.css"), "utf8");
const result = await postcss([tailwind({ base: join(root, "src") }), scoped]).process(source, {
  from: join(root, "src/standalone.css"),
  to: join(root, "dist/runner.css"),
});
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/runner.css"), result.css);
console.log(`dist/runner.css ${(result.css.length / 1024).toFixed(0)} KB`);
