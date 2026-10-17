---
title: Steps
description: What a wizard is made of – pages, AI steps, generated media, widgets, reviews and the result.
version: 0.5.0
---

A wizard runs its steps from top to bottom. The last step is always the result.

| Step | What it does |
|---|---|
| Page | Asks the person: one to five fields |
| AI step | Does a task with tools: research, read documents, call an API, work in a connected service |
| Generate | Makes one thing: an image, a video, a voice-over, a document or a dashboard |
| Widget | Shows an interactive view built once for this wizard: a map, a timeline, a calculator, a film |
| View | Shows the results in the wizard’s own look: key figures, facts, a list, a chart |
| Film | Has the AI client on your computer make a film as code, rendered to an MP4 |
| Review | Shows what earlier steps made. The person accepts it, edits it or asks for a new version |
| Result | The last page: what the person can download or share |

## Pages

A page has a title, up to five fields and a button. Each field has a kind:

| Kind | The person |
|---|---|
| Short text, Long text, Number, Date, Email, Link | types a value |
| Choice, Multiple choice, Yes/no, Colour | chooses |
| Image upload | takes or uploads photos, one or several, in an order they can change |
| File upload | uploads documents. The camera can scan papers and record a short clip |
| Line items (table) | fills rows with amounts. The wizard works out net, VAT and total |
| Location | taps “Use my location” or types an address |
| Voice note | records up to 5 minutes. The wizard writes down what was said before the next step reads it. You choose who writes it down under Voice notes in [Models](./models.md); a Mac can do it itself |
| Signature | signs with a finger |
| Appointment | chooses one of the free times offered, shown by day |
| Connect an account | connects their own account of a service, for example their mailbox |
| Saved list | checks, corrects and extends a list the wizard keeps for them |

A text field can have a “Scan” button that fills it from a QR code or barcode.

A field can start with a value an earlier step proposed. A line-items field, for example, shows
the positions an AI step looked up, for the person to correct.

A field can be shown only under a condition (“Show only when”): “Street and town” only when the
person chose delivery, “Which allergy?” only when they ticked “Allergies”. The condition can
read another field of the same page, and the field then appears as the person answers. It can
also read anything known before the page. A hidden field is not required and is not kept.

The choices of a choice field can come from earlier data (“Choices from earlier data”) instead
of a fixed list: the suppliers a research step found, one column of a table it made, or a column
of a list the wizard keeps. The fixed choices stand in while that data is empty. When the choices are the rows of a table, each
can show as a card with a picture, a line or two of text and “Details” to open its page.

An appointment field takes its times the same way, usually from an AI step that looked up the
free times in a calendar. The times show in the calendar’s own time zone, grouped by day.

A field can also be left to the AI. The AI reads what was answered and found so far, and shows
the field when it finds a statement true (“The complaint is about a damaged article”). Fields
that are alternatives of each other form a group, and the AI shows the one that fits (“How
should we reach the person?”). The AI decides once, when the run reaches the page. A page whose
fields the AI chooses holds up to 12 of them and shows at most five.

## AI steps

An AI step has instructions and the tools you allow it:

| Tool | Lets the step |
|---|---|
| Web search | search the web |
| Read web pages | open and read a page |
| Browser | click and type on websites, take screenshots, download files. The person types a login themselves; the model never sees it |
| Code & shell | run code in a sandbox, where engenty wizards has one |
| Images | make images while it works |
| API | call an HTTP API |
| Pages | write pages of the wizard in Markdown, kept for every later run, and read them and the pages of the space’s Knowledge |

Every AI step can also read and write the wizard’s lists, list its files and read documents:
PDFs, scans and photos, Word, Excel, CSV and saved mails. Where the space has Knowledge, the step
searches it too. Every AI step also knows the space’s Info & brand: its title, what it says
about itself, its facts and colours.

Further tools come from three places:

- **The person’s accounts**: connectors the wizard uses, where the person connects their own
  account during the run. The step gets the service’s actions as tools. Reading is free; before
  anything changes in the person’s account, they are asked. See [Connectors](./connectors.md).
- **Connected systems** (MCP servers) of the space, where you allow them on the step.
- **Plugins** installed in engenty wizards. See [Plugins](./plugins.md).

### Model class

A step names the kind of model it needs, never a model:

| Class | For |
|---|---|
| Classifier | Routing, yes/no, picking from options, pulling a few values out of text. Cheapest |
| Standard | Short copy, calling an API, reformatting |
| High | Research with tools, long documents, weighing many sources. The default |
| Highest | Hard reasoning or code. Several times the cost of High |

