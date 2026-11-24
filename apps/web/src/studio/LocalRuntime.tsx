import { OllamaAddress, OwnKeys } from "@engenty/model-setup/react";
import { modelLabel, PROVIDERS, providerOfRef } from "@engenty/wizards-shared/providers";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import type { LocalModels } from "../lib/session";

/** Opens a page in the person's own browser — also from inside the desktop app's window. */
export function openExternal(url: string) {
  const desktop = (window as { engentyDesktop?: { open(url: string): void } }).engentyDesktop;
  if (desktop) {
    desktop.open(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** The providers that can write: a key from one of them is enough for the setup. */
const WRITERS = PROVIDERS.filter((p) => p.text);

/** The keys of the setup and Ollama. Which model does which job is for Settings → Models. */
export function OwnModels({ models }: { models: LocalModels }) {
  return (
    <OwnKeys
      providers={WRITERS.map(({ id, name, keyUrl, keyPlaceholder }) => ({
        id,
        name,
        keyUrl,
        keyPlaceholder,
        stored: Boolean(models.keys[id]),
      }))}
      isOf={(ref, provider) => providerOfRef(ref) === provider}
      modelName={modelLabel}
      onRemove={(provider) => api.put("/api/studio/local/models", { keys: { [provider]: "" } })}
      later={t("local.modelsLater")}
    >
      <OllamaAddress url={models.ollamaUrl} modelName={modelLabel} />
    </OwnKeys>
  );
}
