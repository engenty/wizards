import type { ModelJob, OllamaModelsState } from "@engenty/model-setup";
import { modelsMoving, LocalModels as SetupLocalModels } from "@engenty/model-setup/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { StudioSetup } from "./Harness";

/** What a model does in the studio: a text class, the search of a space's knowledge, decisions. */
export type LocalJob = ModelJob;

const KEY = ["models", "local"];

/** Ollama on this computer; off where `enabled` is false. */
export function useLocalModels(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<OllamaModelsState>("/api/studio/local/local-models"),
    enabled,
    // While a download runs or Ollama starts, the page asks how far it got.
    refetchInterval: (q) => (modelsMoving(q.state.data) ? 1500 : false),
  });
}

/** The models in Ollama on this computer, as the setup lists them (@engenty/model-setup). */
export function LocalModels(props: {
  /** Absent: every job, and nothing to choose. */
  job?: LocalJob;
  /** The models the studio asks for now; they are not removed. */
  inUse: string[];
  disabled?: boolean;
  onChoose?: (model: string) => void;
}) {
  const qc = useQueryClient();
  const { data: state } = useLocalModels();
  // A model that arrived or went changes which ways are ready.
  const held = state?.installed.map((m) => m.name).join(" ");
  useEffect(() => {
    if (held !== undefined) {
      void qc.invalidateQueries({ queryKey: ["models"], exact: true });
    }
  }, [held, qc]);
  return (
    <StudioSetup>
      <SetupLocalModels {...props} state={state} onState={(next) => qc.setQueryData(KEY, next)} />
    </StudioSetup>
  );
}
