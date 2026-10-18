import {
  FORMATS,
  type Format,
  LIST_FORMATS,
  listRef,
  type ResultStep,
  type WizardDefinition,
} from "@engenty-wizards/shared/definition";
import type { RunState } from "@engenty-wizards/shared/run";
import type { ShareItem } from "@engenty-wizards/shared/sharing";
import type { RunRow } from "../engine/types.js";
import { type Download, listDownload, renderDownload } from "../render/downloads.js";
import { listRows, type StoreScope, scopeOf } from "../store/index.js";
import { line, ShareError, type ShareFile } from "./types.js";

/** The result step a finished run stands on. */
export function resultStepOf(run: RunRow): ResultStep | null {
  const steps = run.definition.steps;
  const step =
    steps.find((s) => s.id === run.cursor && s.type === "result") ??
    steps.findLast((s) => s.type === "result");
  return step?.type === "result" ? step : null;
}

/** One output of a run as a file: a step's output or a stored list, in one format. */
export async function resultFile(
  source: { def: WizardDefinition; state: RunState; store: StoreScope },
  from: string,
  format: Format,
): Promise<{ download: Download; label: string } | null> {
  const { def, state, store } = source;
  const deliverable = def.steps
    .flatMap((s) => (s.type === "result" ? s.deliverables : []))
    .find((d) => d.from === from);
  const list = listRef(from);
  if (list) {
    const listDef = def.lists?.find((l) => l.id === list);
    if (!listDef || !LIST_FORMATS.includes(format)) {
      return null;
    }
    const label = deliverable?.label ?? listDef.title;
    const download = await listDownload(
      listDef,
      await listRows(store, listDef),
      format,
      `${def.title} ${label}`,
    );
    return download ? { download, label } : null;
  }
  const step = def.steps.find((s) => s.id === from);
  const output = step ? state.outputs[step.id] : undefined;
  if (!step || !output) {
    return null;
  }
  const label = deliverable?.label ?? step.title;
  const download = await renderDownload(step, output, format, `${def.title} ${label}`);
  return download ? { download, label } : null;
}

const RESULT_REF = /^result:(.+)\.([a-z0-9]+)$/;

/** `result:<step>.<format>` — how an agent names an output of the run in a tool call. */
export function parseResultRef(ref: string): ShareItem | null {
  const m = ref.match(RESULT_REF);
  const format = m ? (FORMATS as readonly string[]).find((f) => f === m[2]) : undefined;
  return m && format ? { from: m[1], format: format as Format } : null;
}

function bytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/**
 * The files the person picked, rendered. Only what the result offers as a download can be sent:
 * a deliverable, in one of its formats.
 */
export async function shareFiles(run: RunRow, items: ShareItem[]): Promise<ShareFile[]> {
  const result = resultStepOf(run);
  const source = { def: run.definition, state: run.state, store: scopeOf(run) };
  const files: ShareFile[] = [];
  const names = new Set<string>();
  for (const item of items) {
    const offered = result?.deliverables.find(
      (d) => d.from === item.from && d.formats.includes(item.format),
    );
    if (!offered) {
      throw new ShareError(line("shareNotInResult", { name: item.from, format: item.format }));
    }
    const found = await resultFile(source, item.from, item.format).catch(() => null);
    if (!found) {
      throw new ShareError(
        line("shareCannotRender", {
          name: offered.label ?? item.from,
          format: item.format.toUpperCase(),
        }),
      );
    }
    let name = found.download.filename;
    for (let n = 2; names.has(name); n++) {
      name = found.download.filename.replace(/(\.[^.]+)?$/, (ext) => `-${n}${ext}`);
    }
    names.add(name);
    files.push({
      name,
      mime: found.download.mime,
      data: bytes(found.download.data),
      label: found.label,
      ref: `result:${item.from}.${item.format}`,
    });
  }
  return files;
}

/** The first written deliverable of the result, as text. */
export function resultText(run: RunRow): string | null {
  for (const d of resultStepOf(run)?.deliverables ?? []) {
    const step = run.definition.steps.find((s) => s.id === d.from);
    const text = run.state.outputs[d.from]?.text?.trim();
    if (step?.type === "agent" && step.output.format !== "json" && text) {
      return text;
    }
  }
  return null;
}

/** What the result holds, for an agent that is to publish it: every deliverable, texts in full. */
export function resultBrief(run: RunRow): string {
  const lines: string[] = [];
  for (const d of resultStepOf(run)?.deliverables ?? []) {
    const step = run.definition.steps.find((s) => s.id === d.from);
    const output = run.state.outputs[d.from];
    if (!step || !output) {
      continue;
    }
    const title = d.label ?? step.title;
    if (step.type === "agent" && step.output.format === "json") {
      lines.push(`## ${title} (data)\n${JSON.stringify(output.json, null, 2).slice(0, 6000)}`);
    } else if (step.type === "agent") {
      lines.push(`## ${title} (text)\n${(output.text ?? "").slice(0, 12_000)}`);
    } else if (step.type === "generate") {
      lines.push(`## ${title} (${step.asset})`);
    } else {
      lines.push(`## ${title}`);
    }
  }
  return lines.join("\n\n") || "(nothing)";
}

export function megabytes(n: number): string {
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}
