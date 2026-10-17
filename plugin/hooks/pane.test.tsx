import type { McpToolResult } from "claude-code";
import { expect, test } from "claude-code/testing";

const PANE_PROPS = {
  title: "engenty.wizards",
  isFocused: true,
  bodyColumns: 80,
  placement: "dock",
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const;

const answer = (value: unknown): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError: false,
});

const BASE = "http://localhost:24368";

const wizard = (id: string, title: string, published: boolean, shared = published) => ({
  wizardId: id,
  draft: {
    title,
    description: `${title} macht etwas.`,
    avatar: "round",
    steps: [
      { id: "first", type: "page", title: "Thema" },
      { id: "write", type: "result", title: "Fertig" },
    ],
  },
  shareEnabled: shared,
  shareUrl: `${BASE}/w/t-${id}`,
  studioUrl: `${BASE}/studio/edit/${id}`,
});

const waiting = {
  runId: "r1",
  wizardId: "w2",
  mode: "live",
  status: "waiting_input",
  waitingFor: { page: "first", title: "Thema", fields: [] },
  browserUrl: `${BASE}/w/t-w2/r1`,
};

test("lists the wizards; Run opens the page beside the chat, Edit asks the chat", async ($, on) => {
  const calls: string[] = [];
  const opened: string[] = [];
  const filled: string[] = [];
  on("prompt.fill", async (_, e) => {
    filled.push(e.text);
    return { isFilled: true };
  });
  on("mcp.call", { server: "engenty-wizards" }, async (_, e) => {
    calls.push(e.tool);
    if (e.tool === "list_wizards") {
      return {
        value: answer([
          { id: "w1", title: "Brot", published: true, studioUrl: `${BASE}/studio/edit/w1` },
          { id: "w2", title: "Ohne Link", published: true, studioUrl: `${BASE}/studio/edit/w2` },
          { id: "w0", title: "Entwurf", published: false, studioUrl: `${BASE}/studio/edit/w0` },
        ]),
      };
    }
    if (e.tool === "get_wizard") {
      const id = String(e.args.wizardId);
      if (id === "w1") return { value: answer(wizard("w1", "Brot", true)) };
      if (id === "w2") return { value: answer(wizard("w2", "Ohne Link", true, false)) };
      return { value: answer(wizard("w0", "Entwurf", false)) };
    }
    if (e.tool === "run_wizard") return { value: answer(waiting) };
    return { deny: `unexpected ${e.tool}` };
  });
  on("mcp.call", { server: "Claude_Browser" }, async (_, e) => {
    opened.push(String(e.args.url));
    return { value: { content: [], isError: false } };
  });

  for (const surface of ["terminal", "desktop"] as const) {
    calls.length = 0;
    opened.length = 0;
    const ui = await $.ui.mount({
      plugin: "wizards",
      surface,
      component: "Pane",
      requestId: "wizards",
      props: PANE_PROPS,
    });
    await ui.press({ key: "Reload" });
    // Details are fetched once per wizard; the second surface finds them in the session's state.
    expect(calls).toEqual(
      surface === "terminal"
        ? ["list_wizards", "get_wizard", "get_wizard", "get_wizard"]
        : ["list_wizards"],
    );
    expect(await ui.find({ type: "Text", text: "Brot" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /Entwurf · draft/ })).toBeDefined();
    expect(await ui.find({ key: "run:w1" })).toBeDefined();
    expect(await ui.find({ key: "run:w0" })).toBeUndefined();
    expect(await ui.find({ key: "edit:w0" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "localhost:24368" })).toBeDefined();

    // A wizard with a page of its own opens there.
    await ui.press({ key: "run:w1" });
    expect(opened).toEqual([`${BASE}/w/t-w1`]);
    // One without is started here, and its run's page opens.
    await ui.press({ key: "run:w2" });
    expect(calls.at(-1)).toBe("run_wizard");
    expect(opened.at(-1)).toBe(`${BASE}/w/t-w2/r1`);

    await ui.press({ key: "edit:w0" });
    expect(filled.at(-1)).toBe('For my engenty wizard "Entwurf" I need the following changes: ');
    await ui.press({ key: "Studio" });
    expect(opened.at(-1)).toBe(`${BASE}/studio`);
    await ui.unmount();
  }
});

test("a run the model drives opens beside the chat once", async ($, on) => {
  const opened: string[] = [];
  on("mcp.call", { server: "Claude_Browser" }, async (_, e) => {
    opened.push(String(e.args.url));
    return { value: { content: [], isError: false } };
  });
  on("mcp.call", { server: "engenty-wizards" }, () => ({ deny: "not in this test" }));
  on("tool.call", { tool: "mcp__engenty-wizards__get_run" }, async () => ({
    result: { content: [{ type: "text", text: JSON.stringify(waiting) }] },
  }));

  const ui = await $.ui.mount({
    plugin: "wizards",
    surface: "desktop",
    component: "Pane",
    requestId: "wizards",
    props: PANE_PROPS,
  });
  await $.tool.call({ tool: "mcp__engenty-wizards__get_run", tool_use_id: "t1", runId: "r1" });
  await $.tool.call({ tool: "mcp__engenty-wizards__get_run", tool_use_id: "t2", runId: "r1" });
  expect(opened).toEqual([`${BASE}/w/t-w2/r1`]);
  await ui.unmount();
});

test("offers a plain link when the browser pane refuses", async ($, on) => {
  on("mcp.call", { server: "engenty-wizards" }, async (_, e) => {
    if (e.tool === "list_wizards") {
      return { value: answer([{ id: "w1", title: "Brot", published: true }]) };
    }
    if (e.tool === "get_wizard") return { value: answer(wizard("w1", "Brot", true)) };
    return { deny: `unexpected ${e.tool}` };
  });
  on("mcp.call", { server: "Claude_Browser" }, () => ({ deny: "no verdict for navigate" }));
  const ui = await $.ui.mount({
    plugin: "wizards",
    surface: "desktop",
    component: "Pane",
    requestId: "wizards",
    props: PANE_PROPS,
  });
  await ui.press({ key: "Reload" });
  await ui.press({ key: "run:w1" });
  expect(await ui.find({ type: "Text", text: /did not open/ })).toBeDefined();
  expect((await ui.find({ type: "Link" }))?.props.href).toBe(`${BASE}/w/t-w1`);
  await ui.unmount();
});

test("says why when the runtime cannot be reached", async ($, on) => {
  on("mcp.call", { server: "engenty-wizards" }, () => ({ deny: "ECONNREFUSED" }));
  const ui = await $.ui.mount({
    plugin: "wizards",
    surface: "terminal",
    component: "Pane",
    requestId: "wizards",
    props: PANE_PROPS,
  });
  await ui.press({ key: "Reload" });
  expect(await ui.find({ type: "Text", text: /ECONNREFUSED/ })).toBeDefined();
  await ui.unmount();
});
