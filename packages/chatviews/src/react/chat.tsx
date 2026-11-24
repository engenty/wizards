// SPDX-License-Identifier: MIT
// First: keeps react-lang from mounting its devtools, which a development build loads from a CDN.
import "./no-devtools.js";
import {
  type ActionEvent,
  createLibrary,
  defineComponent,
  type ElementNode,
  FormNameContext,
  Renderer,
  useFormName,
  useIsStreaming,
  useStateField,
  useTriggerAction,
} from "@openuidev/react-lang";
import { createContext, type ReactNode, useContext, useId, useRef, useState } from "react";
import {
  CHAT_ACTIONS,
  CHAT_COMPONENTS,
  CHAT_FUNCTIONS,
  type ChatComponent,
} from "../chat/library.js";
import type { SurfaceComponent } from "../surface.js";
import { type SurfaceChat, SurfaceView } from "./surface.js";
import { t } from "./texts.js";
import { Button, cn, Input, Label, Select, Swatch, Switch, Textarea } from "./ui.js";

/** What a host gives the views a model wrote: where files and Refs lead, who answered. */
export interface ViewHost {
  /** Where a file of the space is read, by its id. */
  assetUrl(id: string): string;
  /** Where a Ref's `open` leads, and how the host follows it. */
  chat?: Pick<SurfaceChat, "href" | "follow">;
  /** The Form's answers someone already sent: shown, not to be sent again. */
  answered?: { by: string } | null;
}

const HostContext = createContext<ViewHost>({ assetUrl: (id) => id });

const isElement = (v: unknown): v is ElementNode =>
  Boolean(v && typeof v === "object" && (v as { type?: unknown }).type === "element");

/**
 * A component of the catalog, drawn by SurfaceView: its props as the program gave them, the
 * components it holds as slots that OpenUI draws.
 */
function drawn(name: string) {
  return function Drawn({
    props,
    renderNode,
  }: {
    props: Record<string, unknown>;
    renderNode: (value: unknown) => ReactNode;
  }) {
    const host = useContext(HostContext);
    const slots = new Map<string, ReactNode>();
    const holds = (v: unknown): unknown => {
      if (isElement(v)) {
        const id = `s${slots.size}`;
        slots.set(id, renderNode(v));
        return id;
      }
      if (Array.isArray(v)) {
        return v.map(holds);
      }
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, holds(x)]));
      }
      return v;
    };
    const own = holds(props) as Record<string, unknown>;
    const component = { ...own, id: "root", component: name } as SurfaceComponent;
    return (
      <SurfaceView
        surface={{ components: [component], data: {} }}
        assetUrl={host.assetUrl}
        chat={host.chat}
        slots={slots}
      />
    );
  };
}

/** A Button: its action as the program wrote it (ask the assistant, open a thing, a page). */
function ActionButton({ props }: { props: Record<string, unknown> }) {
  const trigger = useTriggerAction();
  const formName = useFormName();
  const streaming = useIsStreaming();
  const label = String(props.label ?? "");
  return (
    <Button
      variant="secondary"
      size="sm"
      className="self-start"
      disabled={streaming}
      onClick={() => void trigger(label, formName, props.action as Parameters<typeof trigger>[2])}
    >
      {label}
    </Button>
  );
}

/** The Fields of a Form: whether one that must be answered is empty, by name. */
interface FormFields {
  register(name: string, check: () => boolean): () => void;
  missing: ReadonlySet<string>;
  sent: boolean;
}

const FieldsContext = createContext<FormFields | null>(null);

/** A Form: its Fields, and a button that sends the answers as the person's message. */
function FormBox({
  props,
  renderNode,
  statementId,
}: {
  props: Record<string, unknown>;
  renderNode: (value: unknown) => ReactNode;
  statementId?: string;
}) {
  const host = useContext(HostContext);
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const name = statementId ?? "form";
  const checks = useRef(new Map<string, () => boolean>());
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const answered = host.answered ?? null;
  const fields: FormFields = {
    register(field, check) {
      checks.current.set(field, check);
      return () => checks.current.delete(field);
    },
    missing,
    sent: Boolean(answered),
  };
  const submit = String(props.submit ?? "");
  const send = () => {
    const empty = new Set([...checks.current].filter(([, filled]) => !filled()).map(([f]) => f));
    setMissing(empty);
    if (empty.size === 0) {
      void trigger(submit, name, { type: "continue_conversation" });
    }
  };
  return (
    <FormNameContext.Provider value={name}>
      <FieldsContext.Provider value={fields}>
        <div className="flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-border-soft">
          {props.title ? (
            <div className="font-semibold text-[1rem]">{String(props.title)}</div>
          ) : null}
          {renderNode(props.children)}
          {answered ? (
            <div className="text-[0.8125rem] text-ink-3">
              {t("surface.sentBy", { name: answered.by })}
            </div>
          ) : (
            <Button className="self-start" disabled={streaming} onClick={send}>
              {submit}
            </Button>
          )}
        </div>
      </FieldsContext.Provider>
    </FormNameContext.Provider>
  );
}

