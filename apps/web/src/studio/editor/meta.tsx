import type { Step } from "@engenty/wizards-shared/definition";
import {
  AppWindow,
  Bot,
  Clapperboard,
  Eye,
  FileText,
  Flag,
  Hourglass,
  Image,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  Video,
  Wand2,
} from "lucide-react";
import { lang, t } from "../../lib/i18n";

export function stepIcon(step: Step) {
  switch (step.type) {
    case "page":
      return ListChecks;
    case "agent":
      return Bot;
    case "generate":
      return step.asset === "image"
        ? Image
        : step.asset === "video"
          ? Video
          : step.asset === "dashboard"
            ? LayoutDashboard
            : FileText;
    case "widget":
      return AppWindow;
    case "surface":
      return LayoutTemplate;
    case "motion-graphics":
      return Clapperboard;
    case "review":
      return Eye;
    case "wait":
      return Hourglass;
    case "result":
      return Flag;
  }
  return Wand2;
}

export const TYPE_TONE: Record<Step["type"], string> = {
  page: "bg-cobalt-tint text-cobalt",
  agent: "bg-ember-tint text-ember-strong",
  generate: "bg-amber-tint text-ink-2",
  widget: "bg-ember-veil text-ember-strong",
  surface: "bg-ember-veil text-ember-strong",
  "motion-graphics": "bg-amber-tint text-ink-2",
  review: "bg-moss-tint text-moss",
  wait: "bg-cobalt-tint text-cobalt",
  result: "bg-paper-2 text-ink-2",
};

const WAIT_UNIT = { m: "wait.minutes", h: "wait.hours", d: "wait.days" } as const;

/** "3 Tage", or what a wait waits until: a date as the person reads it, a template as written. */
export function waitSummary(step: Extract<Step, { type: "wait" }>): string {
  const lasts = /^(\d+)([mhd])$/.exec(step.for ?? "");
  if (lasts) {
    return lasts[0] === "1d"
      ? t("wait.day")
      : t(WAIT_UNIT[lasts[2] as keyof typeof WAIT_UNIT], { n: lasts[1] });
  }
  const date = Date.parse(step.until ?? "");
  const until = Number.isNaN(date)
    ? (step.until ?? "")
    : new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(date);
  return t("wait.until", { date: until });
}

export function typeLabel(step: Step): string {
  return t(`type.${step.type}` as "type.page");
}

const TOOLS = ["web_search", "web_fetch", "browser", "sandbox", "image", "http", "pages", "code"];

export function toolLabel(id: string) {
  return TOOLS.includes(id) ? t(`tool.${id}` as "tool.http") : id;
}

/** One line under a node's title: what the step asks or does. */
export function stepSummary(step: Step): string {
  switch (step.type) {
    case "page":
      return step.fields.map((f) => f.label).join(" · ");
    case "agent": {
      return step.tools.map(toolLabel).join(" · ") || step.instructions.slice(0, 90);
    }
    case "generate": {
      const parts: string[] = [step.asset];
      if (step.options?.aspectRatio) {
        parts.push(step.options.aspectRatio);
      }
      if (step.options?.duration) {
        parts.push(`${step.options.duration}s`);
      }
      if (step.options?.resolution) {
        parts.push(step.options.resolution);
      }
      if (step.options?.template) {
        parts.push(step.options.template);
      }
      return parts.join(" · ");
    }
    case "widget":
      return [step.entry, Object.keys(step.data).join(", ")].filter(Boolean).join(" · ");
    case "surface":
      return step.candidates
        ? step.candidates.map((c) => c.id).join(" · ")
        : Object.keys(step.data).join(", ");
    case "motion-graphics":
      return [step.format, step.seconds ? `${step.seconds}s` : null, step.skills.join(", ")]
        .filter(Boolean)
        .join(" · ");
    case "review":
      return [
        step.edit ? t("editor.reviewEditable") : null,
        step.regenerate ? t("editor.reviewRedo") : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "wait":
      return waitSummary(step);
    case "result":
      return step.deliverables
        .map((d) => `${d.label ?? d.from} (${d.formats.join(", ")})`)
        .join(" · ");
  }
  return "";
}
