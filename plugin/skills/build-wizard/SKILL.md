---
name: build-wizard
description: Build or change an engenty wizard — a page-by-page AI flow that people open on a shared link (questions, research, texts, images, video, documents, dashboards, writes into other systems). Use when the user wants such a wizard, a guided form with AI steps, or wants to change, test or publish one.
---

# Build an engenty wizard

You work with the `engenty-wizards` MCP tools. The person you talk to is the ADMIN; the people who later open the wizard's link are END USERS.

1. **Read the guide first.** Call `get_authoring_guide` once per conversation. It holds the JSON schema, the design rules and the space's connected systems. Follow it.
2. **Start from an example.** `list_starters`, then `get_starter` for the closest one. For an existing wizard, use `list_wizards` and `get_wizard`.
3. **Write it.**
   - Use `create_wizard` with the full definition and a short `note` in the admin's language. The admin sees that note in the studio.
   - Change it with `edit_wizard` ops (`set_meta`, `upsert_step`, `remove_step`, `move_step`). Pass the `revision` you last read as `baseRevision`.
   - Keep going until `issues` is empty. On `revision_conflict`, call `get_wizard` again and redo your change on top. The admin may be editing in the studio at the same time.
4. **Test it.**
   - `start_test_run` takes realistic `answers`: field id → value, for every page. Then call `get_test_run` with `waitSeconds: 45` until the status is no longer `running`.
   - Read the outputs and open the download links. Fix what is weak, then test again.
   - Test runs spend the admin's credits: short copy with an image costs about 15, research about 150, an 8-second video about 250. Ask before running video or heavy research more than once.
5. **Hand over.** Give the admin the `studioUrl`; the studio shows the wizard as a diagram and updates live while you edit. Publish with `publish_wizard` only when the admin asks. Then share the `shareUrl`.

Design rules the guide expands on:
- Few pages with 1–5 questions each, phrased in plain words.
- Put a review step before anything expensive and before the result.
- Totals come from an `items` field with VAT, never from a model.
- Facts come from `web_search` and `web_fetch` before anything is written.
- Write every text in the admin's language.
