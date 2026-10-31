# Copy style

How engenty wizards talks to people: the studio, the runner, the CLI, server errors, emails, the
site and the docs, in English and German. `pnpm copy:check` checks the mechanical rules.

**The voice:** a calm person who knows the app explains it in plain words: what happens, what it
means for you, and what you can do now.

## Rules

1. **Say who does what.** Every sentence has a subject and a verb.
2. **Say what it means for the reader, then stop.** The consequence or the next step, not the
   mechanism.
3. **Use plain words.** *your computer*, not *local install*; no metaphors (models don't *think*).
4. **Keep it short.** One idea per sentence, about 15 words. No semicolons; at most one dash.
5. **Stay calm.** No exclamation marks, emoji, marketing adjectives or *please*/*bitte*.
6. **Write each language as its own.** Never translate sentence by sentence. Read both aloud: if
   a native speaker wouldn't say it that way, rewrite it.
7. **Say one thing one way.** Use the glossary and the patterns below.

The reader is *you* / *du*, never *Sie* or *ihr*. The app describes things; *I* only for Goose,
the assistant and a wizard in conversation; *we* for engenty the company, rarely.

## Patterns

- **Button:** verb + object, sentence case, no period. DE in the infinitive: „Link kopieren“.
- **Heading:** a noun phrase or a question to the reader, no period.
- **Hint, banner, note:** full sentences; the state first, then what to do.
- **Empty state:** "No results yet." plus how it fills.
- **Error:** what happened, then what to do. A raw `{error}` goes last, after a colon.
- **Delete:** "Delete “{name}”?"; what goes, then "This can't be undone."
- **Status chip:** lower case, no period: *running*, *läuft*.
- **In progress:** "Loading…" / „Lädt …“.
- **Placeholder:** an example, no period: "e.g. …" / „z. B. …“.

## Glossary

One word per thing, in both languages. Keys in the code may keep old names; the text may not.

| Thing | English | German | Not |
|---|---|---|---|
| what people build and run | wizard | der Wizard, die Wizards | Assistent (that is the build chat) |
| the box for wizards, brand, knowledge, data | space | der Space, des Space, die Spaces | project, Projekt |
| the space's page of info & brand, knowledge and data | sources | die Quellen | Space (as that page's name), context, library |
| one time through a wizard | run | der Lauf, die Läufe; Testlauf | Durchlauf; Läufe for chat turns |
| one node of a wizard | step; AI step | Schritt; KI-Schritt | |
| what a run produces | result | Ergebnis | output |
| making a version public | publish; "is live" only as a state | veröffentlichen; „ist live“ | sync, deploy, release, synchronisieren |
| the cloud receiving it | arrives in the cloud | kommt in der Cloud an | synced, sent (except the "Send again" retry) |
| unpublished | draft | Entwurf | |
| usage currency | credits (lower case in text) | Credits; the balance is **Guthaben** | engenty Guthaben, Guthaben des Kontos |
| the engenty login | account; sign in, sign out, sign-in (noun) | Konto; anmelden, abmelden, Anmeldung | log in, login, sign up |
| the person's own machine | your computer, this computer | dein Computer, dieser Computer | local install, this machine, lokale Installation, Rechner |
| … where a phone counts | this device | dieses Gerät | |
| engenty's hosting | the cloud | die Cloud | the server (as a name for it) |
| the editor in the browser | the studio | das Studio | cloud studio |
| the program on the computer | engenty wizards | engenty wizards | the runtime, the app (ambiguous) |
| third-party service a step uses | connector | der Connector | Konnektor (except when quoting Claude's UI) |
| MCP servers in a space | connected systems | verbundene Systeme | |
| code extension | plugin | das Plugin | |
| a key the user brings | API key; your own API key | der API-Key; dein eigener API-Key | API Key (DE), Schlüssel, an own key |
| Claude / ChatGPT plan | subscription | das Abo | |
| what an organization pays for | plan | das Paket | Plan, Tarif |
| the exported file | wizard file (.wizard) | Wizard-Datei | Paket (that is the plan) |
| pre-made wizard | template | Vorlage | starter, gallery item |
| how a wizard's pages look: colours, fonts, effects | theme | das Theme, die Themes | Thema, Design, Stil, Look (except the studio's section “Look” / „Aussehen“) |
| documents the AI looks things up in | knowledge | Wissen | |
| tables and pages wizards keep | data | Daten | |
| instructions in the Agent Skills format the wizards follow | skill; always on, on demand, off | der Skill, die Skills; immer an, bei Bedarf, aus | Fähigkeit, Fertigkeit |
| a space's place for its skills, connectors, audit and search | Capabilities (the place only) | Fähigkeiten (the place only) | Werkzeuge, Tools; Fähigkeit for one skill |
| a space's sections of Capabilities | Overview, Skills, Connectors, Audit; the Overview's tabs In this space, Discover | Übersicht, Skills, Connectors, Audit; die Tabs Im Space, Entdecken | Log, Protokoll (for the audit) |
| one account at a service a space uses, set up by its admins | connection | die Verbindung | account, Zugang (for the connection itself) |
| how a connection signs in | As the space; Each person signs in | Als Space; Jede Person meldet sich an | shared login, as the organization |
| who may use a connection | Admins, Members, Everyone | Admins, Mitglieder, Alle | |
| a connection's rule per kind of action (Read, Change, Delete, Send) | Allowed, With approval, Never | Erlaubt, Mit Freigabe, Nie | Genehmigung, permission |
| an admin's yes to a call that waits | approval; approve | die Freigabe; freigeben | Genehmigung, sign-off |
| every call to a connection, one line each | the audit; a critical line | das Audit; eine kritische Zeile | log, audit log, Protokoll, Verlauf |
| what a run may reach, fixed when it starts | the run's grant | was der Lauf darf | Freigabe (that is an admin's yes), permissions |
| the one gate every connector call passes (developers' word, not in the app) | the broker | der Broker | gatekeeper, Türsteher (in text) |
| a space's table of who may read, write or run what (developers' word, behind `broker`) | RWX rule | RWX-Regel | ACL |
| people of an organization | owner, admin, member | Inhaber:in, Admin, Mitglied | user (for a role) |
| someone at a wizard's link who is no member | guest | der Gast, die Gäste | visitor, Besucher (in text) |
| build chat in the editor | the assistant; the chat | der Assistent; der Chat | conversation, thread |
| the help assistant | Goose | Goose (der) | |
| the setting for what answers Goose and the editor's chat (a subscription, a key, the credits) | Agent chat | der Agent-Chat | Chat alone, AI agent, Studio-KI |
| a spoken call | conversation | Gespräch | |
| gone for good | delete | löschen | |
| taken out, still exists elsewhere | remove | entfernen | |
| picking from options | choose | wählen | pick, select |
| model classes | Classifier, Low, Standard, High (always English, capitalised) | same | Klassifizieren |
| artificial intelligence | AI | KI | |
| email | email | E-Mail | E-mail |
| the product | engenty wizards (lower case) | engenty wizards | Engenty, engenty.wizards |

## English

British spelling (colour, organise), except *organization*, as on the account pages; the studio,
the server and the CLI write “organisation” for a reader whose English is en-GB. Sentence case.
Spaced en dash ` – `. `…` without a space. Curly quotes “ ” and ’. Contractions (don't, it's). No
Oxford comma. `&` only in labels. Figures for numbers; "about", not "~".

## German

Standard German as in Germany, `de-DE` formats; *du*. Spaced ` – `, „Lädt …“, „…“ and ’. Verbs
before nouns („Sobald du veröffentlichst“), no IT words (*schreibgeschützt*, *synchronisiert*).
Hyphen with English words and abbreviations (KI-Schritt, API-Key); German compounds closed.
Gender: neutral wording first („wer deine Website besucht“), else the colon (Kund:innen); no
asterisk, Binnen-I or generic masculine. „20 %“, „z. B.“. *Website* is the site, *Seite* a page
in engenty.

## CLI, server, emails, docs

- **CLI** (English only): help lines are lower-case verb phrases ("install the latest version").
  Commands written in full and cyan, paths with `~`. Spinners: "Starting…", then a short result.
- **Server:** the `error` a person sees is a sentence in their language; machine codes go in
  `code`.
- **Emails:** every rule here applies to them too, including the mails engenty-wizards-manage
  sends (`apps/server/src/mails/`, `apps/server/src/download-mail.ts`). The subject says what the
  mail is about, and the title is a short sentence. One button, verb + object. The grey footer
  says why the mail came and what to do if it wasn't expected, in full sentences.
- **Docs:** user pages talk to *you* in full sentences; quote UI labels exactly as the app shows
  them, and search the docs when a label changes. Set a changed page's `version` to the current
  release.
