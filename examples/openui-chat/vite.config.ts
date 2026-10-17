import react from "@vitejs/plugin-react";
import { defaultClientConditions, defaultServerConditions, defineConfig, loadEnv } from "vite";
import { chatHandler } from "./server.ts";

/**
 * One process for the example: the page, the chat route (server.ts) and a proxy to the wizards
 * runtime under `/wizards-runtime`, so the runner's cookie stays on this page's own address.
 */
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const runtimeUrl = env.WIZARDS_RUNTIME_URL || "http://localhost:24368";
  return {
    plugins: [
      react(),
      {
        name: "openui-chat-server",
        configureServer(server) {
          server.middlewares.use(
            chatHandler({
              runtimeUrl,
              wizards: (env.WIZARDS ?? "")
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              baseUrl: env.CHAT_BASE_URL || "https://api.openai.com/v1",
              apiKey: env.CHAT_API_KEY ?? "",
              model: env.CHAT_MODEL || "gpt-5-mini",
            }),
          );
        },
      },
    ],
    resolve: { conditions: ["wizards-source", ...defaultClientConditions] },
    ssr: { resolve: { conditions: ["wizards-source", ...defaultServerConditions] } },
    server: {
      port: 5190,
      proxy: {
        "/wizards-runtime": {
          target: runtimeUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/wizards-runtime/, ""),
        },
      },
    },
  };
});
