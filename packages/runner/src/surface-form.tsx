import type { Field } from "@engenty/wizards-shared/definition";
import { bound, type SurfaceComponent } from "@engenty/wizards-shared/surface";
import { useState } from "react";
import { FieldInput, type Values } from "./fields.js";
import { lang, t } from "./i18n.js";
import { Button } from "./ui.js";

/**
 * A chat's Form: Fields drawn by the runner's own field kinds, as a wizard's page draws them
 * (native inputs, the camera, the place, a recording, a signature), sent as the person's message.
 * Once someone sent it, it shows their answers and who sent them.
 */

/** What a chat gives its views: where Refs lead and how the Form's answers are sent. */
export interface SurfaceChat {
  /** Where a Ref's `open` leads; null: it shows without a link. */
  href(open: string): string | null;
  /** Follows an address of the host's own (its router), instead of loading the page. */
  follow?(href: string): void;
  /** The chat's routes for the Fields: `${base}/uploads`, `${base}/assets/<id>`, `${base}/geocode`. */
  fieldBase: string;
  /** Sends the answers as the person's message. */
  submit(answer: SurfaceFormAnswer): Promise<void>;
  /** The answers someone already sent: shown, not to be sent again. */
  answered?: { by: string; values: Values } | null;
}

/** A Form's answers: by field name, the message's text, and the files they name. */
export interface SurfaceFormAnswer {
  form: string;
  values: Values;
  text: string;
  files: string[];
}

const FILE_KINDS = new Set(["image", "file", "audio", "signature"]);

/** A Field as the runner's field kinds take it: its name is the field's id. */
function fieldOf(c: SurfaceComponent, data: Record<string, unknown>): Field {
  const f = c as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    id: String(f.name),
    kind: f.kind,
    label: String(bound(f.label, data) ?? ""),
    required: f.required === true,
    placeholder: str(f.placeholder),
    help: str(f.help),
    options: Array.isArray(f.options) ? f.options.map(String) : undefined,
    multiple: f.multiple === true,
    camera: f.camera === true,
  } as Field;
}

const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** The ids of the files an answer names: an upload, several, a recording, a signature. */
function fileIds(kind: string, v: unknown): string[] {
  if (!FILE_KINDS.has(kind) || empty(v)) {
    return [];
  }
  if (Array.isArray(v)) {
    return v.map(String);
  }
  if (typeof v === "object") {
    const asset = (v as { asset?: unknown }).asset;
    return typeof asset === "string" ? [asset] : [];
  }
  return [String(v)];
}

/** An answer in words, for the message and for the answers shown once sent. */
function answerText(kind: string, v: unknown): string {
  if (empty(v)) {
    return "—";
  }
  const files = fileIds(kind, v);
  if (files.length) {
    return files.length === 1 ? t("surface.file") : t("surface.files", { n: files.length });
  }
  if (typeof v === "boolean") {
    return t(v ? "run.yes" : "run.no");
  }
  if (kind === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return new Date(`${v}T12:00:00`).toLocaleDateString(lang, { dateStyle: "medium" });
  }
  if (Array.isArray(v)) {
    return v.join(", ");
  }
  if (typeof v === "object") {
    const place = v as { label?: unknown; lat?: unknown; lng?: unknown };
    return typeof place.label === "string" && place.label
      ? place.label
      : `${place.lat ?? ""}, ${place.lng ?? ""}`;
  }
  return String(v);
}

export function FormView({
  c,
  byId,
  data,
  chat,
}: {
  c: SurfaceComponent;
  byId: Map<string, SurfaceComponent>;
  data: Record<string, unknown>;
  chat?: SurfaceChat;
}) {
  const fields = (Array.isArray(c.children) ? c.children : [])
    .map((id) => byId.get(id))
    .filter((f): f is SurfaceComponent => f?.component === "Field")
    .map((f) => ({ field: fieldOf(f, data), value: (f as Record<string, unknown>).value }));
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(
      fields.filter((f) => f.value !== undefined).map((f) => [f.field.id, bound(f.value, data)]),
    ),
  );
  const [busy, setBusy] = useState(0);
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<Values | null>(null);
  const title = String(bound((c as Record<string, unknown>).title, data) ?? "");
  const answered = chat?.answered ?? (sent ? { by: "", values: sent } : null);

  if (!chat) {
    return null;
  }
  if (answered) {
    return (
      <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border-soft">
        {title ? <div className="font-medium text-[0.9375rem]">{title}</div> : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[0.875rem]">
          {fields
            .filter(({ field }) => !empty(answered.values[field.id]))
            .map(({ field }) => (
              <div key={field.id} className="contents">
                <dt className="text-ink-3">{field.label}</dt>
                <dd className="break-words">{answerText(field.kind, answered.values[field.id])}</dd>
              </div>
            ))}
        </dl>
        {answered.by ? (
          <div className="text-[0.8125rem] text-ink-3">
            {t("surface.sentBy", { name: answered.by })}
          </div>
        ) : null}
      </div>
    );
  }

  const send = async () => {
    const missing = Object.fromEntries(
      fields
        .filter(({ field }) => field.required && empty(values[field.id]))
        .map(({ field }) => [field.id, t("surface.required")]),
    );
    setErrors(missing);
    if (Object.keys(missing).length) {
      return;
    }
    // The message names what was answered; what was left open stays out of it.
    const lines = fields
      .filter(({ field }) => !empty(values[field.id]))
      .map(({ field }) => `${field.label}: ${answerText(field.kind, values[field.id])}`);
    setSending(true);
    setFailed(null);
    try {
      await chat.submit({
        form: c.id,
        values,
        text: [title, ...lines].filter(Boolean).join("\n"),
        files: fields.flatMap(({ field }) => fileIds(field.kind, values[field.id])),
      });
      setSent(values);
    } catch (err) {
      setFailed((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-border-soft"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {title ? <div className="font-medium text-[0.9375rem]">{title}</div> : null}
      {fields.map(({ field }) => (
        <FieldInput
          key={field.id}
          field={field}
          value={values[field.id]}
          values={values}
          runId=""
          base={chat.fieldBase}
          error={errors[field.id]}
          onBusy={(on) => setBusy((n) => Math.max(0, n + (on ? 1 : -1)))}
          onChange={(v) => setValues((now) => ({ ...now, [field.id]: v }))}
        />
      ))}
      {failed ? <div className="text-[0.8125rem] text-rose">{failed}</div> : null}
      <Button type="submit" className="self-start" busy={sending} disabled={busy > 0}>
        {sending
          ? t("surface.sending")
          : String(bound((c as Record<string, unknown>).submit, data) ?? "")}
      </Button>
    </form>
  );
}
