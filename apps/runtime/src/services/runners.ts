import type {
  PluginRunnerAddress,
  PluginRunnerProblem,
  PluginRunnerRequest,
} from "@engenty/wizards/plugin";
import { textLang, type WizardDefinition, wizardLang } from "@engenty-wizards/shared/definition";
import { note, type PublicWizard } from "@engenty-wizards/shared/run";
import {
  BUILT_IN_RUNNERS,
  CONVERSATION_RUNNERS,
  DEFAULT_RUNNER,
  DEFAULT_RUNNER_SETTINGS,
  type RunnerFit,
  type RunnerInfo,
  type RunnerSettings,
  runnerFit,
} from "@engenty-wizards/shared/runners";
import { env } from "../env.js";
import { conversationAccess, conversationAvailable } from "../models.js";
import { pluginsOf, type RegisteredRunner } from "../plugins/registry.js";
import { currentTenant } from "../tenants/tenant.js";
import { ServiceError } from "./errors.js";
import { shareUrl, type WizardRow } from "./wizards.js";

/**
 * The runners a wizard can run through: the built-in page and chat, and the ones the tenant's
 * plugins add. Which of them a wizard offers is set per wizard (`wizard.runners`): the one its
 * link opens, and the ones switched on beside it.
 */

/** The runners this tenant has, built-ins first. */
export async function runnersOf(tenantId = currentTenant()): Promise<RunnerInfo[]> {
  const plugins = await pluginsOf(tenantId);
  const talk = (await conversationAvailable())
    ? null
    : await conversationAccess()
        .then(() => null)
        .catch((err: Error) => err.message);
  // A plugin's runner says per tenant whether it is ready (a number connected, a key set).
  const ofPlugins = await Promise.all(
    plugins.flatMap((p) =>
      [...p.runners.values()].map(
        async (r): Promise<RunnerInfo> => ({
          ...r.info,
          ...problemOf(
            r.problem
              ? await Promise.resolve()
                  .then(() => r.problem?.() ?? null)
                  .catch((err: Error) => err.message || "The runner is not ready.")
              : null,
          ),
        }),
      ),
    ),
  );
  return [
    ...BUILT_IN_RUNNERS.map((r) =>
      CONVERSATION_RUNNERS.includes(r.id) ? { ...r, problem: talk } : r,
    ),
    ...ofPlugins,
  ];
}

/** A runner's answer to `problem`, as the studio lists it. */
function problemOf(
  answer: string | PluginRunnerProblem | null,
): Pick<RunnerInfo, "problem" | "problemKind" | "problemNote" | "problemPlan"> {
  if (!answer) {
    return { problem: null };
  }
  if (typeof answer === "string") {
    return { problem: answer, problemKind: "setup" };
  }
  return {
    problem: answer.text || "The runner is not ready.",
    problemKind: answer.kind ?? "setup",
    problemNote: answer.note ?? null,
    problemPlan: answer.kind === "plan" ? (answer.plan ?? null) : null,
  };
}

/**
 * How a wizard is offered, on the runners there are: a runner switched on that is gone (a
 * plugin the tenant lost) is left out, and the link opens the first one left.
 */
export function runnerSettingsOf(w: WizardRow, available: RunnerInfo[]): RunnerSettings {
  const ids = new Set(available.map((r) => r.id));
  const wanted = w.runners ?? DEFAULT_RUNNER_SETTINGS;
  const enabled = wanted.enabled.filter((id) => ids.has(id));
  if (!enabled.includes(DEFAULT_RUNNER) && ids.has(DEFAULT_RUNNER) && !enabled.length) {
    enabled.push(DEFAULT_RUNNER);
  }
  const fallback = enabled[0] ?? DEFAULT_RUNNER;
  return {
    default: enabled.includes(wanted.default) ? wanted.default : fallback,
    enabled,
  };
}

/** Checks what the owner wants to set, against the runners the tenant has. */
export async function checkRunnerSettings(settings: RunnerSettings): Promise<RunnerSettings> {
  const available = await runnersOf();
  const ids = new Set(available.map((r) => r.id));
  const unknown = settings.enabled.find((id) => !ids.has(id));
  if (unknown) {
    throw new ServiceError("invalid", note("unknownRunner", { unknown }));
  }
  const enabled = [...new Set(settings.enabled)];
  if (!enabled.length) {
    throw new ServiceError("invalid", note("leastOneRunnerStay"));
  }
  if (!enabled.includes(settings.default)) {
    throw new ServiceError("invalid", note("linkOpenRunnerTurned"));
  }
  return { default: settings.default, enabled };
}

