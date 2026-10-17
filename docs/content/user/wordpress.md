---
title: WordPress
description: Put wizards on a WordPress site with the plugin “engenty wizards” – connect, read the site in, place a wizard, read results in the admin.
version: 0.5.0
---

The plugin **engenty wizards** puts the wizards of an engenty.ai account on a WordPress site and
shows what visitors left in the WordPress admin. The wizards run on engenty.ai: WordPress keeps
the plugin’s settings and the connection, but no answers. On WordPress 7.0 a wizard can also run
on the site itself, with the site’s own AI provider and no account ([below](#without-an-account)).

| | |
|---|---|
| WordPress | 6.6 or newer; 7.0 or newer for wizards without an account |
| PHP | 8.1 or newer, nothing else on the host |
| Site address | https, so you can sign in to engenty.ai from the admin |
| Account | Free or above on engenty.ai; Contacts and Appointments need Pro |

## Install

Download `engenty-wizards.zip`, either in the studio under Settings → Integrate → WordPress
(“Download engenty-wizards.zip”) or from the
[releases](https://github.com/engenty/engenty-wizards-wp-plugin/releases/latest). Upload it in
WordPress under **Plugins → Add New → Upload Plugin** and activate it. The menu **engenty** then
opens.

## Connect

On **engenty → Overview** you have two ways in:

- **Create your own AI** offers a free account on engenty.ai: **Create a free account**.
- **Sign in**, under “Already have an engenty account?”, uses an account you already have.

engenty.ai asks you to allow the site access and sends you back. Your WordPress email address
goes along as a suggestion. The site is then connected as you: **Settings → Connection** shows
the account, team and plan, and **Disconnect** ends the connection and revokes the access.

**By hand:** for your own engenty server, or where signing in through the browser doesn’t work,
enter an **Address** and an **API key** under **Settings → Connect by hand**. On engenty.ai you
create the key under Account. On your own server you create it under Settings → Integrate, with
an app’s “Connect with the address and an API key” (see
[AI apps](./ai-apps.md#an-app-on-another-computer)).

The plugin connects to an account on engenty.ai, not to engenty wizards on your computer. If you
build on your computer, sign in to your account there and publish your wizards. You then choose
them in WordPress.

## Set up

After you connect, the overview walks you through three steps.

| Step | What happens |
|---|---|
| Read the website | The plugin reads the site from inside WordPress: name, tagline, logo, the theme’s colours, email and phone from the imprint and contact pages, the shop’s address with WooCommerce, and the published pages as text. You untick what shouldn’t go. The rest fills in the space’s details where they are empty and goes into its [knowledge](./space.md#knowledge) as pages. engenty then reads the imprint and contact pages for the address, VAT ID, opening hours and who runs the business |
| Create the first wizard | A template becomes a wizard and goes live in one click |
| Put on the website | As a bubble on every page, on a new page (a draft with the wizard’s block, for you to publish), or placed by you (see below) |

Reading the site and making wizards in WordPress needs Pro. On Free you build in
[engenty wizards on your computer](./install.md) and publish to your account. The wizards then
show up in WordPress.

## Put a wizard on a page

| Way | |
|---|---|
| Block **engenty Wizard** | Choose the wizard and how it shows: **In the text**, **Button + window** or **Bubble bottom right**, with a label, a line beside the bubble and a colour. With “In the text”, the editor shows a wizard from the account itself |
| Shortcode | `[engenty_wizard id="ID" mode="modal" label="Start a request"]`. `id` is the wizard’s ID or the token of its link; `mode` is `inline`, `modal` or `bubble`; `text` and `color` work as in the block |
| Elementor | The widget **engenty Wizard**, with the block’s choices |
| PHP | `<?php engenty_wizard( 'ID', [ 'mode' => 'inline' ] ); ?>` in a theme template |
| Bubble | **Settings → Bubble on every page**: one wizard at the bottom right of every page except the ones you leave out, with an optional line beside it and your colour |

A wizard’s drawer under **Wizards** has the shortcode and the PHP line ready to copy. For a wizard
from the account, each way writes the share dialog’s
[website code](./test-and-share.md#embed-in-a-website) with the page’s address, so a result says
which page it was started on.

## Results, contacts, appointments

| Page | Shows | Plan |
|---|---|---|
| Results | What visitors left: when, which wizard, the email address and first answers, the page. A result opens with all answers, what the wizard made and its downloads | every plan |
| Contacts | The leads your wizards collected, with search and the wizard they came through | Pro, Team |
| Appointments | Upcoming, past and cancelled bookings in the space’s calendar | Pro, Team |

You set who sees these pages under **Settings → Access to results, contacts and appointments**.
Administrators always see them, and editors do from the start. engenty.ai keeps a visitor’s
result for 7 days.

## Without an account

A WordPress 7.0 site with its own AI provider (WordPress → **Settings → Connectors**: OpenAI,
Anthropic, Google, or Ollama through its provider plugin) runs wizards by itself. It needs no
account and no credits: the provider bills the site’s key. On **engenty → Overview**, **Create
your own AI** offers the account first and, below it, **Local, with your own AI provider**.
**Set up locally** then takes you through three steps: the provider (with a test), the wizards
and the website.

| | |
|---|---|
| Wizards | The templates that come with the plugin, chosen from the gallery, or a wizard file (`.wizard`) from a wizard’s share dialog in the studio (“Website” → “Without an account: as a package”). You take it in with **Import** on the **Wizards** page |
| What runs | Pages and their fields; photos go to the provider where it takes images. AI steps, which can also read a web page or call a public API where the step names `web_fetch` or `http` (the site does that itself). Decisions, branches, reviews and views. Documents and dashboards as HTML. Results as Markdown, text, CSV or JSON, HTML as a page to print, and a PDF of a written text, made in the visitor’s browser. A document’s PDF comes from the browser’s print |
| What doesn’t | Voice notes, sign-ins to connected accounts, choosing an appointment time, list fields, and a file a later step reads. Web search, the browser, code and image tools, connected systems (MCP servers) and plugin steps (Contacts, Appointments and the like). Widgets, films, and images, video and voice made by a model. Lists and the wizard’s memory. Word, Excel and other downloads |
| The check | The share dialog’s package view and, in the plugin, the gallery, the **Wizards** page and the import say for each wizard whether it “Runs there as is”, “Runs with less” or “Needs an account”. They list what it lacks in the gallery’s words (“not set up”, “works without”). With less, a choice on a page that leads to something the site lacks is closed there (“Not available here right now”), and a format falls away. The import refuses only a wizard that needs an account. A wizard that needs a plugin only behind a choice runs with less, with that choice closed |
| Knowledge | In the package view, **Take the knowledge along** puts the space’s pages into the package as files (up to 2 MB, each page up to 60,000 characters). It is a snapshot of the day it was packed. On the site, an AI step first gets the wizard’s own text files, then the pages that match the step best (its instructions and the answers so far), up to 60,000 characters in all |
| From the account | On a connected site with a provider, a published wizard’s drawer offers **Run here**. Its published version comes over and runs on the site with the site’s provider, without credits, and its results stay in WordPress. **Run through engenty.ai** switches back, and **Reload** fetches the published version again |
| Results | Kept in WordPress under **Results**, for 90 days unless **Keep results** says otherwise. Nothing goes to engenty.ai |
| Limits | 6 runs an hour per visitor and 50 a day per wizard, plus a honeypot. 60 seconds per AI step, up to 600 for a slow local model (the setting also raises the Ollama provider plugin’s own limit) |

The settings for all of this are under **Settings → Standalone wizards**: the limits, how long
results are kept, whether photos go to the provider, and the switch that lets wizards read web
pages and call public APIs. The visitor’s browser follows the wizard’s flow and draws every page.
WordPress keeps the wizard’s prompts and the run, and asks the provider for each AI step through
its AI Client. Both kinds can be on one site: under **Wizards**, the ones that run on the site
are marked **Local**.

## Privacy

Visitors talk to engenty.ai directly from the frame the wizard runs in. Name engenty in your
privacy statement: **Settings → Privacy** has a sentence to start from. Wizards that run on the
site send the visitors’ answers to the site’s AI provider instead. For those, the settings give
a sentence that names the provider.
