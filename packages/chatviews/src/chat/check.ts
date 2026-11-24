// SPDX-License-Identifier: MIT
import { createParser, type ElementNode, type ParseResult } from "@openuidev/lang-core";
import { chatLibrarySpec } from "./library.js";

/** The most a view's program may weigh. */
export const VIEW_MAX_BYTES = 64 * 1024;

/** The props that name a file: the space's own only, never an address on the web. */
const FILE_PROPS: Record<string, string[]> = {
  Row: ["image"],
  Card: ["image"],
  Image: ["src"],
  File: ["file"],
};

const isElement = (v: unknown): v is ElementNode =>
  Boolean(v && typeof v === "object" && (v as { type?: unknown }).type === "element");

/** Every element of a tree, the root first. */
function elements(node: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (v: unknown) => {
    if (isElement(v)) {
      out.push(v);
      Object.values(v.props).forEach(walk);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(node);
  return out;
}

/** An action a button holds, as the parser leaves it: a ToAssistant step somewhere inside. */
function asksTheAssistant(v: unknown): boolean {
  const seen = JSON.stringify(v ?? null);
  return seen.includes('"ToAssistant"') || seen.includes('"continue_conversation"');
}

export interface ViewCheck {
  /** What is wrong, worded for the model that wrote it; empty when the view may be shown. */
  issues: string[];
  /** Whether the view waits for the person: a Form, or a button that asks the assistant. */
  asks: boolean;
  /** The parsed program, for a host that walks it (the A2UI adapter). */
  parsed: ParseResult | null;
}

const parser = () => createParser(chatLibrarySpec.toJSONSchema(), chatLibrarySpec.root);

/**
 * Whether a program a model wrote may be shown in a chat, checked before it is stored: OpenUI's
 * parser forgives (it drops and defaults what it can't read), so whatever it would drop is an
 * issue here, and what is shown later is what was checked. No `Query` or `Mutation` (they would
 * run tools from the device without the home's approval), files of the space only.
 */
export function checkView(program: string): ViewCheck {
  const issues: string[] = [];
  const bytes = new TextEncoder().encode(program).length;
  if (bytes > VIEW_MAX_BYTES) {
    return {
      issues: [
        `The view is ${bytes} bytes, more than ${VIEW_MAX_BYTES}: show fewer rows or less text.`,
      ],
      asks: false,
      parsed: null,
    };
  }
  const parsed = parser().parse(program);
  const { meta } = parsed;
  if (!parsed.root) {
    issues.push("A view needs a root: `root = Column([...])`.");
  }
  if (meta.incomplete) {
    issues.push("The view ends in the middle of a statement.");
  }
  for (const error of meta.errors) {
    if (error.severity !== "warning") {
      issues.push(
        `${error.statementId ? `${error.statementId}: ` : ""}${error.message}${error.path ? ` (${error.component}${error.path})` : ""}`,
      );
    }
  }
  for (const name of meta.unresolved) {
    issues.push(`"${name}" is used but never defined.`);
  }
  for (const name of meta.orphaned) {
    issues.push(`"${name}" is defined but nothing shows it: put it into its parent's children.`);
  }
  if (parsed.queryStatements.length || parsed.mutationStatements.length) {
    issues.push("A view in a chat has no Query or Mutation: write what you found into it.");
  }
  if (Object.keys(parsed.stateDeclarations).length) {
    issues.push("A view in a chat has no $variables: a Field keeps what the person types.");
  }
  const all = parsed.root ? elements(parsed.root) : [];
  for (const node of all) {
    for (const prop of FILE_PROPS[node.typeName] ?? []) {
      const v = node.props[prop];
      if (typeof v === "string" && /^(https?:|data:|\/\/)/i.test(v.trim())) {
        issues.push(
          `${node.statementId ?? node.typeName}: ${prop} is a file of the space (its id), never an address on the web.`,
        );
      }
    }
  }
  const forms = all.filter((n) => n.typeName === "Form");
  if (forms.length > 1) {
    issues.push("A view holds at most one Form.");
  }
  const asks =
    forms.length > 0 ||
    all.some((n) => n.typeName === "Button" && asksTheAssistant(n.props.action));
  return { issues, asks, parsed };
}
