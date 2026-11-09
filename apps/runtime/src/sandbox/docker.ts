import { execFileSync } from "node:child_process";
import { env } from "../env.js";
import { feature } from "../features.js";
import { onDemand } from "../on-demand.js";
import { dockerEgress } from "./docker-egress.js";
import { MastraRunSandbox } from "./mastra.js";
import type {
  RunHosts,
  Sandbox,
  SandboxCapabilities,
  SandboxEgress,
  SandboxEngine,
} from "./types.js";

/** The image's own working directory, the one its unprivileged user may write to. */
const WORKDIR = "/sandbox";

/**
 * What the engenty-sandbox image carries. The container sits on Docker's default bridge, or on
 * the sandbox network with the `dockerEgress` switch on.
 */
export const DOCKER_CAPABILITIES: SandboxCapabilities = {
  commands: ["bash", "python3", "pip", "uv", "node", "npm", "bun", "jq", "curl", "git", "unzip"],
  network: "open internet",
  uses: "calculations, charts or file conversion",
  workdir: WORKDIR,
};

/**
 * What a run's container reaches with the `dockerEgress` switch on (docker-egress.ts): only
 * what the broker lets through, the package registries always.
 */
export function dockerCapabilities(run?: RunHosts): SandboxCapabilities {
  if (!run || !feature("dockerEgress")) {
    return DOCKER_CAPABILITIES;
  }
  let network = "the public internet, not this computer's own networks";
  if (!run.everyPublicHost) {
    network = run.hosts.length
      ? `only the npm and PyPI registries and ${run.hosts.join(", ")}`
      : "none, except the npm and PyPI registries";
  }
  return { ...DOCKER_CAPABILITIES, network };
}

/**
 * One container per run through the host's Docker, with Mastra's Docker sandbox. With a run's
 * egress and the `dockerEgress` switch on it reaches outside only through the broker.
 */
export function dockerSandbox(runId: string, image: string, egress?: SandboxEgress): Sandbox {
  let release: () => void = () => undefined;
  return new MastraRunSandbox(
    DOCKER_CAPABILITIES,
    async () => {
      release();
      const way = egress && feature("dockerEgress") ? await dockerEgress(image, egress) : null;
      release = way?.release ?? (() => undefined);
      const { DockerSandbox } = await onDemand<typeof import("@mastra/docker")>("@mastra/docker");
      return new DockerSandbox({
        id: `wizards-${runId.toLowerCase()}`,
        image,
        memory: 1024 * 1024 * 1024,
        pidsLimit: 256,
        capDrop: ["ALL"],
        securityOpt: ["no-new-privileges"],
        workingDir: WORKDIR,
        labels: { "engenty-wizards.run": runId },
        ...(way ? { network: way.network, env: way.env } : {}),
      });
    },
    () => release(),
  );
}

export function dockerHasImage(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ready where Docker has the sandbox image (`SANDBOX_IMAGE`). The image is not published, so
 * without the check a fresh install would offer a tool that cannot start.
 */
export const dockerEngine: SandboxEngine = {
  name: "docker",
  ready: () => dockerHasImage(env.sandboxImage),
  capabilities: dockerCapabilities,
  create: (runId, egress) => dockerSandbox(runId, env.sandboxImage, egress),
};
