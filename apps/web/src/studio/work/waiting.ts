import type { CriticalKind } from "@engenty/wizards-shared/connectors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";

/**
 * Work from `/api/studio/work` (behind `workMode`): what waits for the person under the bell, and
 * the team's Bot Server (wizards.bot), which runs Work's chats.
 */

const BASE = "/api/studio/work";

/**
 * How often the bell asks for what waits when the live feed is off (`liveChanges`); with it on,
 * it is read again when the feed tells of a change.
 */
const POLL_MS = 4000;
const usePoll = () => (useFeature("liveChanges") ? false : POLL_MS);

/** One of the broker's critical lines, under the bell (docs/plans/broker.md, "Notifications"). */
export interface CriticalItem {
  id: string;
  at: string;
  kind: CriticalKind;
  spaceId: string;
  who: { kind: string; id: string | null };
  connectionId: string;
  actionId: string;
  outcome: string;
  result: string | null;
  reason: string | null;
  runId: string | null;
  wizardId: string | null;
  chatId: string | null;
}

/** A run in Work's lists (services/work-runs.ts). */
export interface WaitingRun {
  runId: string;
  wizardId: string;
  spaceId: string;
  wizard: string;
  stepId: string;
  step: string;
  kind: "form" | "review" | "approve" | "question" | "pause";
  status: string;
  about: string | null;
  detail: string | null;
  since: string;
  until: string | null;
}

/** What waits under the bell: runs, and for an admin the broker's critical lines. */
export interface Waiting {
  /** Runs that need the person, and those that go on by themselves. */
  runs?: { needs: WaitingRun[]; waits: WaitingRun[] };
  critical: CriticalItem[];
  /** Critical lines since the person last opened the bell. */
  unseen: number;
}

/** What waits for the person: the bell's count and list. */
export function useWaiting() {
  const poll = usePoll();
  return useQuery({
    queryKey: ["work-approvals"],
    queryFn: () => api.get<Waiting>(`${BASE}/approvals`),
    refetchInterval: poll,
  });
}

/** A run's approval decided right from Work's list. */
export function useDecideRun(run: Pick<WaitingRun, "runId" | "stepId">) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (approved: boolean) =>
      api.post(`/api/runs/${run.runId}/reviews/${run.stepId}`, {
        type: approved ? "accept" : "decline",
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["work-approvals"] }),
  });
}

/** The person opened the bell: the critical lines there count as seen. */
export function useBellOpened() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`${BASE}/approvals/seen`),
    onSuccess: () => client.invalidateQueries({ queryKey: ["work-approvals"] }),
  });
}

/**
 * The team's Bot Server as the runtime answers it. `team`: it takes a pass for each of its
 * people; a person's own asks for its code. `may`: the person chats there. `runs`: they are an
 * owner or admin of it.
 */
export type TeamHome =
  | { state: "unmanaged" }
  | { state: "none"; mayMake: boolean; makeUrl: string; may: boolean; runs: boolean }
  | {
      state: "making" | "running" | "stopped";
      address: string;
      origin: string;
      team: boolean;
      makeUrl: string;
      may: boolean;
      runs: boolean;
    };

/** Where the team's Bot Server is; asked again while it is being made. */
export function useTeamHome() {
  return useQuery({
    queryKey: ["work-home"],
    queryFn: () => api.get<TeamHome>(`${BASE}/home`),
    refetchInterval: (query) => (query.state.data?.state === "making" ? 5000 : false),
  });
}

/**
 * The address of the Bot Server's page with a pass that pairs this browser as the person. A pass
 * is good once and for five minutes, so each time the page is shown it gets a new one.
 */
export function useHomeAddress(origin: string | undefined) {
  return useQuery({
    queryKey: ["work-home-pass", origin],
    queryFn: () => api.post<{ url: string }>(`${BASE}/home/pass`),
    enabled: Boolean(origin),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
