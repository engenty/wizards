# The same dist/worker.js on self-hosted workerd, without a Cloudflare account.
#   node build.mjs && mkdir -p .workerd/runs && workerd serve workerd.capnp --experimental
# Runs are kept in .workerd/runs (SQLite files, one per Durable Object). Secrets come from the
# environment: MODEL_API_KEY, MODEL_BASE_URL.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "wizard", worker = .wizard),
    (name = "runs", disk = (path = ".workerd/runs", writable = true)),
    # Outbound fetches. "private" lets the agent battery reach a model on this network.
    (name = "net", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:8788", http = (), service = "wizard")],
);

const wizard :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "dist/worker.js")],
  compatibilityDate = "2025-09-01",
  durableObjectNamespaces = [
    (className = "RunObject", uniqueKey = "wizard-x-post-runs", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "runs"),
  globalOutbound = "net",
  bindings = [
    (name = "RUNS", durableObjectNamespace = "RunObject"),
    (name = "MODELS", text = "{\"low\":\"gpt-4.1-mini\",\"image\":\"gpt-4.1-mini\"}"),
    (name = "MODEL_BASE_URL", fromEnvironment = "MODEL_BASE_URL"),
    (name = "MODEL_API_KEY", fromEnvironment = "MODEL_API_KEY"),
  ],
);
