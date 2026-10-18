import { FUR_ORIGIN, FUR_VIEW } from "./fur-shader";
import { stepJellySpring } from "./jelly-motion";

// A local surface grab, shared by the body and the attached eye geometry.
export function bindJellyDrag(element: HTMLElement, enabled: () => boolean) {
  const spring = { x: 0, y: 0, vx: 0, vy: 0 };
  const anchor: [number, number] = [60, 60];
  let held: number | null = null;
  let start: [number, number] = [0, 0];
  let moved = false;
  const down = (event: PointerEvent) => {
    if (!enabled() || event.button !== 0 || held !== null) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const x =
      ((event.clientX - rect.left) / rect.width) * FUR_VIEW + FUR_ORIGIN;
    const y =
      ((event.clientY - rect.top) / rect.height) * FUR_VIEW + FUR_ORIGIN;
    // The padded canvas includes empty space around the specimen.
    if (Math.hypot(x - 60, y - 60) > 48) {
      return;
    }
    anchor[0] = x;
    anchor[1] = y;
    start = [event.clientX, event.clientY];
    held = event.pointerId;
    moved = false;
    element.setPointerCapture(held);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== held) {
      return;
    }
    if (!enabled()) {
      release(event);
      return;
    }
    const rect = element.getBoundingClientRect();
    const x = ((event.clientX - start[0]) / rect.width) * FUR_VIEW;
    const y = ((event.clientY - start[1]) / rect.height) * FUR_VIEW;
    const limit = Math.min(1, 18 / (Math.hypot(x, y) || 1));
    spring.x = x * limit;
    spring.y = y * limit;
    spring.vx = 0;
    spring.vy = 0;
    moved ||=
      Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 4;
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId !== held) {
      return;
    }
    held = null;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
  };
  const click = (event: MouseEvent) => {
    // Gallery specimens may sit inside a shape-selection button.
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    }
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
  element.addEventListener("lostpointercapture", release);
  element.addEventListener("click", click, true);
  return {
    step(dt: number): [number, number, number, number] {
      if (held === null) {
        stepJellySpring(spring, [0, 0], dt);
      }
      return [anchor[0], anchor[1], spring.x, spring.y];
    },
    dispose() {
      if (held !== null && element.hasPointerCapture(held)) {
        element.releasePointerCapture(held);
      }
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", release);
      element.removeEventListener("pointercancel", release);
      element.removeEventListener("lostpointercapture", release);
      element.removeEventListener("click", click, true);
    },
  };
}