/**
 * Where a person reaches the wizard through each channel that is on, by runner id: the number,
 * the keyword and the link, as the runner's plugin knows them. A runner that cannot say is left
 * out.
 */
async function addressesOf(
  w: WizardRow,
  enabled: string[],
): Promise<Map<string, PluginRunnerAddress>> {
  const wizard = { id: w.id, title: w.draft.title, token: w.shareToken };
  const runners = (await pluginsOf(currentTenant())).flatMap((p) => [...p.runners.values()]);
  const found = await Promise.all(
    runners
      .filter((r) => r.address && enabled.includes(r.info.id))
      .map(async (r) => {
        const address = await Promise.resolve()
          .then(() => r.address?.(wizard) ?? null)
          .catch(() => null);
        return address ? ([r.info.id, address] as const) : null;
      }),
  );
  return new Map(found.filter((entry) => entry !== null));
}

/** The runners with how each fits the draft and where it is reached, and how the wizard is offered. */
export async function wizardRunners(w: WizardRow): Promise<{
  runners: (RunnerInfo & { fit: RunnerFit; address: PluginRunnerAddress | null })[];
  settings: RunnerSettings;
}> {
  const available = await runnersOf();
  const settings = runnerSettingsOf(w, available);
  const addresses = await addressesOf(w, settings.enabled);
  return {
    runners: available.map((r) => ({
      ...r,
      fit: runnerFit(w.draft, r),
      address: addresses.get(r.id) ?? null,
    })),
    settings,
  };
}

/** The address a runner opens the wizard at: the link itself for the default, else its sub-path. */
export function runnerUrl(
  w: WizardRow,
  runner: RunnerInfo,
  settings: RunnerSettings,
): string | null {
  if (runner.kind !== "page") {
    return null;
  }
  if (runner.plugin && env.fromSource) {
    // From source Vite serves /w/*: a plugin's page is reached on this server's own address.
    return `${env.publicUrl}/api/public/wizards/${w.shareToken}/runners/${runner.id}`;
  }
  return runner.id === settings.default
    ? shareUrl(w.shareToken)
    : `${shareUrl(w.shareToken)}/${runner.id}`;
}

/** A plugin's page runner, where the tenant has it and the wizard switched it on. */
export async function pageRunnerOf(
  w: WizardRow,
  runnerId: string,
): Promise<RegisteredRunner | null> {
  for (const plugin of await pluginsOf(currentTenant())) {
    const found = plugin.runners.get(runnerId);
    if (found?.info.kind === "page" && found.page) {
      const settings = runnerSettingsOf(w, await runnersOf());
      return settings.enabled.includes(runnerId) ? found : null;
    }
  }
  return null;
}

/** Serves a plugin's page runner for a wizard; null where there is none to serve. */
export async function servePageRunner(
  w: WizardRow,
  def: WizardDefinition,
  runnerId: string,
  rest: string,
  request: Request,
): Promise<Response | null> {
  const runner = await pageRunnerOf(w, runnerId);
  if (!runner?.page) {
    return null;
  }
  const input: PluginRunnerRequest = {
    request,
    tenantId: currentTenant(),
    wizard: { id: w.id, token: w.shareToken, title: def.title },
    path: rest || "/",
    query: new URL(request.url).searchParams,
  };
  try {
    return await runner.page(input);
  } catch (err) {
    console.error(`[plugin ${runner.info.plugin}] runner ${runnerId}:`, err);
    return new Response("The plugin failed.", { status: 500 });
  }
}

/** What the wizard's public page offers: the runners switched on, the link's first. */
export async function publicRunners(
  w: WizardRow,
  def: WizardDefinition,
): Promise<PublicWizard["runners"]> {
  const available = await runnersOf();
  const settings = runnerSettingsOf(w, available);
  const lang = textLang(wizardLang(def));
  return settings.enabled
    .map((id) => available.find((r) => r.id === id))
    .filter((r): r is RunnerInfo => Boolean(r) && !r?.problem)
    .sort((a, b) => Number(b.id === settings.default) - Number(a.id === settings.default))
    .map((r) => ({
      id: r.id,
      label: r.label[lang],
      kind: r.kind,
      url: runnerUrl(w, r, settings),
    }));
}
