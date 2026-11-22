# Plan: the runtime loads plugins through @engenty/plugins

Status: plan, written on 2026-11-22 against v0.20.2. `@engenty/plugins` (`packages/plugins`) is
the plugin contract engenty wizards and wizards.bot both load; wizards.bot loads its plugins
through it (wizards-bot `docs/plugins.md`). The runtime still has its own copy of the parts the
package took over. This plan moves the runtime onto the package, in PRs of their own.

## What the package has

| Part | In the package | In the runtime today |
|---|---|---|
| Manifest schema, `MANIFEST_FILE`, `PLUGIN_ID`, `TOOL_NAME` | `src/manifest.ts` | `plugins/discovery.ts` (`manifestSchema`), `packages/shared` (`PLUGIN_ID`, `PLUGIN_TOOL_NAME`) |
| Finding plugins in folders | `discoverPlugins`, `insidePlugin`, `readManifest` | `plugins/discovery.ts` (the same code) |
| `PluginTool`, `PluginApi`, `definePlugin` | `src/plugin.ts`: the subset every host offers, plus `readOnly` | `packages/wizards/src/plugin` (`WizardsPluginApi`, the superset) |
| A plugin's tools in a process with fewer rights | `startPluginProcess` | none: every server half runs in the runtime's process (`plugins/loader.ts`, jiti) |
| Skills a plugin brings (`skills/<name>/SKILL.md`) | `skillsDir` | none |

## Steps

1. **Discovery from the package.** `plugins/discovery.ts` keeps what is the runtime's own (the
   studio half, its styles, `pro`) and calls `discoverPlugins(dirs, { manifest })` with
   `pluginManifestSchema.extend({ studio, styles, features })`. `PLUGIN_ID` and
   `PLUGIN_TOOL_NAME` in `packages/shared` become re-exports of the package's. No change a
   plugin sees; `apps/runtime/test/plugins.test.ts` stays green as it is.
2. **The types from the package.** `PluginTool` in `@engenty/wizards/plugin` extends the
   package's (`readOnly` included), `WizardsPluginApi` extends `PluginApi`. A wizard step runs
   with the person in front of it, so `readOnly` does not ask there; it sets the default `risk`
   of a tool also offered to the space assistant (`readOnly` → `read`, otherwise `outside`).
3. **Skills of a plugin.** A plugin's `skills/` reaches the space's skills (docs/plans/skills.md)
   the way a space's own do, named `<plugin id>.<skill>`.
4. **Installed plugins in a process.** What Settings › Plugins installs from a zip or a folder
   (`plugins/install.ts`, “Nobody checked them”) runs its tools through `startPluginProcess`:
   its own folder, its data folder below `DATA_DIR/plugin-data/<id>`, no environment, no
   `seal`/`unseal`, no tenant database. A plugin that needs more of the server API than tools
   (routes, runners, tables, the space) keeps loading in the process of the runtime and says so
   in the manifest (`"trusted": true`), which only the modules of the runtime, Pro modules and
   `PLUGINS_DIR` may set. Settings › Plugins shows which of the two a plugin is.

Step 4 is the one a person notices: a plugin installed from a zip that used more than tools
stops loading until it is marked. The modules in `modules/` and the Pro modules are first-party
and stay in the process.

## Not in this plan

- Routes, runners, tables, events and the studio half stay `WizardsPluginApi` alone; wizards.bot
  has no studio, and its pages are the home's.
- A catalog both products install from: the Manage-App's Pro modules stay engenty wizards'.
