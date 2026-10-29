import { widgetSize } from "@engenty/wizards-shared/definition";
import { probeWidget } from "../widgets/render.js";
import { widgetPreviewHtml } from "../widgets/step.js";
import { notFound, ServiceError } from "./errors.js";
import { draftFiles } from "./files.js";
import { ownedSpace } from "./spaces.js";
import { ownedWizard } from "./wizards.js";

async function draftWidget(userId: string, wizardId: string, stepId: string) {
  const w = await ownedWizard(userId, wizardId);
  const step = w.draft.steps.find((s) => s.id === stepId);
  if (!step) {
    throw notFound();
  }
  if (step.type !== "widget") {
    throw new ServiceError("invalid", `Step "${stepId}" is not a widget.`);
  }
  const files = await draftFiles(w.id);
  if (!files.some((f) => f.path === step.entry)) {
    throw new ServiceError("invalid", `The widget file ${step.entry} is not in the workspace yet.`);
  }
  return { step, files, space: await ownedSpace(userId, w.spaceId) };
}

/** The draft widget with its sample data, as one HTML file — the studio shows it before any run. */
export async function draftWidgetPreview(
  userId: string,
  wizardId: string,
  stepId: string,
  data?: unknown,
) {
  const { step, files, space } = await draftWidget(userId, wizardId, stepId);
  return widgetPreviewHtml(step, files, space, data);
}

/** Loads the draft widget in Chromium: what broke, whether it animates, and how it looks. */
export async function checkDraftWidget(
  userId: string,
  wizardId: string,
  stepId: string,
  data?: unknown,
) {
  const { step, files, space } = await draftWidget(userId, wizardId, stepId);
  const html = await widgetPreviewHtml(step, files, space, data);
  const probe = await probeWidget(html, widgetSize(step));
  return { ...probe, size: widgetSize(step), bytes: Buffer.byteLength(html) };
}
