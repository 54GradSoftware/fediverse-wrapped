import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostLimiter, HostRateLimitedError } from "../src/limiter.ts";
import { classifyFetchError } from "../src/outbox.ts";

/** A limiter on a fake clock whose sleeps only move that clock forward. */
function fakeLimiter() {
  let clock = 1_000_000;
  const slept: number[] = [];
  const limiter = new HostLimiter({
    now: () => clock,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
      clock += milliseconds;
    },
  });
  return { limiter, slept };
}

describe("rate limit after a 429", () => {
  it("waits out a short Retry-After", async () => {
    const { limiter, slept } = fakeLimiter();
    limiter.penalise("busy.test", 5_000);
    await limiter.acquire("busy.test");
    assert.equal(slept.length, 1);
    assert.ok(slept[0]! <= 5_000, `slept ${slept[0]} ms`);
  });

  it("fails at once instead of sleeping through a long one", async () => {
    // Fifteen minutes asleep would hold a worker and the host's slot far past
    // a job's six-minute budget.
    const { limiter, slept } = fakeLimiter();
    limiter.penalise("busy.test", 15 * 60_000);
    await assert.rejects(limiter.acquire("busy.test"), HostRateLimitedError);
    assert.deepEqual(slept, [], "never slept");
  });

  it("is reported as rate limited, so the job is retried later", () => {
    const failure = classifyFetchError(new HostRateLimitedError("busy.test"), "outbox page");
    assert.equal(failure.kind, "rateLimited");
    assert.equal(failure.transient, true);
  });

  it("does not hold up other hosts", async () => {
    const { limiter, slept } = fakeLimiter();
    limiter.penalise("busy.test", 15 * 60_000);
    await limiter.acquire("quiet.test");
    assert.deepEqual(slept, []);
  });
});
