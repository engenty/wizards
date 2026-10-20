---
title: MCP Apps
description: AI apps that support MCP Apps show the wizard itself as a widget, page by page, in the app’s own look.
version: 0.9.0
---

[What an app can do](../../user-guide/ai-apps.md#what-an-app-can-do) in the user guide lists what an app
with MCP Apps shows. This page adds how the widget looks.

## The look in an AI app

The widget looks like the app it runs in. That is the theme `host`: the widget takes what the
app hands every MCP App in its host context (`styles`).

| The app hands over | The widget takes it for |
|---|---|
| `theme`, light or dark | Its light or dark pages |
| `--color-background-primary` | The ground and the cards |
| `--color-background-secondary`, `-tertiary` | Quieter areas on the ground |
| `--color-text-primary`, `-secondary`, `-tertiary` | Text, hints and quiet text |
| `--color-border-primary` | Lines and the frames of fields |
| `--font-sans`, `--font-mono` | Text and headings, and code |
| `--border-radius-md` | Corners |
| `css.fonts` | The fonts behind `--font-sans` |

What the app leaves out comes from the space’s brand, such as the accent of buttons. The
widget’s light or dark follows the app, also when the person switches it there.

## A theme of the wizard

When the person asks for the wizard’s own look, the model passes `theme` to `run_wizard`: the id of
one of the wizard’s themes (its definition’s `themes`), `brand` or `default`. The widget then
shows that theme as the wizard’s own page does: colours, fonts, shape and effects. A theme with
only dark or only light pages keeps them, whatever the app shows.

A theme the wizard does not wear, or none, leaves the widget in the app’s look. The runtime
checks the id against the wizard’s chain before it hands the widget the theme’s values
(`look` in the widget’s data, `theme` beside it).
