import { describe, expect, it } from "vitest";
import { tellSpace } from "./open-space";

const HOME = "https://fuchs.homes.example";

/** The studio's window and the frame's, as far as the two talk. */
function windows() {
  const listeners = new Set<(event: { origin: string; source: unknown; data: unknown }) => void>();
  const posted: { message: unknown; to: string }[] = [];
  const frame = {
    postMessage: (message: unknown, to: string) => void posted.push({ message, to }),
  };
  const page = {
    addEventListener: (_: "message", listener: (event: any) => void) =>
      void listeners.add(listener),
    removeEventListener: (_: "message", listener: (event: any) => void) =>
      void listeners.delete(listener),
  };
  const say = (data: unknown, origin = HOME, source: unknown = frame) => {
    for (const listener of listeners) {
      listener({ origin, source, data });
    }
  };
  return { page, frame, posted, say, listening: () => listeners.size };
}

const werkstatt = { id: "space-1", name: "Werkstatt" };
const kundschaft = { id: "space-2", name: "Kundschaft" };

describe("the open space, told to the Bot Server's page", () => {
  it("goes out once the page says it listens, to the server's origin only", () => {
    const { page, frame, posted, say } = windows();
    const telling = tellSpace(page, () => frame, HOME);
    telling.open(werkstatt);
    expect(posted).toEqual([]);
    say({ type: "wizards.ready" });
    expect(posted).toEqual([{ message: { type: "wizards.space", ...werkstatt }, to: HOME }]);
  });

  it("goes out again when another space is opened, and not for the same one twice", () => {
    const { page, frame, posted, say } = windows();
    const telling = tellSpace(page, () => frame, HOME);
    say({ type: "wizards.ready" });
    // The page listens before the studio knows its spaces.
    expect(posted).toEqual([]);
    telling.open(werkstatt);
    telling.open({ ...werkstatt });
    telling.open(kundschaft);
    expect(posted).toEqual([
      { message: { type: "wizards.space", ...werkstatt }, to: HOME },
      { message: { type: "wizards.space", ...kundschaft }, to: HOME },
    ]);
    // A page that loaded again asks again.
    say({ type: "wizards.ready" });
    expect(posted.at(-1)).toEqual({ message: { type: "wizards.space", ...kundschaft }, to: HOME });
    expect(posted).toHaveLength(3);
  });

  it("ignores a page that is not the server's", () => {
    const { page, frame, posted, say } = windows();
    const telling = tellSpace(page, () => frame, HOME);
    telling.open(werkstatt);
    // Another origin, in the frame or anywhere else.
    say({ type: "wizards.ready" }, "https://elsewhere.example");
    // The server's origin, from a window that is not the frame.
    say({ type: "wizards.ready" }, HOME, {});
    // Anything else the frame says.
    say({ type: "wizards.hello" });
    say("wizards.ready");
    say(null);
    expect(posted).toEqual([]);
    telling.open(kundschaft);
    expect(posted).toEqual([]);
  });

  it("says nothing while the frame is not shown, and stops listening when told to", () => {
    const { page, frame, posted, say, listening } = windows();
    let shown: typeof frame | null = null;
    const telling = tellSpace(page, () => shown, HOME);
    telling.open(werkstatt);
    say({ type: "wizards.ready" });
    expect(posted).toEqual([]);
    shown = frame;
    say({ type: "wizards.ready" });
    expect(posted).toHaveLength(1);
    telling.stop();
    expect(listening()).toBe(0);
  });
});
