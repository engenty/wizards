import type { Audience } from "@engenty/wizards-shared/rwx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { type Key, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { Button, Dialog, Switch } from "../../ui";

/** The audiences in the order they are offered. */
const ROWS: { audience: Audience; label: Key; hint: Key }[] = [
  { audience: "team", label: "audience.team", hint: "audience.teamHint" },
  { audience: "clients", label: "audience.clients", hint: "audience.clientsHint" },
  { audience: "guests", label: "audience.guests", hint: "audience.guestsHint" },
];

/** A row: who, in a line what that means, and its switch; the admins' row says „Immer“. */
function Row({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked?: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-3">
      <span className="flex min-w-0 flex-col">
        <span className="font-medium text-[0.875rem] leading-snug">{label}</span>
        <span className="text-[0.8125rem] text-ink-3 leading-snug">{hint}</span>
      </span>
      {onChange ? (
        <Switch checked={Boolean(checked)} onChange={onChange} label={label} />
      ) : (
        <span className="shrink-0 text-[0.8125rem] text-ink-3">{t("audience.always")}</span>
      )}
    </div>
  );
}

/**
 * Who sees a mounted folder of Dateien or a folder of Wissen: the admins always, and the team,
 * the clients and guests as switched on. None switched on: the admins alone.
 */
export function AudiencePicker({
  value,
  onChange,
}: {
  value: Audience[];
  onChange: (value: Audience[]) => void;
}) {
  return (
    <div className="flex flex-col divide-y divide-border-soft rounded-lg ring-1 ring-border-soft">
      <Row label={t("audience.admins")} hint={t("audience.adminsHint")} />
      {ROWS.map((r) => (
        <Row
          key={r.audience}
          label={t(r.label)}
          hint={t(r.hint)}
          checked={value.includes(r.audience)}
          onChange={(on) =>
            onChange(
              ROWS.map((x) => x.audience).filter((a) =>
                a === r.audience ? on : value.includes(a),
              ),
            )
          }
        />
      ))}
    </div>
  );
}

/** „Wer sieht diesen Ordner“ for a folder of Wissen: it holds for everything in it. */
export function FolderAudienceDialog({
  spaceId,
  folder,
  onClose,
}: {
  spaceId: string;
  folder: { id: string; title: string } | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const path = folder
    ? `/api/studio/spaces/${spaceId}/knowledge/folders/${folder.id}/audience`
    : "";
  const saved = useQuery({
    queryKey: ["folder-audience", spaceId, folder?.id],
    queryFn: () => api.get<{ see: Audience[] }>(path),
    enabled: Boolean(folder),
  });
  const [see, setSee] = useState<Audience[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (saved.data) {
      setSee(saved.data.see);
    }
  }, [saved.data]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(path, { see });
      await qc.invalidateQueries({ queryKey: ["folder-audience", spaceId, folder?.id] });
      // What a person sees of Wissen changes with it.
      await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={folder !== null}
      onClose={onClose}
      title={t("audience.folderTitle", { title: folder?.title ?? "" })}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[0.875rem] text-ink-3">{t("audience.folderHint")}</p>
        {saved.data ? <AudiencePicker value={see} onChange={setSee} /> : null}
        {error ? <p className="text-[0.8125rem] text-rose">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("confirm.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={busy || !saved.data}>
            {t("audience.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
