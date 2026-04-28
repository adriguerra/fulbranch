/**
 * Counting semaphore bounded by MAX_PARALLEL_AGENTS.
 *
 * Each in-flight agent pipeline holds one permit from acquire() to release().
 * The dispatcher checks availableSlots() before spawning new pipelines.
 *
 * Single-process: this is a plain in-memory counter. If the orchestrator is
 * ever scaled horizontally, this becomes Redis or similar — out of scope for v1.
 */

import { config } from "@/config";

let acquired = 0;
let cap: number | null = null;

function getCap(): number {
  if (cap === null) cap = config().maxParallelAgents;
  return cap;
}

export function availableSlots(): number {
  return Math.max(0, getCap() - acquired);
}

export function acquire(): boolean {
  if (acquired >= getCap()) return false;
  acquired++;
  return true;
}

export function release(): void {
  if (acquired > 0) acquired--;
}

export function inFlight(): number {
  return acquired;
}

/** Test helper — reset the counter and optionally override the cap. */
export function __resetSemaphoreForTests(newCap?: number): void {
  acquired = 0;
  cap = newCap ?? null;
}
