---
title: Space
description: What your wizards share and produce – who you are, what they look things up in, and the results of their runs.
version: 0.5.0
---

Your space holds what all your wizards share, and what they produce. Every AI step knows it, so a
wizard never has to ask for your company’s name or address.

You open it in two ways:

- The house in the app bar, after the space’s tile, opens the space’s page.
- The button left of the space’s name in the top bar (“Space menu”) opens the sidebar. It lists “Wizards”,
  “New wizard” and, under “Space”, the space’s four parts. On a narrow window the sidebar stays
  closed.

The menu on the left shows the space’s four parts. A part opens its own sections, and the arrow
at the top leads back. While the sidebar is open, the menu stands in it. On a phone, the parts,
a part’s sections and the page take turns.

| Part | Sections | Used for |
|---|---|---|
| Info & brand | Basics, Facts, Logos, Colours, Brand assets | Who you are and how you look |
| Knowledge | All, then each category, then the sections plugins add | What every AI step looks things up in |
| Data | All data, General, then each wizard | Tables and pages the wizards keep |
| Results | All results, then each wizard | The runs that reached their result |

## Info & brand

Logos, Colours and Brand assets each have an “Add” menu in their head.

| Section | Holds | Used for |
|---|---|---|
| Basics | “Title” and “About”: what you do, for whom, and the tone you write in | Texts sound like you. People who run a wizard see the title too |
| Facts | Labelled values: address, VAT ID, opening hours | Steps use them as written |
| Logos | One or several, each with a description of what it is for. Upload one, or take it from a web address (“Logo from URL”) | People see the main logo. The description tells a step what a variant is for |
| Colours | Named colours, each with a note on its use. Add one, or read them off a web page (“Colours from URL”) | The first colour is the accent of documents, dashboards and public pages |
| Brand assets | Images, videos, audio, PDFs, fonts, Lottie and 3D files, in tabs you can search | AI steps place pictures in documents and choose them by their description |

## Knowledge

Knowledge is the ground truth your wizards’ steps look things up in: pages, tables and files. You
see here exactly what a step can find. Drop documents on the page, or add a page or a table
yourself (“New page”, “New table”). A table can be an FAQ, with a question and its answer per row.

- **Documents become pages and tables when they arrive.** A PDF, a Word file or a scan becomes a
  page. The original stays behind it (“Original”), and the page marks where each page of it
  begins, so a step can quote “p. 2”. A long document with headings of its own, such as a law or
  a manual, becomes a page with sub-pages, one per section; “§ 281” in the text links to that
  sub-page. A workbook becomes a table per sheet, and a CSV becomes one table. What can’t be read
  stays a file, and steps find it by its name and description. A scan that read badly is marked
  “Check”.
- **Categories keep things apart.** A category is a property with a type: a choice (building
  site, type of funding), a date, a number with its unit, a text, or yes/no. You set them on a
  page, a table or a file with the chips under its title. When a document arrives, a model fills
  them in from what it reads. A table’s column can be one. A step filters by them before it
  searches: “reports of Graz Süd in March” is a filter first.
- **Each value of a choice** has its contents (everything that has this value) and an overview.
  A model writes the overview when you ask for it (“Write the overview”). The search finds the
  overview like a page.
- **Two spellings of one value** (“Graz-Süd”, “Graz Süd”) are offered for merging on the
  category’s page. A category that a source proposes stands as “Proposed” until you accept it.
- **“Try a search…”** searches the way a step does: the filters first, then words and meaning.
  Then a model asks of each hit whether it answers the question, keeps those that do and says how
  sure it is. That check is quickest with a decision model, which needs an AI Gateway or TypeSafe
  key, or an account. Searching by meaning needs an AI Gateway or OpenAI key, or an account;
  without one, the search finds words only. See [Models and account](./models.md).

A plugin can fill Knowledge from outside, from a website or a folder, for example. What it wrote
shows where it came from (“From …”). Once you change it by hand, it stays yours, and the plugin
no longer updates it.

## Data

Data holds the tables and pages of the space and its wizards. Those of the space itself stand
under “General”, a wizard’s under its name. A wizard fills its own: a shared list becomes one of
its tables, and a step with the “Pages” tool writes its pages. The columns of a shared list come
from the wizard. The buttons “Table” and “Page” add one, for the space or for one of its
wizards.

- **Table**: columns of a type (text, number, date, duration, choice, yes/no) and a row per
  line. Type into a cell; it is saved when you leave it. A value that doesn’t fit the column is
  marked and not saved. The heading of a column changes its name and type, and the plus beside
  the headings adds a column.
- **Page**: a title and text in Markdown. “Write” edits it, and “Preview” shows it. It is saved
  as you type.

### On your computer and in the cloud

Data stays where it was written. A wizard’s tables and pages are filled where it runs: on your
computer by its runs there, in the cloud by the runs over its link. The pages and tables of
Knowledge, with their categories, go to the cloud with every wizard you publish there. The cloud
shows them without changing them. Files stay on your computer.

## Results

Results lists every run that reached its result, newest first: of all wizards, or of the one you
choose in the menu, where the wizard with the latest result stands first. The search finds words
in the wizard’s name, in what was answered and in what the run produced. The filters keep live or
test runs, and the last 24 hours, 7 or 30 days. A run opens beside the list as the person saw it,
with its files.

## Have it filled in

[Goose](./assistant.md), at the bottom of the page, fills in the space for you where it is
switched on. Tell it about yourselves, name your website or give it files:

> Read our website example.com

It enters what it finds: title, description, logo, colours and facts. You correct the rest.

In the cloud, the first visit to the studio does the same: it asks for your website and your
first documents. See [Create an account](./create-account.md).

## One space

engenty wizards on your computer has one space, called “My computer” at first (“Mein Computer” in German). On engenty.ai the
team’s plan says how many spaces it may have. The space’s name in the top bar opens a menu: it
switches between spaces, “Rename space” renames this one, and “Add space” adds one while the plan
has room. Each space
has its own wizards, Info & brand, Knowledge, Data, connectors and results. The account, the
models and the plugins are the same for every space.

When you publish wizards from your computer with an account signed in, their space shows up in
the cloud too, marked with a laptop. You can only look at it there: you edit it in engenty
wizards on your computer, and changes show up in the cloud the next time you publish a wizard.
