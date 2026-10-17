---
title: Quick start
description: A tool for AI steps in one file. No build, no restart.
version: 0.5.0
---

You write one file. The running app finds it, and every AI step can use the tool in it.

## 1. Find the plugins folder

| You run | The folder |
|---|---|
| engenty wizards on your computer (`wizards`) | `~/.engenty/wizards/plugins` |
| A checkout (`pnpm dev`) | The folders that `PLUGINS_DIR` names in `.env.local`, for example `PLUGINS_DIR=../my-plugins`. A relative path starts at the checkout’s root |

Start the app. It creates the folder if it is missing and watches it while it runs.

## 2. Write the plugin

Save this as `workdays.ts` in the plugins folder:

```ts
import { definePlugin } from "@engenty/wizards/plugin";
import { z } from "zod";

export default definePlugin((wizards) => {
  wizards.server.registerTool({
    name: "count",
    title: "Working days",
    description:
      "Counts the working days (Monday to Friday) from one date to another, both included.",
    inputSchema: z.object({
      from: z.string().describe("First day, YYYY-MM-DD"),
      to: z.string().describe("Last day, YYYY-MM-DD"),
    }),
    execute: async ({ from, to }, step) => {
      await step.emit("Counting working days …");
      const last = new Date(`${to}T00:00:00Z`);
      let workingDays = 0;
      for (let day = new Date(`${from}T00:00:00Z`); day <= last; day.setUTCDate(day.getUTCDate() + 1)) {
        if (day.getUTCDay() % 6 !== 0) {
          workingDays += 1;
        }
      }
      return { from, to, workingDays };
    },
  });
});
```

- The file’s name is the plugin’s id: `workdays`.
- The tool’s full id is `workdays.count`.
- `@engenty/wizards/plugin` and `zod` come from the app, so you don’t install anything.

## 3. See it

The app loaded the file the moment you saved it.

- **Settings → Plugins** lists `workdays`, with `workdays.count` under “Tools for steps”.
- **In the editor**, open an AI step: `workdays.count` is in its list of tools, beside
  `web_search` and the other built-in ones. The line below the list says “workdays.count =
  Working days”.
- **In the editor’s chat**, ask for it: “Add a step that counts the working days between the
  two dates.” The assistant knows the tool from its description.

In a wizard’s definition the step lists the tool by its full id:

```json
{
  "id": "countDays",
  "type": "agent",
  "title": "Count the working days",
  "instructions": "Count the working days from {{start}} to {{end}}.",
  "tools": ["workdays.count"],
  "model": "standard",
  "output": { "format": "json", "fields": [{ "id": "days", "kind": "number", "description": "Working days" }] }
}
```

## 4. Change it

Edit the file and save. The plugin loads again, and the next step that runs uses the new code.

If the file has an error, Settings → Plugins says “The server part didn’t load. Check the plugin
and reload” with the reason. Fix the file and save it again.

## Next

| To | Read |
|---|---|
| Keep data | [Tables](./tables.md) |
| React when a run ends | [Events](./events.md) |
| Show a page in the studio | [The studio half](./studio.md) |
| Give the plugin a name, a version and more than one file | [Files and manifest](./layout.md) |
