import {
  ClientPanel,
  type SetupHostApi,
  ModelTest as SetupModelTest,
  SetupProvider,
} from "@engenty/model-setup/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { withBase } from "@/lib/base";
import { api } from "../lib/api";
import { useLang } from "../lib/i18n";
import type { HarnessId, Me } from "../lib/session";
import { openExternal } from "./LocalRuntime";

/** The setup's routes of a runtime that runs alone. */
const LOCAL = "/api/studio/local";

/** The studio around the setup's parts (@engenty/model-setup): its calls, its language. */
export function StudioSetup({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const lang = useLang();
  const host = useMemo<SetupHostApi>(
    () => ({
      lang,
      post: (path, body) => api.post(`${LOCAL}${path}`, body),
      put: (path, body) => api.put(`${LOCAL}${path}`, body),
      del: (path) => api.del(`${LOCAL}${path}`),
      follow(terminal, on) {
        const source = new EventSource(withBase(`${LOCAL}/terminal/${terminal}/stream`), {
          withCredentials: true,
        });
        source.addEventListener("data", (e) => on(JSON.parse((e as MessageEvent).data)));
        source.addEventListener("done", () => on({ type: "done" }));
        source.addEventListener("exit", (e) => {
          source.close();
          on(JSON.parse((e as MessageEvent).data));
        });
        return () => source.close();
      },
      open: openExternal,
      changed: () => qc.invalidateQueries({ queryKey: ["me"] }),
    }),
    [qc, lang],
  );
  return <SetupProvider host={host}>{children}</SetupProvider>;
}

/** The short call that shows the way to a model is open. */
export function ModelTest({ auto = false }: { auto?: boolean }) {
  return (
    <StudioSetup>
      <SetupModelTest auto={auto} />
    </StudioSetup>
  );
}

/** One AI client on this machine; the setup and the settings both show it. */
export function HarnessPanel({
  me,
  id,
  autoTest = false,
}: {
  me: Me;
  id: HarnessId;
  /** Make the test call without a click as soon as the client is signed in. */
  autoTest?: boolean;
}) {
  const client = me.harnesses.find((h) => h.id === id);
  return client ? (
    <StudioSetup>
      <ClientPanel client={client} autoTest={autoTest} />
    </StudioSetup>
  ) : null;
}
