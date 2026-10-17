// @vitest-environment jsdom
import { createLibrary, defineComponent, Renderer, useRenderNode } from "@openuidev/react-lang";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageRun, useReport } from "../../src/openui/message";
import { addWizard, WIZARD_COMPONENT, WIZARD_DESCRIPTION, wizardProps } from "../../src/openui/server";

/**
 * What the Wizard component keeps with its message, against OpenUI's own renderer: the run id
 * survives the message being shown again, and the report hands the chat none of it.
 */

const start = vi.fn(async (token: string) => `run-of-${token}`);

/** The Wizard component's dealings with the message, without the runner. */
const Probe = defineComponent({
  name: WIZARD_COMPONENT,
  description: WIZARD_DESCRIPTION,
  props: wizardProps,
  component: ({ props }) => {
    const { runId, failed } = useMessageRun(props.wizard, start);
    const report = useReport();
    return (
      <button type="button" onClick={() => report("The wizard finished.", { runId })}>
        {failed ?? runId ?? "…"}
      </button>
    );
  },
});

const Text = defineComponent({
  name: "Text",
  description: "A line of text",
  props: z.object({ text: z.string() }),
  component: ({ props }) => <p>{props.text}</p>,
});
const Card = defineComponent({
  name: "Card",
  description: "Holds the answer",
  props: z.object({ children: z.array(z.union([Text.ref])) }),
  component: ({ props }) => {
    const render = useRenderNode();
    return <div>{props.children.map(render)}</div>;
  },
});
const library = addWizard(createLibrary({ root: "Card", components: [Card, Text] }), Probe);

const reply = 'root = Card([Text("Here it is"), Wizard("tok")])';

let host: HTMLDivElement;
let root: Root;

async function show(initialState?: Record<string, unknown>) {
  const onAction = vi.fn();
  const onStateUpdate = vi.fn();
  await act(async () => {
    root.render(
      <StrictMode>
        <Renderer
          response={reply}
          library={library}
          onAction={onAction}
          onStateUpdate={onStateUpdate}
          initialState={initialState}
        />
      </StrictMode>,
    );
  });
  // The run starts a moment after the message is shown.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { onAction, onStateUpdate, button: host.querySelector("button")! };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  start.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the run a message keeps", () => {
  it("starts one run for a new message and keeps its id with the message", async () => {
    const { button, onStateUpdate } = await show();
    expect(start).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe("run-of-tok");
    const kept = onStateUpdate.mock.lastCall?.[0];
    expect(JSON.stringify(kept)).toContain("run-of-tok");
  });

  it("continues the kept run when the message is shown again", async () => {
    const first = await show();
    const kept = first.onStateUpdate.mock.lastCall?.[0];
    await act(async () => root.unmount());
    root = createRoot(host);
    start.mockClear();

    const again = await show(JSON.parse(JSON.stringify(kept)));
    expect(start).not.toHaveBeenCalled();
    expect(again.button.textContent).toBe("run-of-tok");
  });

  it("reports the result without handing the chat the message's state", async () => {
    const { button, onAction } = await show();
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    const event = onAction.mock.calls[0][0];
    expect(event.type).toBe("continue_conversation");
    expect(event.humanFriendlyMessage).toBe("The wizard finished.");
    expect(event.params.context).toEqual({ runId: "run-of-tok" });
    // What the chat shows as form data: every field whose value is not empty.
    const shown = Object.values(event.formState as Record<string, Record<string, unknown>>)
      .flatMap((form) => Object.values(form))
      .filter((field): field is { value: unknown } => !!field && typeof field === "object")
      .filter((field) => field.value !== undefined && field.value !== null && field.value !== "");
    expect(shown).toEqual([]);
    expect(JSON.stringify(event.formState)).not.toContain("run-of-tok");
  });
});
