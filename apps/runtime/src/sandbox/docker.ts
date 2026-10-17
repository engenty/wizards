import { execFileSync } from "node:child_process";
import { DockerSandbox } from "@mastra/docker";
import { env } from "../env.js";
import { MastraRunSandbox } from "./mastra.js";
import type { Sandbox, SandboxCapabilities, SandboxEngine } from "./types.js";

/** The image's own working directory, the one its unprivileged user may write to. */
const WORKDIR = "/sandbox";

/** What the engenty-sandbox image carries. The container sits on Docker's default bridge. */
export const DOCKER_CAPABILITIES: SandboxCapabilities = {
  commands: ["bash", "python3", "pip", "uv", "node", "npm", "bun", "jq", "curl", "git", "unzip"],
  network: "open internet",
  uses: "calculations, charts or file conversion",
  workdir: WORKDIR,
};

/** One container per run through the host's Docker, with Mastra's Docker sandbox. */
export function dockerSandbox(runId: string, image: string): Sandbox {
  return new MastraRunSandbox(
    DOCKER_CAPABILITIES,
    () =>
      new DockerSandbox({
        id: `wizards-${runId.toLowerCase()}`,
        image,
        memory: 1024 * 1024 * 1024,
        pidsLimit: 256,
        capDrop: ["ALL"],
        securityOpt: ["no-new-privileges"],
        workingDir: WORKDIR,
        labels: { "engenty-wizards.run": runId },
      }),
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
  capabilities: () => DOCKER_CAPABILITIES,
  create: (runId) => dockerSandbox(runId, env.sandboxImage),
};
