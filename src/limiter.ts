// Mastodon allows 300 paging requests per 15 min per IP, signed or not. One job per host
// (src/db.ts) plus this token bucket. x-ratelimit-* headers are ignored: CDN-cached, stale.

import { setTimeout as sleep } from "node:timers/promises";
import type { DocumentLoader } from "@fedify/vocab-runtime";

/** 300 requests / 15 min = one per 3000 ms, per host. */
const DEFAULT_INTERVAL_MS = 3_000;
/** Tokens available immediately; most accounts are well under 40 pages (800 posts). */
const DEFAULT_BURST = 40;
/** Consecutive hard failures before we stop talking to a host. */
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 10 * 60_000;
// Longest wait for a turn. A 429 can park a host for 15 min, far past the six minute
// job budget, so past this the request fails as rate limited and the job retries later.
const MAX_WAIT_MS = 60_000;

type HostState = {
  tokens: number;
  updatedAt: number;
  /** Serialises acquire() so concurrent callers cannot spend the same token. */
  tail: Promise<void>;
  failures: number;
  openUntil: number;
};

class HostBlockedError extends Error {}

/** The host asked us to slow down for longer than MAX_WAIT_MS. */
export class HostRateLimitedError extends Error {}

export type LimiterOptions = {
  intervalMs?: number;
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class HostLimiter {
  readonly #hosts = new Map<string, HostState>();
  readonly #intervalMs: number;
  readonly #burst: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: LimiterOptions = {}) {
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#burst = options.burst ?? DEFAULT_BURST;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => sleep(ms));
  }

  #state(host: string): HostState {
    let state = this.#hosts.get(host);
    if (state == null) {
      state = {
        tokens: this.#burst,
        updatedAt: this.#now(),
        tail: Promise.resolve(),
        failures: 0,
        openUntil: 0,
      };
      this.#hosts.set(host, state);
    }
    return state;
  }

  /** True while the breaker is open for this host. */
  isBlocked(host: string): boolean {
    const state = this.#hosts.get(host);
    return state != null && state.openUntil > this.#now();
  }

  /** Waits for this host's next slot; concurrent callers are spaced out, not all released. */
  acquire(host: string): Promise<void> {
    const state = this.#state(host);
    const wait = state.tail.then(async () => {
      if (state.openUntil > this.#now()) {
        throw new HostBlockedError(`circuit open for ${host}`);
      }
      const elapsed = this.#now() - state.updatedAt;
      state.tokens = Math.min(this.#burst, state.tokens + elapsed / this.#intervalMs);
      state.updatedAt = this.#now();
      if (state.tokens < 1) {
        const delay = Math.ceil((1 - state.tokens) * this.#intervalMs);
        if (delay > MAX_WAIT_MS) {
          throw new HostRateLimitedError(`${host} is rate limited for another ${delay} ms`);
        }
        await this.#sleep(delay);
        state.tokens = Math.min(this.#burst, state.tokens + delay / this.#intervalMs);
        state.updatedAt = this.#now();
      }
      state.tokens -= 1;
    });
    // A rejection must not break the chain, or every later call inherits it forever.
    state.tail = wait.then(
      () => undefined,
      () => undefined,
    );
    return wait;
  }

  /** A hard failure: network error or 5xx. Answers like 401/404/429 are not. */
  noteFailure(host: string): void {
    const state = this.#state(host);
    state.failures += 1;
    if (state.failures >= CIRCUIT_THRESHOLD) {
      state.openUntil = this.#now() + CIRCUIT_COOLDOWN_MS;
      state.failures = 0;
    }
  }

  noteSuccess(host: string): void {
    const state = this.#hosts.get(host);
    if (state != null) state.failures = 0;
  }

  // Spends the host's budget after a 429. Clamped so a hostile or broken Retry-After
  // cannot park a worker for hours.
  penalise(host: string, retryAfterMs: number): void {
    const state = this.#state(host);
    const delay = Math.min(Math.max(retryAfterMs, 1_000), 15 * 60_000);
    state.tokens = 0;
    state.updatedAt = this.#now() + delay - this.#intervalMs;
  }
}

/** Wraps any Fedify DocumentLoader so every fetch waits its turn first. */
export function throttled(inner: DocumentLoader, limiter: HostLimiter): DocumentLoader {
  return async (url, options) => {
    const { host } = new URL(url);
    await limiter.acquire(host);
    try {
      const document = await inner(url, options);
      limiter.noteSuccess(host);
      return document;
    } catch (error) {
      if (isHardFailure(error)) limiter.noteFailure(host);
      const retryAfter = retryAfterMsOf(error);
      if (retryAfter != null) limiter.penalise(host, retryAfter);
      throw error;
    }
  };
}

/** HTTP status carried by Fedify's FetchError, when there is one. */
export function statusOf(error: unknown): number | null {
  const response = (error as { response?: { status?: number } } | null)?.response;
  return typeof response?.status === "number" ? response.status : null;
}

// 4xx must never trip the breaker, or one authorized-fetch instance would take itself
// offline for everyone.
function isHardFailure(error: unknown): boolean {
  const status = statusOf(error);
  if (status == null) return true;
  return status >= 500;
}

function retryAfterMsOf(error: unknown): number | null {
  if (statusOf(error) !== 429) return null;
  const headers = (error as { response?: { headers?: Headers } }).response?.headers;
  const value = headers?.get?.("retry-after");
  if (value == null) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? 60_000 : Math.max(0, at - Date.now());
}
