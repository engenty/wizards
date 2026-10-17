import type { Format } from "@engenty-wizards/shared/definition";
import { formatTableCell, type TableColumn } from "@engenty-wizards/shared/engenty/data-tables";
import { formatBytes } from "@engenty-wizards/shared/numbers";
import type { ShownList } from "@engenty-wizards/shared/run";
import {
  type ConnectionView,
  type ConnectorOption,
  cellValue,
  type StoreFile,
} from "@engenty-wizards/shared/store";
import { Check, Database, FileText, Link2, Plus, Trash2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "./api.js";
import { api, appCall, appCan, runBase, withBase } from "./env.js";
import { lang, t } from "./i18n.js";
import { Button, cn, Dialog, IconButton, Input, Label, Spinner } from "./ui.js";

// --- connecting an account -------------------------------------------------------

function CredentialsForm({
  runId,
  connectionId,
  connector,
  onCancel,
}: {
  runId: string;
  connectionId: string;
  connector: ConnectorOption;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${runBase(runId)}/connections/${connectionId}/credentials/${connector.id}`, {
        values,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-input">
      {(connector.fields ?? []).map((f) => (
        <div key={f.key}>
          <Label>{f.label}</Label>
          <Input
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={values[f.key] ?? ""}
            placeholder={f.placeholder}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            onKeyDown={(e) => {
              // Enter connects; it must not submit the wizard page around this form.
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>
      ))}
      {connector.hint ? <p className="text-[0.8125rem] text-ink-3">{connector.hint}</p> : null}
      {error ? <p className="text-[0.8125rem] text-rose">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" busy={busy} onClick={() => void submit()}>
          {t("connect.go")}
        </Button>
      </div>
    </div>
  );
}

/** The person connects an account (their mailbox) to the wizard, or sees which one is connected. */
export function ConnectionField({
  runId,
  connection,
}: {
  runId: string;
  connection: ConnectionView | undefined;
}) {
  const [form, setForm] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!connection) {
    return null;
  }
  if (connection.account) {
    const name =
      connection.connectors.find((c) => c.id === connection.account?.connector)?.name ?? "";
    return (
      <div className="flex items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-input">
        <div className="flex size-10 items-center justify-center rounded-full bg-moss-tint text-moss">
          <Check className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-[0.9375rem]">{connection.account.label}</div>
          <div className="text-[0.8125rem] text-ink-3">{t("connect.connected", { name })}</div>
        </div>
        <IconButton
          label={t("connect.disconnect")}
          onClick={() => void api.del(`${runBase(runId)}/connections/${connection.id}`)}
        >
          <Unplug className="size-4" />
        </IconButton>
      </div>
    );
  }
  const oauth = async (connector: ConnectorOption) => {
    setError(null);
    setLink(null);
    if (appCan("signIn")) {
      // The app opens the system's sign-in sheet: Google refuses a sign-in inside a WebView.
      // The run's stream says when the account is connected, as with the popup.
      try {
        const { url } = await api.post<{ url: string }>(
          `${runBase(runId)}/connections/${connection.id}/oauth/${connector.id}`,
        );
        await appCall("signIn", { url });
      } catch (err) {
        setError((err as Error).message);
      }
      return;
    }
    // Opened inside the click, before the address is known: a popup opened later is blocked.
    const popup = window.open("about:blank", "wizard-connect", "width=540,height=700");
    try {
      const { url } = await api.post<{ url: string }>(
        `${runBase(runId)}/connections/${connection.id}/oauth/${connector.id}`,
      );
      if (popup) {
        popup.location.replace(url);
      } else {
        setLink(url);
      }
    } catch (err) {
      popup?.close();
      setError((err as Error).message);
    }
  };
  const open = connection.connectors.find((c) => c.id === form);
  if (!connection.connectors.length) {
    return <p className="text-[0.875rem] text-ink-3">{t("connect.none")}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {connection.connectors.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() =>
              c.auth === "oauth2" ? void oauth(c) : setForm(form === c.id ? null : c.id)
            }
            className={cn(
              "inline-flex h-11 items-center gap-2 rounded-full px-4 font-medium text-[0.875rem] ring-1 transition",
              form === c.id
                ? "bg-ember-veil text-ink ring-ember"
                : "bg-card text-ink-2 ring-input hover:text-ink hover:ring-ember",
            )}
          >
            <Link2 className="size-4" /> {c.name}
          </button>
        ))}
      </div>
      {open ? (
        <CredentialsForm
          runId={runId}
          connectionId={connection.id}
          connector={open}
          onCancel={() => setForm(null)}
        />
      ) : null}
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="text-[0.875rem] text-ember underline"
        >
          {t("connect.openLink")}
        </a>
      ) : null}
      {error ? <p className="text-[0.8125rem] text-rose">{error}</p> : null}
    </div>
  );
}

// --- lists ---------------------------------------------------------------------

/** A cell's value as the text its input shows. */
function inputText(value: unknown): string {
  return value === null || value === undefined
    ? ""
    : Array.isArray(value)
      ? value.join(", ")
      : String(value);
}

function CellInput({
  column,
  value,
  boxed,
  onCommit,
}: {
  column: TableColumn;
  value: unknown;
  /** On a card (phone) the input shows its own ground; in the table the cell is the frame. */
  boxed?: boolean;
  onCommit: (value: unknown) => void;
}) {
  const [text, setText] = useState(inputText(value));
  useEffect(() => setText(inputText(value)), [value]);
  const base = cn(
    "w-full min-w-0 rounded-md border border-transparent px-2 text-[0.8125rem] outline-none focus:border-ember focus:bg-card",
    boxed ? "h-11 bg-paper-2" : "h-9 bg-transparent hover:bg-paper-2 coarse:h-11",
  );
  if (column.type === "boolean") {
    return (
      // The box stays small; the label around it is the full touch target.
      <label className="flex size-9 cursor-pointer items-center justify-center coarse:size-11">
        <input
          type="checkbox"
          aria-label={column.name}
          checked={value === true}
          onChange={(e) => onCommit(e.target.checked)}
          className="size-4 accent-[var(--ember)] coarse:size-6"
        />
      </label>
    );
  }
  if (column.type === "select" && !column.format.multiple && !column.format.allowCustom) {
    return (
      <select value={text} onChange={(e) => onCommit(e.target.value || null)} className={base}>
        <option value="" />
        {column.format.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  const commit = () => {
    if (text !== inputText(value)) {
      onCommit(cellValue(column, text));
    }
  };
  return (
    <input
      aria-label={column.name}
      type={column.type === "date" && column.format.kind === "date" ? "date" : "text"}
      inputMode={column.type === "number" ? "decimal" : undefined}
      enterKeyHint="done"
      autoComplete="off"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={cn(base, column.type === "number" && "text-right tabular-nums")}
    />
  );
}

/** One of the wizard's stored lists: read, or edited in place by the person it belongs to. */
export function ListTable({
  runId,
  list,
  editable,
}: {
  runId: string;
  list: ShownList;
  editable?: boolean;
}) {
  const { def, rows } = list;
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const base = `${runBase(runId)}/lists/${def.id}/rows`;
  const call = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };
  const addRow = () =>
    call(async () => {
      await api.post(base, { cells: draft });
      setDraft({});
    });
  const hasDraft = Object.values(draft).some((v) => v !== null && v !== undefined && v !== "");
  if (!rows.length && !editable) {
    return <p className="text-[0.875rem] text-ink-3">{t("list.empty")}</p>;
  }
  const wide = (c: TableColumn, i: number) =>
    i === 0 || (c.type === "text" && c.format?.style === "multiline");
  const commitCell = (rowId: string, columnId: string, value: unknown) =>
    void call(() => api.patch(`${base}/${rowId}`, { cells: { [columnId]: value } }));
  return (
    <div>
      {/* A phone shows each row as a card of labelled cells; a table would scroll sideways. */}
      <div className="flex flex-col gap-2 sm:hidden">
        {rows.map((row) => (
          <div key={row.id} className="rounded-lg bg-paper p-2 ring-1 ring-border-soft">
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              {def.columns.map((c, i) => (
                <div key={c.id} className={cn("min-w-0", wide(c, i) && "col-span-2")}>
                  <div className="px-1 pb-0.5 text-[0.6875rem] text-ink-3">{c.name}</div>
                  {editable ? (
                    <CellInput
                      boxed
                      column={c}
                      value={row.cells[c.id]}
                      onCommit={(value) => commitCell(row.id, c.id, value)}
                    />
                  ) : (
                    <div
                      className={cn(
                        "break-words px-1 text-[0.875rem]",
                        c.type === "number" && "tabular-nums",
                      )}
                    >
                      {formatTableCell(c, row.cells[c.id], lang) || "—"}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {editable ? (
              <div className="mt-1 flex justify-end">
                <IconButton
                  label={t("list.delete")}
                  onClick={() => void call(() => api.del(`${base}/${row.id}`))}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            ) : null}
          </div>
        ))}
        {editable ? (
          <div className="rounded-lg border border-input border-dashed p-2">
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              {def.columns.map((c, i) => (
                <div key={c.id} className={cn("min-w-0", wide(c, i) && "col-span-2")}>
                  <div className="px-1 pb-0.5 text-[0.6875rem] text-ink-3">{c.name}</div>
                  <CellInput
                    boxed
                    column={c}
                    value={draft[c.id]}
                    onCommit={(value) => setDraft((d) => ({ ...d, [c.id]: value }))}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                // The cell being typed in commits on blur, just before this click lands.
                onClick={() => (hasDraft ? void addRow() : undefined)}
              >
                <Plus className="size-4" /> {t("run.addRow")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="hidden overflow-x-auto rounded-lg ring-1 ring-border-soft sm:block">
        <table className="w-full text-[0.8125rem]">
          <thead className="bg-paper-2 text-ink-2">
            <tr>
              {def.columns.map((c) => (
                <th key={c.id} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                  {c.name}
                </th>
              ))}
              {editable ? <th className="w-10" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-border-soft border-t align-top">
                {def.columns.map((c) => (
                  <td
                    key={c.id}
                    className={cn("min-w-[7.5rem]", editable ? "px-1 py-0.5" : "px-3 py-2")}
                  >
                    {editable ? (
                      <CellInput
                        column={c}
                        value={row.cells[c.id]}
                        onCommit={(value) => commitCell(row.id, c.id, value)}
                      />
                    ) : (
                      <span className={cn(c.type === "number" && "tabular-nums")}>
                        {formatTableCell(c, row.cells[c.id], lang)}
                      </span>
                    )}
                  </td>
                ))}
                {editable ? (
                  <td className="px-1 py-0.5">
                    <IconButton
                      label={t("list.delete")}
                      className="size-9"
                      onClick={() => void call(() => api.del(`${base}/${row.id}`))}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </td>
                ) : null}
              </tr>
            ))}
            {editable ? (
              <tr className="border-border-soft border-t bg-paper">
                {def.columns.map((c) => (
                  <td key={c.id} className="px-1 py-0.5">
                    <CellInput
                      column={c}
                      value={draft[c.id]}
                      onCommit={(value) => setDraft((d) => ({ ...d, [c.id]: value }))}
                    />
                  </td>
                ))}
                <td className="px-1 py-0.5">
                  <IconButton
                    label={t("run.addRow")}
                    className="size-9"
                    onClick={() => (hasDraft ? void addRow() : undefined)}
                  >
                    <Plus className="size-4" />
                  </IconButton>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {error ? <p className="mt-2 text-[0.8125rem] text-rose">{error}</p> : null}
    </div>
  );
}

/** The path of a kept file as its address: shown in place for PDFs and photos. */
function storeFileUrl(runId: string, path: string, inline: boolean): string {
  const safe = path.split("/").map(encodeURIComponent).join("/");
  return withBase(`${runBase(runId)}/store/files/${safe}${inline ? "?inline=1" : ""}`);
}

const ANSWER_TONE = [
  "bg-paper-3 text-ink-3",
  "bg-moss-tint text-moss",
  "bg-rose-tint text-rose",
  "bg-ember-tint text-ember-strong",
];

/**
 * A list the person goes through row by row: the rows on the left, the row's kept file and its
 * cells on the right, and the answers of the list's status column as buttons. An answer saves
 * and moves on to the next open row.
 */
export function ListCheck({ runId, list }: { runId: string; list: ShownList }) {
  const { def, rows } = list;
  const fileColumn = def.columns.find((c) => c.id === def.check?.file);
  const statusColumn = def.columns.find((c) => c.id === def.check?.status);
  const answers = statusColumn?.type === "select" ? statusColumn.format.options : [];
  const openId = answers[0]?.id;
  const statusOf = (row: ShownList["rows"][number]) =>
    statusColumn ? String(row.cells[statusColumn.id] ?? openId ?? "") : "";
  const isOpen = (row: ShownList["rows"][number]) => !statusColumn || statusOf(row) === openId;
  const [selected, setSelected] = useState<string | null>(
    () => (rows.find(isOpen) ?? rows[0])?.id ?? null,
  );
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `${runBase(runId)}/lists/${def.id}/rows`;
  const current = rows.find((r) => r.id === selected) ?? rows[0];
  const shown = onlyOpen ? rows.filter((r) => isOpen(r) || r.id === current?.id) : rows;
  const done = rows.filter((r) => !isOpen(r)).length;
  const labelled = def.columns.filter((c) => c !== fileColumn && c !== statusColumn);
  // A row is named by its first text cell; the next two cells (a date, an amount) stand below.
  const named = labelled.filter((c) => c.id !== def.key);
  const titleColumn = named.find((c) => c.type === "text") ?? named[0];
  const restColumns = named.filter((c) => c !== titleColumn);
  const patch = async (rowId: string, cells: Record<string, unknown>) => {
    setError(null);
    try {
      await api.patch(`${base}/${rowId}`, { cells });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };
  const move = (step: number) => {
    const at = shown.findIndex((r) => r.id === current?.id);
    const next = shown[Math.min(shown.length - 1, Math.max(0, at + step))];
    if (next) {
      setSelected(next.id);
    }
  };
  const answer = async (id: string) => {
    if (!current || !statusColumn) {
      return;
    }
    const at = rows.findIndex((r) => r.id === current.id);
    // The next row still open, looking onward from this one and then from the top.
    const next = [...rows.slice(at + 1), ...rows.slice(0, at)].find(isOpen);
    await patch(current.id, { [statusColumn.id]: id });
    if (next && id !== openId) {
      setSelected(next.id);
    }
  };
  // Arrow keys walk the list and digits answer, as long as nobody is typing in a cell.
  const keys = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) {
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (/^[1-9]$/.test(e.key) && answers[Number(e.key)]) {
      e.preventDefault();
      void answer(answers[Number(e.key)].id);
    }
  };
  if (!rows.length) {
    return <p className="text-[0.875rem] text-ink-3">{t("list.empty")}</p>;
  }
  const path = fileColumn && current ? String(current.cells[fileColumn.id] ?? "").trim() : "";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const tone = (row: ShownList["rows"][number]) =>
    ANSWER_TONE[
      Math.min(
        Math.max(
          0,
          answers.findIndex((a) => a.id === statusOf(row)),
        ),
        3,
      )
    ];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]" onKeyDown={keys}>
      <div className="flex min-h-0 flex-col">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[0.8125rem] text-ink-3 tabular-nums">
            {t("check.progress", { done, total: rows.length })}
          </span>
          {statusColumn ? (
            <button
              type="button"
              aria-pressed={onlyOpen}
              onClick={() => setOnlyOpen((v) => !v)}
              className={cn(
                "inline-flex h-8 items-center rounded-full px-3 text-[0.8125rem] ring-1 transition coarse:h-11",
                onlyOpen
                  ? "bg-ember-tint text-ink ring-ember"
                  : "bg-card text-ink-2 ring-input hover:text-ink",
              )}
            >
              {t("check.onlyOpen")}
            </button>
          ) : null}
        </div>
        <ul className="flex max-h-[38vh] flex-col gap-1.5 overflow-y-auto p-0.5 pr-1 lg:max-h-[calc(100vh-15rem)]">
          {shown.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => setSelected(row.id)}
                aria-current={row.id === current?.id}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ring-1 transition",
                  row.id === current?.id
                    ? "bg-card shadow-soft ring-ember"
                    : "bg-paper ring-border-soft hover:bg-card",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[0.875rem]">
                    {(titleColumn &&
                      formatTableCell(titleColumn, row.cells[titleColumn.id], lang)) ||
                      "—"}
                  </span>
                  <span className="block truncate text-[0.75rem] text-ink-3 tabular-nums">
                    {restColumns
                      .slice(0, 2)
                      .map((c) => formatTableCell(c, row.cells[c.id], lang))
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {statusColumn ? (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 font-medium text-[0.6875rem]",
                      tone(row),
                    )}
                  >
                    {answers.find((a) => a.id === statusOf(row))?.label ?? statusOf(row)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {current ? (
        <div className="flex min-w-0 flex-col gap-3">
          {answers.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {answers.slice(1).map((a, i) => (
                <Button
                  key={a.id}
                  size="md"
                  variant={statusOf(current) === a.id ? "primary" : "secondary"}
                  onClick={() => void answer(a.id)}
                >
                  {statusOf(current) === a.id ? <Check className="size-4" /> : null}
                  {a.label}
                  <kbd className="ml-1 hidden rounded bg-black/10 px-1.5 text-[0.6875rem] lg:inline">
                    {i + 1}
                  </kbd>
                </Button>
              ))}
              {statusOf(current) !== openId ? (
                <Button size="md" variant="ghost" onClick={() => void answer(openId ?? "")}>
                  {t("check.reopen")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="overflow-hidden rounded-lg bg-paper-2 ring-1 ring-border-soft">
            {path ? (
              <>
                <div className="flex items-center gap-2 border-border-soft border-b bg-card px-3 py-2 text-[0.8125rem]">
                  <FileText className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{path.split("/").pop()}</span>
                  <a
                    href={storeFileUrl(runId, path, ext === "pdf")}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                  >
                    {t("run.openFull")}
                  </a>
                </div>
                {ext === "pdf" ? (
                  <iframe
                    key={path}
                    title={path}
                    src={`${storeFileUrl(runId, path, true)}#toolbar=0&navpanes=0&view=FitH`}
                    className="h-[46vh] w-full border-0 bg-white lg:h-[calc(100vh-27rem)] lg:min-h-[360px]"
                  />
                ) : ["png", "jpg", "jpeg", "webp"].includes(ext) ? (
                  <div className="flex max-h-[46vh] justify-center overflow-auto bg-white lg:max-h-[calc(100vh-27rem)]">
                    <img
                      key={path}
                      src={storeFileUrl(runId, path, true)}
                      alt={path}
                      className="max-w-full object-contain"
                    />
                  </div>
                ) : (
                  <p className="px-4 py-10 text-center text-[0.875rem] text-ink-3">
                    {t("check.noPreview")}
                  </p>
                )}
              </>
            ) : (
              <p className="px-4 py-14 text-center text-[0.875rem] text-ink-3">
                {t("check.noFile")}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
            {labelled.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "min-w-0",
                  c.type === "text" && c.format?.style === "multiline" && "col-span-full",
                )}
              >
                <div className="px-1 pb-0.5 text-[0.6875rem] text-ink-3">{c.name}</div>
                <CellInput
                  boxed
                  column={c}
                  value={current.cells[c.id]}
                  onCommit={(value) => void patch(current.id, { [c.id]: value })}
                />
              </div>
            ))}
          </div>
          {error ? <p className="text-[0.8125rem] text-rose">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

const LIST_FORMAT_LABEL: Partial<Record<Format, string>> = {
  xlsx: "Excel",
  csv: "CSV",
  json: "JSON",
  md: "Markdown",
  zip: "ZIP",
};

export function ListDownloads({ runId, list }: { runId: string; list: ShownList }) {
  return (
    <div className="flex flex-wrap gap-2">
      {list.formats.map((f) => (
        <a
          key={f}
          href={withBase(`${runBase(runId)}/lists/${list.def.id}/download?format=${f}`)}
          className="inline-flex h-9 items-center rounded-full bg-paper-2 px-3.5 font-medium text-[0.8125rem] text-ink-2 transition hover:bg-paper-3 hover:text-ink coarse:h-11 coarse:px-4"
        >
          {LIST_FORMAT_LABEL[f] ?? f}
        </a>
      ))}
    </div>
  );
}

// --- what the wizard keeps -------------------------------------------------------

interface StoreSummary {
  lists: { id: string; title: string; rows: number }[];
  files: StoreFile[];
  connections: ConnectionView[];
  keepsSignIns: boolean;
}

/** Everything the wizard keeps for this person between runs, and the way to delete it. */
export function StoreButton({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<StoreSummary | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (open) {
      setConfirm(false);
      void api.get<StoreSummary>(`${runBase(runId)}/store`).then(setData);
    }
  }, [open, runId]);
  const empty =
    data &&
    !data.files.length &&
    !data.connections.length &&
    !data.keepsSignIns &&
    data.lists.every((l) => !l.rows);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-[0.8125rem] text-ink-4 transition hover:text-ink-2 coarse:min-h-11"
      >
        <Database className="size-3.5" /> {t("store.open")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("store.title")} wide>
        {!data ? (
          <div className="flex justify-center py-8 text-ink-4">
            <Spinner />
          </div>
        ) : (
          <div className="flex flex-col gap-5 text-[0.875rem]">
            <p className="text-ink-3">{t("store.explain")}</p>
            {empty ? <p className="text-ink-2">{t("store.empty")}</p> : null}
            {data.lists.some((l) => l.rows) ? (
              <ul className="flex flex-col gap-1">
                {data.lists
                  .filter((l) => l.rows)
                  .map((l) => (
                    <li key={l.id} className="flex justify-between gap-3">
                      <span>{l.title}</span>
                      <span className="text-ink-3 tabular-nums">
                        {t("store.rows", { n: l.rows })}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : null}
            {data.connections.map((c) => (
              <div key={c.id} className="flex items-center gap-2">
                <Link2 className="size-4 text-ink-3" /> {c.account?.label}
              </div>
            ))}
            {data.keepsSignIns ? (
              <div className="flex items-center gap-2">
                <Check className="size-4 text-ink-3" /> {t("store.signIns")}
              </div>
            ) : null}
            {data.files.length ? (
              <div>
                <div className="mb-1 text-ink-3">
                  {t("store.files", {
                    n: data.files.length,
                    size: formatBytes(data.files.reduce((n, f) => n + f.size, 0)),
                  })}
                </div>
                <ul className="max-h-56 overflow-y-auto rounded-lg ring-1 ring-border-soft">
                  {data.files.map((f) => (
                    <li key={f.path} className="border-border-soft border-b last:border-0">
                      <a
                        href={withBase(`${runBase(runId)}/store/files/${f.path}`)}
                        className="flex items-center gap-2 px-3 py-2 text-[0.8125rem] hover:bg-paper-2 coarse:min-h-11"
                        title={f.source ?? undefined}
                      >
                        <FileText className="size-3.5 shrink-0 text-ink-3" />
                        <span className="min-w-0 flex-1 truncate">{f.path}</span>
                        <span className="text-ink-4 tabular-nums">{formatBytes(f.size)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 pt-1">
              {empty ? (
                <span />
              ) : confirm ? (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    await api.del(`${runBase(runId)}/store`);
                    setData(await api.get<StoreSummary>(`${runBase(runId)}/store`));
                    setConfirm(false);
                  }}
                >
                  <Trash2 className="size-4" /> {t("store.confirmDelete")}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setConfirm(true)}>
                  <Trash2 className="size-4" /> {t("store.delete")}
                </Button>
              )}
              <Button onClick={() => setOpen(false)}>{t("common.close")}</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
