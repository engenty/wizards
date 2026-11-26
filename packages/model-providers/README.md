# @engenty/model-providers

What provides models on a person's own computer: the servers for open models and the AI clients on
a subscription. MIT.

- **Ollama** (`@engenty/model-providers/ollama`). `ollamaRoot(url)` takes either way an address is
  given: a root as OLLAMA_HOST names it (`http://127.0.0.1:11434`, `localhost`) or the
  OpenAI-compatible `…/v1` as OLLAMA_URL names it. `ollamaState` says whether Ollama answers and
  what it holds; `installedModels` describes each model (tools, vision, thinking, in memory),
  asking Ollama once per digest; `fits(model, memory, share)` says whether a model leaves the
  computer room, with the share the caller picks; `pullModel` downloads a model with the bytes
  summed over its parts. `ollamaModel` is an AI SDK model on Ollama's own chat API, so a caller
  sets the context length (`num_ctx`), thinking, tools and pictures.
- **Clients** (`@engenty/model-providers/clients`). `CLIENTS` holds Claude Code, Codex and Cursor
  Agent: how each is found and signed in (`detectClient`, cached for a minute), the environment
  it runs in (the login shell's sign-in and PATH, no key of the host's: `resolveEnv`,
  `clientEnv`, `stripKeys`), each as an AI SDK model that runs the client headless once per
  call (`client.model(alias, options)`, the call's tools served over the host's MCP bridge), and
  each as a chat turn with one MCP server, whose name and key variable the host gives
  (`client.args(call)`, `client.events(line)`).
- **Bridge** (`@engenty/model-providers/bridge`). The tools of one call or one turn, served over MCP
  to a client while it answers. `new Bridges()` holds the open ones; `open(tools, { token })`
  opens one (the tools run in the async context of the code that opens it) and `close()` ends it;
  `fetch(request, token?)` is the one route the host mounts, with the token from the path or the
  bearer header; `at(baseUrl)` is a client model's `bridge` option, each call at
  `<baseUrl>/<token>`. A tool's `toModelOutput` shapes its MCP content (text, JSON, pictures,
  errors). What a person sees of a call stays the host's, in the tool's `execute`.
- **Probe** (`@engenty/model-providers/probe`). `probe(source)` makes one short real call and
  returns a state: `ok`, `absent`, `signed_out`, `no_model`, `too_big` or `failed`, with what the
  source said. No words for people: each app words the states itself.

```ts
import { CLIENTS } from "@engenty/model-providers/clients";
import { installedModels, ollamaModel } from "@engenty/model-providers/ollama";
import { probe } from "@engenty/model-providers/probe";

const [first] = await installedModels("http://127.0.0.1:11434");
const model = ollamaModel({ url: "http://127.0.0.1:11434", model: first.name, context: 32_768 });

const args = CLIENTS.codex.args({
  system: "…",
  message: "Hello",
  session: null,
  dir: process.cwd(),
  mcp: { name: "home", url: "http://127.0.0.1:4848/mcp", keyVar: "HOME_MCP_KEY" },
  images: [],
});

const { state } = await probe({ kind: "client", client: "claude" });
```
