import type { LocalModelsState, ModelJob, ServerStatus } from "@engenty/model-setup";
import { modelsMoving, LocalModels as SetupLocalModels } from "@engenty/model-setup/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { StudioSetup } from "./Harness";

/** What a model does in the studio: a text class, the search of a space's knowledge, decisions. */
export type LocalJob = ModelJob;

/** A server for open models on this computer. */
export type ServerId = ServerStatus["id"];

const keyOf = (server: ServerId) => ["models", "local", server];

/** A server on this computer, its models and the ones to download; off where `enabled` is false. */
export function useLocalModels(server: ServerId, enabled = true) {
  return useQuery({
    queryKey: keyOf(server),
    queryFn: () => api.get<LocalModelsState>(`/api/studio/local/servers/${server}`),
    enabled,
    // While a download runs or the server starts, the page asks how far it got.
    refetchInterval: (q) => (modelsMoving(q.state.data) ? 1500 : false),
  });
}

/** The models of a server on this computer, as the setup lists them (@engenty/model-setup). */
export function LocalModels({
  server,
  ...props
}: {
  server: ServerId;
  /** Absent: every job, and nothing to choose. */
  job?: LocalJob;
  /** The models the studio asks for now; they are not removed. */
  inUse: string[];
  disabled?: boolean;
  onChoose?: (model: string) => void;
  /** Only a model that is there is chosen; a download only downloads. */
  onlyHeld?: boolean;
}) {
  const qc = useQueryClient();
  const { data: state } = useLocalModels(server);
  // A model that arrived or went changes which ways are ready.
  const held = state?.installed.map((m) => m.name).join(" ");
  useEffect(() => {
    if (held !== undefined) {
      void qc.invalidateQueries({ queryKey: ["models"], exact: true });
    }
  }, [held, qc]);
  return (
    <StudioSetup>
      <SetupLocalModels
        {...props}
        state={state}
        onState={(next) => qc.setQueryData(keyOf(server), next)}
      />
    </StudioSetup>
  );
}