const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** One answer of a Form, kept in OpenUI's form state under its name. */
function FieldBox({ props }: { props: Record<string, unknown> }) {
  const name = String(props.name ?? "");
  const kind = String(props.kind ?? "text");
  const field = useStateField(name);
  const fields = useContext(FieldsContext);
  const id = useId();
  const start = props.value;
  const value = field.value === undefined ? start : field.value;
  const required = props.required === true;
  const registered = useRef<string | null>(null);
  if (fields && registered.current !== name) {
    registered.current = name;
    fields.register(name, () => !required || !empty(field.value ?? start));
  }
  const options = Array.isArray(props.options) ? props.options.map(String) : [];
  const disabled = fields?.sent ?? false;
  const set = (v: unknown) => field.setValue(v);
  const label = String(props.label ?? name);
  const placeholder = typeof props.placeholder === "string" ? props.placeholder : undefined;
  let input: ReactNode;
  switch (kind) {
    case "textarea":
      input = (
        <Textarea
          id={id}
          value={String(value ?? "")}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => set(e.target.value)}
        />
      );
      break;
    case "select":
      input = (
        <Select
          value={String(value ?? "")}
          placeholder={placeholder ?? ""}
          options={options.map((o) => ({ value: o, label: o }))}
          onChange={set}
        />
      );
      break;
    case "multiselect": {
      const chosen = new Set(Array.isArray(value) ? value.map(String) : []);
      input = (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={disabled}
              onClick={() => {
                const next = new Set(chosen);
                if (next.has(o)) {
                  next.delete(o);
                } else {
                  next.add(o);
                }
                set(options.filter((x) => next.has(x)));
              }}
              className={cn(
                "h-9 rounded-full px-3.5 text-[0.875rem] ring-1",
                chosen.has(o) ? "bg-ink text-paper ring-ink" : "bg-card ring-border-soft",
              )}
            >
              {o}
            </button>
          ))}
        </div>
      );
      break;
    }
    case "toggle":
      input = <Switch checked={value === true} label={label} disabled={disabled} onChange={set} />;
      break;
    case "color":
      input = <Swatch value={String(value ?? "#000000")} onChange={(e) => set(e.target.value)} />;
      break;
    default:
      input = (
        <Input
          id={id}
          type={
            kind === "number" ? "number" : ["date", "email", "url"].includes(kind) ? kind : "text"
          }
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) =>
            set(
              kind === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value,
            )
          }
        />
      );
  }
  return (
    <label htmlFor={id} className="block">
      <Label required={required}>{label}</Label>
      {input}
      {fields?.missing.has(name) ? (
        <div className="mt-1 text-[0.8125rem] text-rose">{t("surface.required")}</div>
      ) : null}
    </label>
  );
}

const OWN: Record<string, (c: ChatComponent) => ReturnType<typeof defineComponent>> = {
  Button: (c) => defineComponent({ ...c, component: ActionButton }),
  Form: (c) => defineComponent({ ...c, component: FormBox }),
  Field: (c) => defineComponent({ ...c, component: FieldBox }),
};

/** The chat library with its drawing: what `ViewRenderer` draws a program with. */
export const chatLibrary = createLibrary({
  components: CHAT_COMPONENTS.map((c) =>
    OWN[c.name] ? OWN[c.name](c) : defineComponent({ ...c, component: drawn(c.name) }),
  ),
  functions: CHAT_FUNCTIONS,
  actions: CHAT_ACTIONS,
  root: "Column",
});

/**
 * A view a model wrote (an OpenUI Lang program, checked with `checkView` before it was stored),
 * drawn with the catalog's components. `onAction` gets OpenUI's action events: a button that
 * asks the assistant and a Form's send are `continue_conversation` with the form's state,
 * `Open` carries a Ref's `open`, `open_url` an address.
 */
export function ViewRenderer({
  program,
  host,
  onAction,
  initialState,
  onStateUpdate,
  streaming = false,
}: {
  program: string;
  host: ViewHost;
  onAction?: (event: ActionEvent) => void;
  /** A Form's answers kept from last time (the card's draft, or what was sent). */
  initialState?: Record<string, unknown>;
  onStateUpdate?: (state: Record<string, unknown>) => void;
  streaming?: boolean;
}) {
  return (
    <HostContext.Provider value={host}>
      <div className="flex flex-col gap-3">
        <Renderer
          response={program}
          library={chatLibrary}
          isStreaming={streaming}
          onAction={onAction}
          initialState={initialState}
          onStateUpdate={onStateUpdate}
        />
      </div>
    </HostContext.Provider>
  );
}