On a Mac, Classifier and Standard can run on [Apple Intelligence](./models.md#apple-intelligence).
It is free and stays on your computer, but it handles only short texts and no tools. There, give
a step that calls an API or reads documents the class High.

Images, video, voice notes and voice-overs have classes of their own. You choose which model
serves a class under [Models and account](./models.md). “Thinking effort” sets how much effort
the model puts in. Leave it on “Automatic” unless a step is clearly trivial or clearly hard.

### What a step hands on

A step’s output is text, Markdown or structured data with named fields: a text, a number, a
list, a table, a yes/no answer, a choice or a score on a scale (“low, medium, high”). Later
steps use these, and branches decide on them.

## Generate

| Makes | Options |
|---|---|
| Image | Aspect ratio, style, a reference image to start from |
| Video | Aspect ratio, 4 to 10 seconds, 720p or 480p, a reference image |
| Voice | The exact text read aloud, and how to speak it |
| Document | A template: invoice, offer, briefing, letter, report or free |
| Dashboard | An HTML page with the figures of earlier steps |

An image or video step can make one result per entry, at most eight: per uploaded photo, per
image of an earlier step, or per row of a table. In a review the person can have single results
made again.

## Views

A view shows what the run found in the wizard’s own look, on any screen: key figures, a list of
facts, a list of results with pictures, a table or a simple chart (bars, a line, a ring). It is
built from a fixed set of parts that the assistant writes once, and every run brings new data.
It costs nothing to show.

A view can also leave some of its parts to the AI, for example a chart only when there is
something to compare. And an AI step can lay out a view of its own result, which reviews and the
result page then show instead of a plain table.

For anything the parts cannot show, such as a map or an animation, use a widget.

## Widgets

A widget is an interactive HTML view written once into the wizard’s files. Every run only brings
new data, so it costs nothing to show and looks the same every time. A widget can also be a
film: its timeline is then rendered to an MP4 with sound. Ask the assistant for one in the chat.

## Films

A film step hands a brief, the run’s material (voice-overs, pictures, uploads, texts) and the
space’s brand to the AI client installed on your computer (Claude Code). The client writes the
film as code, looks at its frames and fixes them. engenty wizards then renders the MP4: 16:9,
9:16 or square. A film step runs only where Claude Code is set up with your subscription, never
on credits or in the cloud, and it takes 10 to 40 minutes. The voice comes from a generate step
before it.

## Reviews

A review shows what earlier steps made. Depending on its settings, the person can edit the text
(“Text can be edited directly”) or ask for a new version with a note on what should change (“Ask
for a new variant”). A list shown in a review is edited in place. A list with files is checked
row by row, each row beside its document.

## The result

Each entry of the result page names a step and the formats the person can download:

| From | Formats |
|---|---|
| Image | PNG (several: a ZIP) |
| Video | MP4 (several: a ZIP) |
| Voice | MP3 |
| Document | PDF, Word, HTML, Markdown, PNG |
| Dashboard | HTML, PDF, PNG |
| Widget | HTML, PNG, PDF, JSON; MP4 when it animates. As a film: MP4, PNG |
| View | JSON |
| Film | MP4 |
| AI step, text | Markdown, text, Word, PDF, HTML |
| AI step, data | JSON, CSV, Excel, Markdown |
| AI step, collected files | ZIP |
| List | Excel, CSV, JSON, Markdown; ZIP with the files its rows name |

## Branches

A step can send the run somewhere else when a condition holds: a field is or is not a value, is
one of several, is filled in or empty, is greater or less than a number, or contains a value. A
condition can also read what an AI step found, how sure the AI was of a decision, or how many
rows a list the wizard keeps has. Several conditions on one branch must all hold. The first
branch that matches wins; otherwise the step’s “otherwise” branch, or else the next step,
follows. The diagram shows the branches with their conditions.

A branch can also be decided by the AI: instead of a condition it has a statement (“The person
wants a refund, not an exchange”). When no condition matched, the AI reads what was answered and
found so far and takes the branch whose statement is true; if none clearly is, the next step
follows. All such branches of a step cost one small decision together.

A branch back to an earlier step makes a loop, for example “write, check, write again until the
check passes”. A loop stops after the number of times you allow, at most ten if you set nothing.
The step that runs again sees what it made the last time.

An AI step can also work through a list: once per row of a table an earlier step made, or per
row of a list the wizard keeps, at most 20 rows. Its results come together in one table.

## What a wizard keeps

- **Lists** hold rows between runs, separately for each person who runs the wizard: the
  receipts already booked, the customers already written to.
- **Shared lists** hold one set of rows for every run: requests, sign-ups, a log. The person
  running the wizard never sees them; you find them under Space → Data, below the wizard, and
  in the editor under “Memory”.
- **Connected accounts and sign-ins** are kept for the person’s next run.

The person sees and deletes all of it under “What this wizard remembers”. See
[Run a wizard](./run.md).

## AI media

Images, clips, voice-overs and films a model made or changed carry a marking in their file, and
every page lays an “AI-generated” or “AI-modified” label over them (EU AI Act, Art. 50). Nothing
is drawn into an image. A film shows the label in the picture, since it leaves the page as a
video file.
