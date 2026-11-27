import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { t } from "../lib/i18n";
import { Button, Card, Input } from "../ui";

/*
 * A Composio API key of the person's own, beside the model keys on this computer
 * (docs/plans/composio.md, decision 4). It stays on this computer and never goes to the
 * Manage-App; with it, Composio's services connect directly. Nothing shows in the cloud or while
 * the switch `composio` is off.
 */

interface KeyState {
  available: boolean;
  set: boolean;
  masked: string | null;
}

const KEY = ["composio-key"] as const;

export function ComposioKeyCard() {
  const on = useFeature("composio");
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const state = useQuery({
    enabled: on,
    queryKey: KEY,
    queryFn: () => api.get<KeyState>("/api/studio/composio/key"),
  });
  const save = useMutation({
    mutationFn: (key: string) => api.put<KeyState>("/api/studio/composio/key", { key }),
    onSuccess: (next) => {
      qc.setQueryData(KEY, next);
      setValue("");
      void qc.invalidateQueries({ queryKey: ["composio-catalog"] });
      void qc.invalidateQueries({ queryKey: ["discover"] });
    },
  });
  if (!(on && state.data?.available)) {
    return null;
  }
  return (
    <Card className="flex flex-col gap-3 p-5 sm:p-6">
      <div>
        <h3 className="font-semibold text-[0.9375rem]">{t("composio.key.title")}</h3>
        <p className="mt-1 text-[0.8125rem] text-ink-3">{t("composio.key.lead")}</p>
      </div>
      {state.data.set ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[0.8125rem] text-ink-2">
            {t("composio.key.stored", { masked: state.data.masked ?? "" })}
          </span>
          <Button variant="ghost" size="sm" busy={save.isPending} onClick={() => save.mutate("")}>
            {t("composio.key.remove")}
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) {
              save.mutate(value.trim());
            }
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 font-mono text-[0.8125rem]"
            aria-label={t("composio.key.title")}
            placeholder={t("composio.key.placeholder")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" size="sm" busy={save.isPending} disabled={!value.trim()}>
            {t("composio.key.save")}
          </Button>
        </form>
      )}
      {save.error ? (
        <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </Card>
  );
}
