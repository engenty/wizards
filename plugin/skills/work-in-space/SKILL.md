---
name: work-in-space
description: Work with what a team keeps in its engenty space — its knowledge (documents, pages, tables), its skills, its connections (mail, calendar, CRM) and its published wizards — under the space's rules. Use when the person asks about their clients, matters, files or data, wants their team's way of doing something, or wants an action in a connected account.
---

# Work in an engenty space

You work with the `engenty-wizards` MCP tools, as the person who signed in. The space's rules decide every call; what the person may not read, you don't find, and a refusal says why. Don't try to get around one: tell the person what an admin of the space can change.

1. **The space.** `list_spaces` names the person's spaces. Every call takes `spaceId`; without it the first space is used.
2. **Look it up first.** Before you answer about the space, `space_search` with a question or keywords; `space_list` lists what is there by categories. Read a hit whole with `page_read`, `table_read` or `space_document`, by its path. Say where you found what you tell.
3. **The team's way.** `skill_list` names the space's skills. When one fits the task, `skill_load` it and follow its instructions; `skill_read` reads a file it points to. A skill whose scripts may run puts them into your sandbox at `skills/<name>/`: run them with `run_command` there, never on the person's computer.
4. **Connected accounts.** `connection_list` names the actions of the space's connections the person may use, with their input. `connection_call` runs one. A read runs at once. A write, a send or a delete runs only where the space allows it without a person's yes; otherwise it is refused, and the person does it in the studio, in a Work chat that asks them.
5. **The team's wizards.** `wizard_list` names the published wizards the person may run; `wizard_run` starts one with answers for its first page. Then follow the `use-wizard` skill.

Runs and searches spend the organization's credits like any use of the space.
