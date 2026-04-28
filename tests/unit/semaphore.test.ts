import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetSemaphoreForTests,
  acquire,
  availableSlots,
  inFlight,
  release,
} from "../../src/orchestrator/semaphore";

describe("semaphore (MAX_PARALLEL_AGENTS cap)", () => {
  afterEach(() => {
    __resetSemaphoreForTests();
  });

  test("availableSlots defaults to the configured cap before any acquire", () => {
    __resetSemaphoreForTests(3);
    expect(availableSlots()).toBe(3);
    expect(inFlight()).toBe(0);
  });

  test("acquire decrements slots, release restores them", () => {
    __resetSemaphoreForTests(2);

    expect(acquire()).toBe(true);
    expect(inFlight()).toBe(1);
    expect(availableSlots()).toBe(1);

    expect(acquire()).toBe(true);
    expect(inFlight()).toBe(2);
    expect(availableSlots()).toBe(0);

    expect(acquire()).toBe(false);
    expect(inFlight()).toBe(2);

    release();
    expect(inFlight()).toBe(1);
    expect(availableSlots()).toBe(1);

    release();
    expect(inFlight()).toBe(0);
    expect(availableSlots()).toBe(2);
  });

  test("release never drops the counter below zero", () => {
    __resetSemaphoreForTests(1);
    release();
    release();
    expect(inFlight()).toBe(0);
  });
});
