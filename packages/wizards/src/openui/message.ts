import {
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
  useTriggerAction,
} from "@openuidev/react-lang";
import { useCallback, useEffect, useRef, useState } from "react";
import { WIZARD_COMPONENT } from "./server.js";

/**
 * What the Wizard component keeps with its message, in OpenUI's state of the message.
 *
 * OpenUI keeps that state as the fields of forms, saves it with the message and restores it when
 * the message is shown again. An action hands the chat the fields of the form it names, or every
 * field where it names none; the chat shows them as “Form data” and gives them to the model. So
 * the run id is a field of its own, which no action names, and the action that reports the
 * result names a form that holds nothing.
 */

const runField = (token: string) => `wizard:${token}`;
const EMPTY_FORM = "wizard:empty";

/**
 * The run this message shows: the one it kept, else a new one from `start`. A run starts once
 * the reply has finished streaming, as the token can be half written until then, and once per
 * message, however often React runs the effect (twice in Strict Mode).
 */
export function useMessageRun(
  token: string | undefined,
  start: (token: string) => Promise<string>,
): { runId: string | null; failed: string | null } {
  const streaming = useIsStreaming();
  const getField = useGetFieldValue();
  const setField = useSetFieldValue();
  const [runId, setRunId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const started = useRef<Promise<string> | null>(null);

  useEffect(() => {
    if (streaming || runId || failed || !token) {
      return;
    }
    let cancelled = false;
    const take = async () => {
      // OpenUI restores the message's state in an effect of its own, which runs after this one.
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      const kept = getField(undefined, runField(token));
      if (typeof kept === "string") {
        setRunId(kept);
        return;
      }
      started.current ??= start(token);
      const id = await started.current;
      if (!cancelled) {
        setRunId(id);
        setField(undefined, WIZARD_COMPONENT, runField(token), id, true);
      }
    };
    take().catch((err: unknown) => {
      if (!cancelled) {
        setFailed(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [streaming, runId, failed, token, getField, setField, start]);

  return { runId, failed };
}

/** Tells the chat something as a turn of the person, with `context` for the model. */
export function useReport(): (message: string, context: unknown) => void {
  const setField = useSetFieldValue();
  const trigger = useTriggerAction();
  return useCallback(
    (message, context) => {
      setField(EMPTY_FORM, undefined, "empty", undefined, false);
      void trigger(message, EMPTY_FORM, { type: "continue_conversation", params: { context } });
    },
    [setField, trigger],
  );
}
