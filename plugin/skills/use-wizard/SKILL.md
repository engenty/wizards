---
name: use-wizard
description: Run one of the person's published engenty wizards here in the chat — a social post with an image, a research briefing, an offer, a video ad … page by page, with its review and its downloads. Use when the person wants something one of their wizards makes, names a wizard, or asks what their wizards can do.
---

# Use an engenty wizard

You work with the `engenty-wizards` MCP tools. The person you talk to runs the wizard; their answers fill its pages.

1. **Find it.** `list_wizards` lists the person's wizards; only `published` ones run. `show_wizard` only when the person wants to see a wizard before running it: apps that show MCP Apps show it as it greets a person, with its flow one click away.
2. **Start it.** `run_wizard` straight away; apps that show MCP Apps show the wizard itself, page by page, and the person may answer there. What the person already said for the first page goes in with `answer_form`, using the field ids in `waitingFor`. Runs spend credits like any run of the wizard.
3. **Follow `waitingFor`.**
   - `form`: ask for the fields with `inChat: true`, in the person's words, then `answer_form`. Fields with `inChat: false` (files, recordings, signatures, line items) need the run page: hand over `browserUrl`.
   - `review`: show the outputs (texts, image links), then `review_step`: accept, or regenerate one with the person's note.
   - `ask`: a step wants to change something in a connected account. Ask the person, then `answer_ask` with `allow` or `skip`. A sign-in happens on the run page (`browserUrl`).
   - Nothing, status `running`: `get_run` with `waitSeconds: 45`, again until it changes.
4. **In a widget.** When the app shows the run as a widget, the person may answer there instead of in the chat. Call `get_run` before you ask again, so you never ask for a page that is already answered.
5. **Hand over.** When the status is `done`, give the outputs and their download links (valid one hour). `failed`: say what went wrong; `control_run` with `retry` tries the step again.
