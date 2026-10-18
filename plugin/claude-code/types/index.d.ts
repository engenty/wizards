export type WizardRow = {
  id: string;
  title: string;
  published: boolean;
  studioUrl?: string;
};

/** What the pane keeps of a wizard: its name, its engenty, its steps, its own page. */
export type WizardDetails = {
  title: string;
  description?: string;
  avatar?: string;
  steps: { id: string; type: string; title: string }[];
  /** The wizard's page behind its share link, where a person runs it. */
  shareUrl?: string;
};

/** The run report the runtime's MCP tools answer (runReport in apps/runtime/src/services/runs.ts). */
export type RunView = {
  runId: string;
  wizardId: string;
  mode: string;
  status: string;
  waitingFor?: unknown;
  browserUrl: string | null;
  studioUrl?: string;
};

declare module "claude-code" {
  interface PluginState {
    wizards: {
      wizards: WizardRow[];
      /** Kept under a shape tag: a newer module reading another tag starts afresh. */
      details: { shape: string; value: Record<string, WizardDetails> };
      message: string | null;
      /** The run whose page the browser pane was opened at, so a polled run opens once. */
      shown: string | null;
      /** The runtime's origin, read off its links: where the pane is connected. */
      runtime: string | null;
      /** A page the browser pane refused to open, offered as a plain link instead. */
      fallback: string | null;
    };
  }
}
