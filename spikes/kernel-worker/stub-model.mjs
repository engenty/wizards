// A stand-in for an OpenAI-compatible endpoint, so the Worker's fetch battery can be run without
// an account: POST /v1/chat/completions answers with a short post, and logs what it was asked.
//   node stub-model.mjs [8790]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8790);
createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const { model, messages } = JSON.parse(body || "{}");
  console.log(
    `${request.method} ${request.url} model=${model} auth=${request.headers.authorization ? "yes" : "no"} prompt=${messages?.[0]?.content.length ?? 0} chars`,
  );
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: `Freitag 17 Uhr: Unser Yoga-Studio in Wien öffnet – die erste Stunde ist gratis. (${model})`,
          },
        },
      ],
    }),
  );
}).listen(port, "127.0.0.1", () => console.log(`stub model on http://127.0.0.1:${port}/v1`));
