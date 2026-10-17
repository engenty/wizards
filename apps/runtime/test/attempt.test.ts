import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors.js";
import { attempt } from "../src/tools/shared.js";

describe("attempt", () => {
  it("hands on what the tool returned", async () => {
    expect(await attempt(async () => ({ ok: 1 }))).toEqual({ ok: 1 });
  });

  it("turns a failure into an error the model reads, clipped to 400 characters", async () => {
    const out = await attempt(async () => {
      throw new Error("x".repeat(1000));
    });
    expect(out).toEqual({ error: "x".repeat(400) });
  });

  it("keeps the whole message where asked", async () => {
    const out = await attempt(
      async () => {
        throw new Error("x".repeat(1000));
      },
      { limit: Number.POSITIVE_INFINITY },
    );
    expect((out as { error: string }).error).toHaveLength(1000);
  });

  it("brings a service's data along", async () => {
    const out = await attempt(async () => {
      throw new ServiceError("invalid", "The wizard doesn’t match the schema.", {
        issues: [{ path: "steps.0" }],
      });
    });
    expect(out).toEqual({
      error: "The wizard doesn’t match the schema.",
      issues: [{ path: "steps.0" }],
    });
  });

  it("reads a thrown value that is no Error", async () => {
    expect(
      await attempt(async () => {
        throw "gone";
      }),
    ).toEqual({ error: "gone" });
  });
});
