/**
 * Exponential backoff retry helper (TDD §7 — API rate limit edge case).
 *
 * Defaults: 3 attempts, 500ms base, doubling on each failure.
 */

import { logger } from "./logger";

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
  /** Return true to retry, false to throw immediately. Default: always retry. */
  shouldRetry?: (err: unknown) => boolean;
  label?: string;
}

const DEFAULT_OPTS: Required<Omit<RetryOptions, "onRetry" | "shouldRetry" | "label">> = {
  attempts: 3,
  baseMs: 500,
  factor: 2,
  maxMs: 10_000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { attempts, baseMs, factor, maxMs } = { ...DEFAULT_OPTS, ...opts };
  const log = logger.child({ component: "retry", label: opts.label ?? "anon" });

  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const keepTrying = opts.shouldRetry ? opts.shouldRetry(err) : true;
      if (!keepTrying || i === attempts) break;
      const delay = Math.min(baseMs * factor ** (i - 1), maxMs);
      log.warn("attempt failed, retrying", {
        attempt: i,
        nextDelayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      });
      opts.onRetry?.(i, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
