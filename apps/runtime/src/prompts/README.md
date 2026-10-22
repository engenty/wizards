# Prompts

Every instruction a model reads lives here, one file per agent or area (`prompts.ts` reads them).
What only frames data stays in code: headings and labels around values (`Facts:`, `# TASK`),
line formats of lists, `(none)`. A sentence that tells the model what to do or how to judge
belongs here.

| file | who reads it |
|---|---|
| `goose.md` | Goose, the studio assistant |
| `architect.md` | the architect, the wizard editor's chat |
| `authoring.md` | the authoring guide: the architect, the MCP `get_authoring_guide` tool and Goose |
| `step.md` | AI steps in a run |
| `tools.md` | the tools AI steps get, and the notes their results carry |
| `voice.md` | the voice conversation that fills in a wizard |
| `safety.md` | the content policy, for every agent and the checker before generation |
| `services.md` | small jobs: translations, summaries, descriptions, OCR, knowledge |
| `mcp.md` | AI apps that use wizards over MCP |

## Format

- `<!-- section: name -->` starts a section; code asks for a file and a section.
- Other `<!-- … -->` comments are notes for whoever edits the file; they never reach a model.
- `${name}` is a placeholder the code fills in. Keep the ones a section has and add none:
  the code fails loudly when one is missing or unknown.
- The blank lines around a section are dropped.

## Who owns what

The sections under **Behaviour** at the top of a file say how an agent talks and decides: its
persona, voice and judgement. Product owns them. The rest — formats, tool contracts, mechanics —
is engineering's. Everything changes through pull requests.

## Editing

- Write general behaviour, not a fix for one reply. When an answer goes wrong, find the rule it
  broke and strengthen that rule; do not describe the reply you wanted.
- One rule per behaviour. Change the existing rule rather than adding a second beside it, and take
  back a change that did not help.
- Check an edit against the rest of the file and against `safety.md`. Two rules that pull
  different ways are fixed by rewriting them, not by a third that ranks them.
- Examples illustrate, and models copy them closely: keep them few and typical.
- Say what to do. Naming an unwanted output tends to invite it.
- Replies vary between runs: judge a change on several. From source (`pnpm dev`) a saved file is
  read again on the next call, without a restart.
- A system prompt is cached by its prefix. A change near the top of a long prompt makes every
  conversation read it again once; that is fine, but do not put anything that changes per call
  into a system prompt.
