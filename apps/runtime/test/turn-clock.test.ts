import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnClock } from "../src/agents/turn-clock";

const facts = {
  way: "claude",
  wizardId: "w1",
  outcome: "ok" as const,
  changed: true,
  stepsBefore: 1,
  stepsAfter: 4,
};

describe("the clock of an architect turn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says where the time went, round by round", () => {
    const clock = new TurnClock();
    clock.runsOn("claude-x");
    vi.advanceTimersByTime(100);
    clock.reasoning();
    vi.advanceTimersByTime(50);
    clock.reasoning();
    vi.advanceTimersByTime(50);
    clock.toolCalled();
    vi.advanceTimersByTime(10);
    clock.toolCalled();
    vi.advanceTimersByTime(20);
    clock.toolDone();
    vi.advanceTimersByTime(30);
    clock.toolDone(2);
    vi.advanceTimersByTime(300);
    clock.output();
    vi.advanceTimersByTime(100);
    clock.toolCalled();
    vi.advanceTimersByTime(40);
    clock.toolDone(0);
    vi.advanceTimersByTime(200);
    clock.output();
    vi.advanceTimersByTime(60);
    expect(clock.line(facts)).toBe(
      "[timing] architect way=claude model=claude-x wizard=w1 outcome=ok changed=true steps=1>4 " +
        "ms=960 first=100 reasoning=100 rounds=2 fixRounds=1 calls=3 toolMs=100 answer=260 " +
        "each=200+60x2,400+40x1",
    );
  });

  it("counts reasoning a client hands over whole from when the client last spoke", () => {
    const clock = new TurnClock();
    vi.advanceTimersByTime(500);
    clock.output();
    vi.advanceTimersByTime(700);
    clock.reasoned();
    expect(clock.line(facts)).toContain(" first=500 reasoning=700 ");
  });

  it("takes a call with none in flight for a new round, for a client silent between calls", () => {
    const clock = new TurnClock();
    vi.advanceTimersByTime(100);
    clock.toolCalled();
    vi.advanceTimersByTime(10);
    clock.toolDone(1);
    vi.advanceTimersByTime(500);
    clock.toolCalled();
    vi.advanceTimersByTime(20);
    clock.toolDone(0);
    vi.advanceTimersByTime(30);
    expect(clock.line(facts)).toContain(
      " rounds=2 fixRounds=1 calls=2 toolMs=30 answer=30 each=100+10x1,500+20x1",
    );
  });

  it("keeps the round while a tool is in flight, as parallel calls are", () => {
    const clock = new TurnClock();
    clock.toolCalled();
    vi.advanceTimersByTime(10);
    clock.output();
    clock.toolCalled();
    vi.advanceTimersByTime(10);
    clock.toolDone();
    clock.toolDone();
    expect(clock.line(facts)).toContain(" rounds=1 fixRounds=0 calls=2 ");
  });

  it("says so when the model never spoke, and its numbers survive the log's redaction", async () => {
    const { redact } = await import("../src/log");
    const clock = new TurnClock();
    vi.advanceTimersByTime(1_234_567);
    const line = clock.line({ ...facts, outcome: "failed" });
    expect(line).toContain(" outcome=failed ");
    expect(line).toContain(" first=none ");
    expect(redact(line)).toBe(line);
    const long = new TurnClock();
    vi.advanceTimersByTime(1_234_567);
    long.output();
    const spoke = long.line(facts);
    expect(spoke).toContain(" first=1234567 ");
    expect(redact(spoke)).toBe(spoke);
  });
});
