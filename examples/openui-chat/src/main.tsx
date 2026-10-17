import "@openuidev/react-ui/index.css";
import "@engenty/wizards/openui/styles.css";
import { addWizard, configureWizards, Wizard } from "@engenty/wizards/openui";
import {
  AgentInterface,
  type ConversationStarterProps,
  fetchLLM,
  openAIAdapter,
  openAIMessageFormat,
} from "@openuidev/react-ui";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// The wizards runtime, through this page's own proxy (vite.config.ts).
configureWizards({ runtime: "/wizards-runtime" });

// OpenUI's chat library plus the Wizard component: the server's prompt names the same.
const library = addWizard(openuiChatLibrary, Wizard);

const llm = fetchLLM({
  url: "/api/chat",
  streamAdapter: openAIAdapter(),
  messageFormat: openAIMessageFormat,
});

function App() {
  const [starters, setStarters] = useState<ConversationStarterProps[]>([]);
  useEffect(() => {
    fetch("/api/wizards")
      .then((res) => res.json())
      .then((wizards: { title: string; description: string }[]) =>
        setStarters(
          wizards.map((w) => ({
            displayText: w.title,
            prompt: `I need this: ${w.title}. ${w.description}`,
          })),
        ),
      )
      .catch(() => setStarters([]));
  }, []);
  return (
    <div style={{ height: "100dvh" }}>
      <AgentInterface
        llm={llm}
        componentLibrary={library}
        agentName="Wizards in OpenUI"
        starters={starters}
        scrollVariant="always"
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
