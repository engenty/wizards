import type { ConnectorView } from "@engenty/wizards-shared/connectors";
import { keys } from "../../lib/keys";
import type { Space } from "../../lib/session";
import { type LiveBinding, upsert, without } from "./patch";

/** Spaces and their connectors, live. */
export const spaceLive: LiveBinding[] = [
  {
    id: "spaces",
    kinds: ["space"],
    patch: (c, { qc, invalidate }) => {
      const list = qc.getQueryData<Space[]>(keys.spaces());
      if (list) {
        const next = c.op === "del" ? without(list, c.item) : upsert(list, c.view as Space, "last");
        if (next) {
          qc.setQueryData(keys.spaces(), next);
        }
      }
      // Brand and themes live on the space; its themes are put together by the server.
      invalidate(keys.themes(c.item));
    },
    fallback: (c) => [keys.spaces(), keys.themes(c.item)],
  },
  {
    id: "connectors",
    kinds: ["connector"],
    patch: (c, { qc }) => {
      if (!c.spaceId) {
        return;
      }
      const key = keys.connectors(c.spaceId);
      const list = qc.getQueryData<ConnectorView[]>(key);
      if (!list) {
        return;
      }
      const id = c.item.slice(c.spaceId.length + 1);
      const next =
        c.op === "del" ? without(list, id) : upsert(list, c.view as ConnectorView, "last");
      if (next) {
        qc.setQueryData(key, next);
      }
    },
    fallback: (c) => (c.spaceId ? [keys.connectors(c.spaceId)] : []),
  },
];
