import {
  type SurfaceAction,
  type SurfaceState,
  SurfaceView as View,
} from "@engenty/chatviews/react/surface";
import type { SurfaceComponent } from "@engenty/chatviews/surface";
import type { ComponentProps } from "react";
import { FormView, type SurfaceChat } from "./surface-form.js";

export type { SurfaceChat, SurfaceFormAnswer } from "./surface-form.js";
export type { SurfaceAction, SurfaceState };

/**
 * A surface as the runner draws it: the views of @engenty/chatviews, with a chat's Form drawn by
 * the runner's own field kinds (the camera, the place, a recording, a signature).
 */
export function SurfaceView({
  chat,
  ...rest
}: Omit<ComponentProps<typeof View>, "chat"> & { chat?: SurfaceChat }) {
  return (
    <View
      {...rest}
      chat={
        chat && {
          href: (open) => chat.href(open),
          follow: chat.follow,
          form: (c: SurfaceComponent, byId, data) => (
            <FormView c={c} byId={byId} data={data} chat={chat} />
          ),
        }
      }
    />
  );
}
