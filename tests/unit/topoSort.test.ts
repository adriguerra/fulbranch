import { describe, expect, test } from "bun:test";
import { topoSort, type DepNode } from "../../src/orchestrator/topoSort";

function ids<T extends DepNode>(nodes: T[]): string[] {
  return nodes.map((n) => n.id);
}

describe("topoSort (TDD §6.3)", () => {
  test("empty graph returns empty ordered list", () => {
    const res = topoSort([]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ordered).toEqual([]);
  });

  test("single node with no deps", () => {
    const res = topoSort([{ id: "A", dependsOn: [] }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(ids(res.ordered)).toEqual(["A"]);
  });

  test("linear chain A -> B -> C", () => {
    const res = topoSort([
      { id: "C", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
      { id: "A", dependsOn: [] },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(ids(res.ordered)).toEqual(["A", "B", "C"]);
  });

  test("fan-in: D depends on B and C which both depend on A", () => {
    const res = topoSort([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(ids(res.ordered)[0]).toBe("A");
      expect(ids(res.ordered).at(-1)).toBe("D");
      expect(new Set(ids(res.ordered))).toEqual(new Set(["A", "B", "C", "D"]));
    }
  });

  test("detects 2-node cycle A <-> B", () => {
    const res = topoSort([
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.cycle.length).toBeGreaterThan(0);
      expect(res.error.unresolved.sort()).toEqual(["A", "B"]);
    }
  });

  test("detects 3-node cycle A -> B -> C -> A", () => {
    const res = topoSort([
      { id: "A", dependsOn: ["C"] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.cycle.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("unknown dep keeps node blocked but does NOT produce a cycle", () => {
    const res = topoSort([
      { id: "A", dependsOn: ["MISSING-42"] },
    ]);
    // One-node graph with a missing dep: Kahn cannot schedule A, so ok=false,
    // but no real cycle exists — caller distinguishes cycle.length === 0.
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.cycle).toEqual([]);
      expect(res.error.unresolved).toEqual(["A"]);
    }
  });

  test("preserves input order for independent nodes (stable-ish)", () => {
    const res = topoSort([
      { id: "B", dependsOn: [] },
      { id: "A", dependsOn: [] },
      { id: "C", dependsOn: [] },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(ids(res.ordered)).toEqual(["B", "A", "C"]);
  });
});
