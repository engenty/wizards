import type { Where, Who } from "../broker/call.js";
import { whereOf, whoOf } from "../broker/call.js";
import {
  AGENT,
  type Subject,
  subjectsOf,
  subjectsOfGoose,
  subjectsOfPerson,
} from "../broker/rwx.js";
import type { StepContext } from "../engine/types.js";
import type { Role } from "../manage.js";
import type { SkillSandbox } from "../tools/skills.js";

/**
 * Who calls the space's elements (docs/plans/modular.md): the caller every tool of the catalogue
 * is made for. It is fixed before a model sees a tool and never comes from a tool's arguments
 * (I1): a step's run, a person in a Work chat or an outside client, Goose for a person.
 */
export interface ElementCaller {
  space: { id: string; name: string };
  /** Who calls, as the broker's log names them. */
  who: Who;
  /** Whom the space's rules are asked for. */
  subjects: Subject[];
  /** The run, step or chat the call is made in. */
  where: Where;
  signal: AbortSignal;
  /** The outside client, as it names itself (an MCP client, `x-wizards-client`); none inside the runtime. */
  client?: string;
  /** Tells what a tool does: the run's events, Goose's line. */
  note?: (note: ElementNote) => Promise<void> | void;
  /** Where the scripts of skills that may run go; none: they stay text. */
  sandbox?: SkillSandbox | null;
}

/** What a tool says it does, as a run's event code with its params. */
export interface ElementNote {
  code: "searchesKnowledge" | "listsKnowledge" | "reads" | "readsSkill";
  params?: Record<string, string | number>;
}

/** A step of a run: its holder and its wizard, in the run. */
export function stepCaller(ctx: StepContext, sandbox: SkillSandbox | null = null): ElementCaller {
  return {
    // The run's data: a client space's Knowledge reaches through to its parent as the rules allow.
    space: ctx.dataSpace,
    who: whoOf(ctx.store.holder, ctx.holder.kind === "person" ? ctx.holder.role : undefined),
    subjects: subjectsOf(ctx),
    where: whereOf(ctx),
    signal: ctx.signal,
    note: (note) => ctx.emit("tool", note),
    sandbox,
  };
}

/** A signed-in person: in a Work chat, or through an outside client that signed in as them. */
export function personCaller(input: {
  space: { id: string; name: string };
  userId: string;
  role: Role;
  signal: AbortSignal;
  chatId?: string | null;
  client?: string;
  sandbox?: SkillSandbox | null;
}): ElementCaller {
  return {
    space: input.space,
    who: whoOf(`u:${input.userId}`, input.role),
    // An AI for the person: what the person may, and what the space lets agents do (Dateien).
    subjects: [...subjectsOfPerson(input.userId, input.role), AGENT],
    where: {
      spaceId: input.space.id,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.client ? { client: input.client } : {}),
    },
    signal: input.signal,
    client: input.client,
    sandbox: input.sandbox ?? null,
  };
}

/** Goose for a person: its own rules count, and the person's. */
export function gooseCaller(input: {
  space: { id: string; name: string };
  userId: string;
  role: Role;
  signal: AbortSignal;
  chatId?: string;
  note?: ElementCaller["note"];
}): ElementCaller {
  return {
    space: input.space,
    who: {
      kind: "goose",
      id: input.userId,
      admin: input.role === "owner" || input.role === "admin",
    },
    subjects: subjectsOfGoose(input.userId, input.role),
    where: { spaceId: input.space.id, ...(input.chatId ? { chatId: input.chatId } : {}) },
    signal: input.signal,
    note: input.note,
  };
}
