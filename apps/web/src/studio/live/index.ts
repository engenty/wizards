import { useEffect, useReducer } from "react";
import { wizardLive } from "../editor/live-bindings";
import { knowledgeLive } from "../project/live";
import { flashClass, registerLiveBindings, watchFlash } from "./patch";
import { presenceLive } from "./presence";
import { spaceLive } from "./spaces";

// Every area's live bindings, read by the one feed of the studio (feed.ts).
registerLiveBindings([...spaceLive, ...wizardLive, ...knowledgeLive, ...presenceLive]);

export { useLiveFeed } from "./feed";
export { registerLiveEditor } from "./patch";

/** A class for an item that just changed elsewhere: a short fade of its background. */
export function useLiveFlash(id: string): string {
  const [, render] = useReducer((n: number) => n + 1, 0);
  useEffect(() => watchFlash(id, render), [id]);
  return flashClass(id);
}
