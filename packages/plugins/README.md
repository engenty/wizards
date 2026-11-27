# @engenty/plugins

The plugin contract engenty wizards and wizards.bot both load. MIT; it needs zod 4 beside it and
Node 24.11 or later.

- **The manifest.** `engenty.plugin.json`: `id`, `name`, `version`, `description`, `server` (the
  file that registers tools) and `skills` (a folder of skills, each a folder with a `SKILL.md`).
  `pluginManifestSchema` checks it and keeps the fields a host adds of its own.
- **Finding plugins.** `discoverPlugins(folders)` (from `@engenty/plugins/node`): a folder with a
  manifest, a folder with an `index.ts`, one `.ts` file, or a package below `node_modules`. Of two
  with one id the first stays; what is no plugin comes back as a problem with its path.
- **A plugin and its tools.** `definePlugin(api => …)` and `api.server.registerTool({ name,
  description, inputSchema, readOnly, execute })`. `inputSchema` is a zod schema or a JSON Schema;
  `readOnly: true` says the tool changes nothing, and a host asks the person before any other tool
  runs. engenty wizards' `WizardsPluginApi` is a superset of `PluginApi`: a plugin that uses only
  this loads in both, and `@engenty/wizards/plugin` may stay its import.
- **Fewer rights.** `startPluginProcess({ source, dataDir })` runs the plugin's server half in a
  Node process of its own under Node's permission model: it reads its own folder, writes only
  `dataDir`, starts no process, worker or addon, and gets none of the host's environment. Node 24
  has no network permission, so a host gives such a plugin no secrets.

```ts
import { discoverPlugins, startPluginProcess } from "@engenty/plugins/node";

const { found, problems } = discoverPlugins([pluginsFolder]);
for (const source of found.filter((s) => s.entry)) {
  const plugin = await startPluginProcess({ source, dataDir: join(dataFolder, source.id) });
  console.log(plugin.tools); // name, description, inputSchema as JSON Schema, readOnly
  await plugin.call("greet", { who: "Ada" }, { signal, emit: (line) => console.log(line) });
}
```

A plugin:

```ts
import { definePlugin } from "@engenty/plugins";
import { z } from "zod";

export default definePlugin((api) => {
  api.server.registerTool({
    name: "greet",
    description: "Greets someone by name.",
    readOnly: true,
    inputSchema: z.object({ who: z.string() }),
    execute: ({ who }) => `Hello ${who}`,
  });
});
```
