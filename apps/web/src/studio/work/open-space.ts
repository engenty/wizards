/**
 * How the Bot Server's page in the frame learns which space is open in the studio. The page says
 * `{ type: "wizards.ready" }` once it listens; from then on it is told the open space, and again
 * each time another one is opened: `{ type: "wizards.space", id, name }`. Both ways are held to
 * the server's origin, so no other page reads the space or asks for it.
 */

/** The space open in the studio, by the name its top bar shows. */
export interface OpenSpace {
  id: string;
  name: string;
}

/** What the frame's page says once it listens. */
export const READY = "wizards.ready";
/** What the studio answers, and says again when the space is switched. */
export const SPACE = "wizards.space";

/** A message as the studio's window hears it. */
interface Heard {
  origin: string;
  source: unknown;
  data: unknown;
}

/** The studio's window: where the frame's messages arrive. */
interface Listening {
  addEventListener(type: "message", listener: (event: Heard) => void): void;
  removeEventListener(type: "message", listener: (event: Heard) => void): void;
}

/** The frame's window. */
interface Told {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Tells the frame the open space. `frame` is asked each time, as the frame's window is there only
 * while the frame is shown. `open` takes the space the studio shows now; `stop` ends the listening.
 */
export function tellSpace(page: Listening, frame: () => Told | null, origin: string) {
  let ready = false;
  let space: OpenSpace | null = null;
  const tell = () => {
    if (ready && space) {
      frame()?.postMessage({ type: SPACE, id: space.id, name: space.name }, origin);
    }
  };
  const heard = (event: Heard) => {
    const from = frame();
    if (!from || event.source !== from || event.origin !== origin) {
      return;
    }
    if ((event.data as { type?: unknown } | null)?.type !== READY) {
      return;
    }
    // A page that loads again says so again, and is told again.
    ready = true;
    tell();
  };
  page.addEventListener("message", heard);
  return {
    open(next: OpenSpace) {
      if (space?.id === next.id && space.name === next.name) {
        return;
      }
      space = next;
      tell();
    },
    stop() {
      page.removeEventListener("message", heard);
    },
  };
}
