import { providerInfo } from "@engenty/wizards-shared/providers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Server, ToggleRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { type Key, t } from "../lib/i18n";
import type { Me } from "../lib/session";
import { Button, Chip, Empty, Spinner, Switch } from "../ui";
import { ModelTest } from "./Harness";
import { Section } from "./project/Section";
import { MenuRow, SubMenu, useDetail, useSettingsMenu } from "./settings-menu";

/** What `/api/studio/runtime` says of this runtime. */
interface RuntimeInfo {
  version: string;
  kind: "script" | "checkout" | "npm" | "cloud";
  role: string;
  publicUrl: string;
  dataDir: string;
  database: "server" | "file";
  files: "bucket" | "folder";
  featuresFile: string;
  restarts: boolean;
  models: { source: string; keys: string[]; ollamaUrl: string } | null;
  plugins: string[];
}

type FeatureSource = "default" | "env" | "remote" | "file";

interface FeatureRow {
  name: string;
  on: boolean;
  source: FeatureSource;
  kind: "release" | "plan" | null;
  label: string | null;
  hint: string | null;
  without: boolean;
}

/** Settings › Setup and its Features: on this computer, or for the platform's admins. */
export const runtimeSettingsOn = (me: Me | null | undefined) => me?.runtimeSettings === true;

function useRuntime() {
  return useQuery({
    queryKey: ["runtime"],
    queryFn: () => api.get<RuntimeInfo>("/api/studio/runtime"),
  });
}

/** One line of what the server says of itself: what, then its value. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-0.5 py-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <dt className="text-[0.875rem] text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-[0.875rem] text-ink">{children}</dd>
    </div>
  );
}

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-[0.8125rem]">{children}</span>
);

const KINDS: Record<RuntimeInfo["kind"], Key> = {
  script: "about.kind.script",
  checkout: "about.kind.checkout",
  npm: "about.kind.npm",
  cloud: "about.kind.cloud",
};

/** What a runtime that runs alone thinks with: the source of Settings › Models, in words. */
function sourceName(source: string, me: Me): string {
  if (source === "account") {
    return t("models.creditsName");
  }
  if (source === "own") {
    return t("local.sourceOwn");
  }
  return me.harnesses.find((h) => h.id === source)?.name ?? source;
}

/**
 * Starts the server again and reloads the page once it answers. Offered where the command
 * that started it starts it again (`wizards start`).
 */
