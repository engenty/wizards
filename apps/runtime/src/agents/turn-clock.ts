/** One model answer and the tools it called. */
interface Round {
  model: number;
  tools: number;
  calls: number;
}

/**
 * Where one architect turn's time went, for a line in the log ring (`debug_logs`, `wizards logs`).
 * It holds timings and counts only: no prompt, no answer, no tool's arguments or results.
 *
 * A round runs from the end of the last tools to the end of its own. A fix round is one that
 * begins while the draft has issues, as the last tool that spoke of them said.
 */
export class TurnClock {
  private readonly started = Date.now();
  private last = this.started;
  private first: number | null = null;
  private reasoningMs = 0;
  private reasoningFrom: number | null = null;
  private roundFrom = this.started;
  private toolsFrom: number | null = null;
  private toolsUntil = this.started;
  private calls = 0;
  private pending = 0;
  private readonly rounds: Round[] = [];
  private fixRounds = 0;
  private issues = false;
  private answerMs: number | null = null;
  private model = "default";

  /** The model the turn runs on, by the name it was asked for. */
  runsOn(model: string | undefined) {
    this.model = model || "default";
  }

  private tick() {
    this.last = Date.now();
    this.first ??= this.last - this.started;
    return this.last;
  }

  private stopReasoning(now: number) {
    if (this.reasoningFrom !== null) {
      this.reasoningMs += now - this.reasoningFrom;
      this.reasoningFrom = null;
    }
  }

  private closeRound() {
    if (this.toolsFrom === null) {
      return;
    }
    this.rounds.push({
      model: this.toolsFrom - this.roundFrom,
      tools: this.toolsUntil - this.toolsFrom,
      calls: this.calls,
    });
    this.roundFrom = this.toolsUntil;
    this.toolsFrom = null;
    this.calls = 0;
    this.pending = 0;
  }

  /** The model writes something other than reasoning. Its tools in flight keep their round. */
  output() {
    this.stopReasoning(this.tick());
    if (this.pending === 0) {
      this.closeRound();
    }
  }

  /** A piece of reasoning, as it streams. */
  reasoning() {
    const now = this.tick();
    this.reasoningFrom ??= now;
    if (this.pending === 0) {
      this.closeRound();
    }
  }

  /** Reasoning a client hands over whole, once it is done: it took since the client last spoke. */
  reasoned() {
    const before = this.last;
    this.reasoningMs += this.tick() - before;
    if (this.pending === 0) {
      this.closeRound();
    }
  }

  /** The model has called a tool. */
  toolCalled() {
    const now = this.tick();
    this.stopReasoning(now);
    // A client that says nothing between its calls: with none in flight, this is a new round.
    if (this.pending === 0) {
      this.closeRound();
    }
    if (this.toolsFrom === null) {
      this.toolsFrom = now;
      this.toolsUntil = now;
      if (this.issues) {
        this.fixRounds += 1;
      }
    }
    this.calls += 1;
    this.pending += 1;
  }

  /** A tool has answered; `issues` is how many it found in the draft, if it spoke of them. */
  toolDone(issues?: number) {
    this.toolsUntil = this.tick();
    this.pending = Math.max(0, this.pending - 1);
    if (issues !== undefined) {
      this.issues = issues > 0;
    }
  }

  /** The model has finished; what the turn still does after this is not the model's time. */
  modelDone() {
    if (this.answerMs !== null) {
      return;
    }
    const now = Date.now();
    this.stopReasoning(now);
    this.closeRound();
    this.answerMs = now - this.roundFrom;
  }

  /** The line for the log. */
  line(facts: {
    way: string;
    wizardId: string;
    outcome: "ok" | "failed" | "stopped";
    changed: boolean;
    stepsBefore: number;
    stepsAfter: number;
  }): string {
    this.modelDone();
    const each = this.rounds.map((r) => `${r.model}+${r.tools}x${r.calls}`).join(",");
    return [
      "[timing] architect",
      `way=${facts.way}`,
      `model=${this.model}`,
      `wizard=${facts.wizardId}`,
      `outcome=${facts.outcome}`,
      `changed=${facts.changed}`,
      `steps=${facts.stepsBefore}>${facts.stepsAfter}`,
      `ms=${Date.now() - this.started}`,
      `first=${this.first ?? "none"}`,
      `reasoning=${this.reasoningMs}`,
      `rounds=${this.rounds.length}`,
      `fixRounds=${this.fixRounds}`,
      `calls=${this.rounds.reduce((n, r) => n + r.calls, 0)}`,
      `toolMs=${this.rounds.reduce((n, r) => n + r.tools, 0)}`,
      `answer=${this.answerMs}`,
      // Per round: the model's ms + the tools' ms x how many calls.
      ...(each ? [`each=${each}`] : []),
    ].join(" ");
  }
}
