import { type KernelFile, MODEL_CLASSES, TOOL_IDS } from "@engenty/wizards-shared/definition";
import { withConnections, withRequires } from "@engenty/wizards-shared/kernel-file";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { t } from "../../lib/i18n";
import { IconButton, Input, Label, Segmented } from "../../ui";
import { toolLabel } from "./meta";

const CODE = "font-mono text-[0.8125rem] text-ink";
const ROW = "flex items-center gap-2 rounded-lg bg-paper px-3 py-1.5 ring-1 ring-border-soft";
const ROLE_ID = /^[a-z][a-z0-9_-]*$/;
const BUILT_IN: readonly string[] = TOOL_IDS;

/** A field that adds one name: Enter or the button takes it, where `valid` lets it. */
function Add({
  example,
  valid = (name) => name.length > 0,
  onAdd,
}: {
  example: string;
  valid?: (name: string) => boolean;
  onAdd: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const ready = valid(name.trim());
  const add = () => {
    if (ready) {
      onAdd(name.trim());
      setName("");
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={name}
        placeholder={example}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
      <IconButton label={t("kernel.needs.add")} disabled={!ready} onClick={add}>
        <Plus className="size-4" />
      </IconButton>
    </div>
  );
}

/** Names in a list: each with a button that removes it, and a field that adds one. */
function Names({
  values,
  example,
  onChange,
}: {
  values: string[];
  example: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {values.map((name) => (
        <div key={name} className={ROW}>
          <code className={`${CODE} min-w-0 flex-1 truncate`}>{name}</code>
          <IconButton
            label={t("kernel.needs.remove", { name })}
            className="size-7 hover:text-rose"
            onClick={() => onChange(values.filter((one) => one !== name))}
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
      ))}
      <Add
        example={example}
        valid={(name) => name.length > 0 && !values.includes(name)}
        onAdd={(name) => onChange([...values, name])}
      />
    </div>
  );
}

/**
 * What a wizard of version 0.3.0 needs from where it runs and what it may reach, as a form: the
 * file's `requires` and `connections` (docs/plans/kernel.md). A step that names anything the
 * file does not have fails, so this is where a new model class, tool, role, host or action is
 * let in.
 */
export function KernelNeeds({
  file,
  onFile,
}: {
  file: KernelFile;
  onFile: (file: KernelFile) => void;
}) {
  const requires = file.requires ?? {};
  const connections = file.connections ?? {};
  const set = (next: Partial<NonNullable<KernelFile["requires"]>>) =>
    onFile(withRequires(file, { ...requires, ...next }));
  const connect = (next: NonNullable<KernelFile["connections"]>) =>
    onFile(withConnections(file, next));
  const tools = requires.tools ?? [];
  const roles = Object.entries(requires.roles ?? {});
  return (
    <>
      <p className="text-[0.8125rem] text-ink-3">{t("kernel.needs.hint")}</p>
      <div>
        <Label>{t("kernel.needs.models")}</Label>
        <Segmented
          multi
          value={requires.models ?? []}
          options={[...MODEL_CLASSES]}
          label={(name) => t(`class.${name}` as "class.low")}
          onChange={(models: string[]) =>
            set({ models: MODEL_CLASSES.filter((name) => models.includes(name)) })
          }
        />
      </div>
      <div>
        <Label hint={t("kernel.needs.toolsHint")}>{t("kernel.needs.tools")}</Label>
        <div className="flex flex-col gap-2">
          <Segmented
            multi
            value={tools.filter((name) => BUILT_IN.includes(name))}
            options={[...TOOL_IDS]}
            label={toolLabel}
            onChange={(built: string[]) =>
              set({ tools: [...built, ...tools.filter((name) => !BUILT_IN.includes(name))] })
            }
          />
          <Names
            values={tools.filter((name) => !BUILT_IN.includes(name))}
            example={t("kernel.needs.toolExample")}
            onChange={(own) =>
              set({ tools: [...tools.filter((name) => BUILT_IN.includes(name)), ...own] })
            }
          />
        </div>
      </div>
      <div>
        <Label hint={t("kernel.needs.hostsHint")}>{t("kernel.needs.hosts")}</Label>
        <Names
          values={requires.hosts ?? []}
          example={t("kernel.needs.hostExample")}
          onChange={(hosts) => set({ hosts })}
        />
      </div>
      <div>
        <Label hint={t("kernel.needs.rolesHint")}>{t("kernel.needs.roles")}</Label>
        <div className="flex flex-col gap-1.5">
          {roles.map(([id, title]) => (
            <div key={id} className="flex items-center gap-2">
              <code className={`${CODE} w-28 shrink-0 truncate`}>{id}</code>
              <Input
                value={title}
                aria-label={t("kernel.needs.roleTitle", { id })}
                onChange={(e) =>
                  // A role keeps a title: an empty one is not written.
                  e.target.value && set({ roles: { ...requires.roles, [id]: e.target.value } })
                }
              />
              <IconButton
                label={t("kernel.needs.remove", { name: id })}
                className="hover:text-rose"
                onClick={() => {
                  const { [id]: _gone, ...rest } = requires.roles ?? {};
                  set({ roles: rest });
                }}
              >
                <X className="size-4" />
              </IconButton>
            </div>
          ))}
          <Add
            example={t("kernel.needs.roleExample")}
            valid={(id) => ROLE_ID.test(id) && !(id in (requires.roles ?? {}))}
            onAdd={(id) => set({ roles: { ...requires.roles, [id]: id } })}
          />
        </div>
      </div>
      <div>
        <Label hint={t("kernel.connections.hint")}>{t("needs.title")}</Label>
        <div className="flex flex-col gap-2">
          {Object.entries(connections).map(([name, actions]) => (
            <div key={name} className="rounded-lg bg-paper px-3 py-2.5 ring-1 ring-border-soft">
              <div className="flex items-center gap-2">
                <code className={`${CODE} min-w-0 flex-1 truncate font-medium`}>{name}</code>
                <IconButton
                  label={t("kernel.needs.remove", { name })}
                  className="size-7 hover:text-rose"
                  onClick={() => {
                    const { [name]: _gone, ...rest } = connections;
                    connect(rest);
                  }}
                >
                  <X className="size-3.5" />
                </IconButton>
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {Object.entries(actions).map(([action, policy]) => (
                  <div key={action} className="flex flex-wrap items-center gap-2">
                    <code className={`${CODE} min-w-0 flex-1 truncate`}>{action}</code>
                    <Segmented
                      value={policy}
                      options={["allow", "ask"]}
                      label={(one) => t(`kernel.connections.${one}` as "kernel.connections.allow")}
                      onChange={(next: "allow" | "ask" | "") =>
                        // A click on the chosen one leaves it chosen: an action is one of the two.
                        next && connect({ ...connections, [name]: { ...actions, [action]: next } })
                      }
                    />
                    <IconButton
                      label={t("kernel.needs.remove", { name: `${name}.${action}` })}
                      className="size-7 hover:text-rose"
                      onClick={() => {
                        const { [action]: _gone, ...rest } = actions;
                        connect({ ...connections, [name]: rest });
                      }}
                    >
                      <X className="size-3.5" />
                    </IconButton>
                  </div>
                ))}
                <Add
                  example={t("kernel.connections.actionExample")}
                  valid={(action) => action.length > 0 && !(action in actions)}
                  onAdd={(action) =>
                    connect({ ...connections, [name]: { ...actions, [action]: "ask" } })
                  }
                />
              </div>
            </div>
          ))}
          <Add
            example={t("kernel.connections.nameExample")}
            valid={(name) => name.length > 0 && !(name in connections)}
            onAdd={(name) => connect({ ...connections, [name]: {} })}
          />
        </div>
      </div>
    </>
  );
}