function RestartButton() {
  const [state, setState] = useState<"idle" | "restarting" | "failed">("idle");
  const restart = async () => {
    setState("restarting");
    const { restarting } = await api
      .post<{ restarting: boolean }>("/api/studio/runtime/restart", {})
      .catch(() => ({ restarting: false }));
    if (!restarting) {
      setState("failed");
      return;
    }
    // The old process answers for a moment longer: wait until it went, then for the new one.
    await new Promise((r) => setTimeout(r, 2000));
    for (let i = 0; i < 60; i++) {
      const up = await fetch("/api/config", { cache: "no-store" })
        .then((r) => r.ok)
        .catch(() => false);
      if (up) {
        window.location.reload();
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    setState("failed");
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" busy={state === "restarting"} onClick={restart}>
        <RotateCw className="size-4" /> {t("runtime.restart")}
      </Button>
      {state === "restarting" ? (
        <span className="text-[0.875rem] text-ink-3">{t("runtime.restarting")}</span>
      ) : null}
      {state === "failed" ? (
        <span className="text-[0.875rem] text-rose">{t("runtime.restartFailed")}</span>
      ) : null}
    </div>
  );
}

/**
 * Settings › Setup: what holds for the whole server, not for a space or a person. Its menu one
 * level down: the overview, and Features (`?show=features`).
 */
export function RuntimeSetup({ me }: { me: Me }) {
  const [params, setParams] = useSearchParams();
  const { narrow } = useSettingsMenu();
  const show = params.get("show") === "features" ? "features" : "general";
  useDetail(params.get("show") || !narrow ? t(PARTS[show]) : null);
  const open = (next: keyof typeof PARTS) => setParams({ show: next }, { replace: !narrow });
  return (
    <>
      <SubMenu>
        <ul className="flex flex-col gap-0.5">
          <MenuRow
            icon={Server}
            label={t(PARTS.general)}
            selected={show === "general" && Boolean(params.get("show") || !narrow)}
            onPick={() => open("general")}
          />
          <MenuRow
            icon={ToggleRight}
            label={t(PARTS.features)}
            selected={show === "features"}
            onPick={() => open("features")}
          />
        </ul>
      </SubMenu>
      {show === "features" ? <FeatureSwitches me={me} /> : <SetupOverview me={me} />}
    </>
  );
}

const PARTS = {
  general: "runtime.general",
  features: "runtime.featuresNav",
} as const satisfies Record<string, Key>;

/** What the server says of itself, what it works with, and its restart. */
function SetupOverview({ me }: { me: Me }) {
  const navigate = useNavigate();
  const runtime = useRuntime();
  const r = runtime.data;
  if (!r) {
    return runtime.isLoading ? <Spinner className="size-5 text-ink-3" /> : null;
  }
  return (
    <div className="flex flex-col gap-9">
      {r.models ? (
        <Section title={t("runtime.models")} hint={t("runtime.modelsHint")}>
          <dl className="-my-2 divide-y divide-border-soft">
            <Row label={t("runtime.source")}>{sourceName(r.models.source, me)}</Row>
            <Row label={t("runtime.keys")}>
              {r.models.keys.length
                ? r.models.keys.map((k) => providerInfo(k)?.name ?? k).join(", ")
                : t("runtime.noKeys")}
            </Row>
          </dl>
          <div className="mt-5 flex flex-col gap-5">
            <ModelTest />
            <div className="flex flex-wrap gap-3">
              <Button variant="secondary" onClick={() => navigate("/settings/models")}>
                {t("runtime.openModels")}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/setup")}>
                {t("runtime.openSetup")}
              </Button>
            </div>
          </div>
        </Section>
      ) : null}
      <Section title={t("runtime.server")} hint={t("runtime.serverHint")}>
        <dl className="-my-2 divide-y divide-border-soft">
          <Row label={t("runtime.version")}>
            {r.version} · {t(KINDS[r.kind])}
          </Row>
          <Row label={t("runtime.role")}>
            <Mono>{r.role}</Mono>
          </Row>
          <Row label={t("runtime.address")}>
            <Mono>{r.publicUrl}</Mono>
          </Row>
          <Row label={t("runtime.dataDir")}>
            <Mono>{r.dataDir}</Mono>
          </Row>
          <Row label={t("runtime.database")}>
            {r.database === "server" ? t("runtime.databaseServer") : t("runtime.databaseFile")}
          </Row>
          <Row label={t("runtime.files")}>
            {r.files === "bucket" ? t("runtime.filesBucket") : t("runtime.filesFolder")}
          </Row>
          <Row label={t("runtime.plugins")}>
            {r.plugins.length ? r.plugins.join(", ") : t("runtime.noPlugins")}
          </Row>
          <Row label={t("runtime.featuresFile")}>
            <Mono>{r.featuresFile}</Mono>
          </Row>
        </dl>
      </Section>
      {r.restarts ? (
        <Section title={t("runtime.restartTitle")} hint={t("runtime.restartHint")}>
          <RestartButton />
        </Section>
      ) : null}
    </div>
  );
}

const SOURCES: Record<FeatureSource, Key> = {
  default: "runtime.fromDefault",
  env: "runtime.fromEnv",
  remote: "runtime.fromRemote",
  file: "runtime.fromFile",
};

/**
 * Settings › Setup › Features: every switch the code and the plugins declare, and what this
 * server's `.features` file makes of them. The file is read on every request, so a change holds
 * at once; only what a plugin reads once when it loads waits for a restart.
 */
function FeatureSwitches({ me }: { me: Me }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["runtime", "features"],
    queryFn: () =>
      api.get<{ file: string; restarts: boolean; features: FeatureRow[] }>(
        "/api/studio/runtime/features",
      ),
  });
  const set = useMutation({
    mutationFn: ({ name, on }: { name: string; on: boolean | null }) =>
      api.put(`/api/studio/runtime/features/${encodeURIComponent(name)}`, { on }),
    // The studio reads the switches from `me` and the config: they change with the list.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["runtime", "features"] }),
        qc.invalidateQueries({ queryKey: ["me"] }),
        qc.invalidateQueries({ queryKey: ["config"] }),
      ]),
  });
  const data = list.data;
  if (!data) {
    return list.isLoading ? <Spinner className="size-5 text-ink-3" /> : null;
  }
  const remote = me.mode === "managed" ? t("runtime.fromOrganization") : t(SOURCES.remote);
  return (
    <div className="flex flex-col gap-9">
      <Section
        title={t("runtime.featuresTitle")}
        hint={t(me.mode === "managed" ? "runtime.featuresHintCloud" : "runtime.featuresHint", {
          file: data.file,
        })}
      >
        {data.features.length ? (
          <ul className="-my-2 divide-y divide-border-soft">
            {data.features.map((f) => {
              const pending = set.isPending && set.variables?.name === f.name;
              return (
                <li key={f.name} className="flex items-start gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-medium text-[0.9375rem] text-ink">
                        {f.label ?? f.name}
                      </span>
                      <Chip>{f.source === "remote" ? remote : t(SOURCES[f.source])}</Chip>
                      {f.kind === "plan" ? <Chip>{t("runtime.kindPlan")}</Chip> : null}
                    </div>
                    <p className="mt-0.5 font-mono text-[0.75rem] text-ink-4">{f.name}</p>
                    {f.hint ? (
                      <p className="mt-1 text-[0.875rem] text-ink-3 leading-snug">{f.hint}</p>
                    ) : null}
                    {f.source === "file" ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => set.mutate({ name: f.name, on: null })}
                        className="mt-1 text-[0.8125rem] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                      >
                        {t("runtime.followDefault", {
                          state: f.without ? t("runtime.on") : t("runtime.off"),
                        })}
                      </button>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pt-0.5">
                    {pending ? <Spinner className="size-4 text-ink-3" /> : null}
                    <Switch
                      checked={f.on}
                      label={f.label ?? f.name}
                      disabled={pending}
                      onChange={(on) => set.mutate({ name: f.name, on })}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>{t("runtime.noFeatures")}</Empty>
        )}
        {set.error ? (
          <p className="mt-4 text-[0.875rem] text-rose">{t("runtime.featureFailed")}</p>
        ) : null}
        <div className="mt-4 flex flex-col gap-3 border-border-soft border-t pt-4">
          <p className="text-[0.875rem] text-ink-3 leading-snug">
            {t(data.restarts ? "runtime.featuresRestart" : "runtime.featuresRestartBySelf")}
          </p>
          {data.restarts ? <RestartButton /> : null}
        </div>
      </Section>
    </div>
  );
}
