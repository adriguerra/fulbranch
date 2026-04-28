/**
 * Topological sort + cycle detection.
 *
 * Pure function operating on any "node with dependencies" shape. Used by the
 * dispatcher to order runnable tickets, and by the spec-agent (indirectly via
 * this backend, if invoked) as a cycle pre-check.
 *
 * Algorithm: Kahn's. O(V + E). Deterministic when given a deterministic input
 * ordering.
 */

export interface DepNode {
  id: string;
  dependsOn: string[];
}

export interface CycleError {
  cycle: string[];          // one representative cycle
  unresolved: string[];     // all nodes that could not be sorted
}

export type TopoResult<T extends DepNode> =
  | { ok: true; ordered: T[] }
  | { ok: false; ordered: T[]; error: CycleError };

export function topoSort<T extends DepNode>(nodes: T[]): TopoResult<T> {
  const byId = new Map<string, T>();
  for (const n of nodes) byId.set(n.id, n);

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }

  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      // Unknown deps (e.g. dep not yet ingested): treat as a soft block.
      // Inflate in-degree so this node stays blocked, but don't raise an error —
      // the dep may arrive via a later webhook or reconciliation run.
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
      if (adjacency.has(dep)) {
        adjacency.get(dep)!.push(n.id);
      }
      // else: unknown dep, no outgoing edge to add — node stays blocked by
      // its inflated in-degree.
    }
  }

  // Stable queue: process in the order nodes appeared in the input.
  const queue: string[] = [];
  for (const n of nodes) if ((inDegree.get(n.id) ?? 0) === 0) queue.push(n.id);

  const ordered: T[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id)!;
    ordered.push(node);
    for (const next of adjacency.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (ordered.length === nodes.length) {
    return { ok: true, ordered };
  }

  const unresolved = nodes.filter((n) => !ordered.includes(n)).map((n) => n.id);
  const cycle = findCycle(nodes, unresolved);
  // `ordered` contains every node that DID sort cleanly — callers can still
  // dispatch those even when some nodes are stuck on unresolved deps.
  return { ok: false, ordered, error: { cycle, unresolved } };
}

/**
 * Walks outgoing edges from any unresolved node to surface one real cycle.
 * Returns the node IDs forming the cycle in visit order.
 * Nodes whose unresolved state is due to an unknown external dep (not a true
 * cycle) will produce an empty cycle — caller should distinguish.
 */
function findCycle<T extends DepNode>(nodes: T[], unresolved: string[]): string[] {
  const byId = new Map<string, T>();
  for (const n of nodes) byId.set(n.id, n);
  const unresolvedSet = new Set(unresolved);

  for (const start of unresolved) {
    const stack: string[] = [];
    const visiting = new Set<string>();
    const found = dfs(start, byId, unresolvedSet, stack, visiting);
    if (found.length > 0) return found;
  }
  return [];
}

function dfs<T extends DepNode>(
  id: string,
  byId: Map<string, T>,
  unresolvedSet: Set<string>,
  stack: string[],
  visiting: Set<string>,
): string[] {
  if (visiting.has(id)) {
    const start = stack.indexOf(id);
    return start >= 0 ? stack.slice(start).concat(id) : [id];
  }
  const node = byId.get(id);
  if (!node) return [];
  visiting.add(id);
  stack.push(id);
  for (const dep of node.dependsOn) {
    if (!unresolvedSet.has(dep)) continue;
    const found = dfs(dep, byId, unresolvedSet, stack, visiting);
    if (found.length > 0) return found;
  }
  stack.pop();
  visiting.delete(id);
  return [];
}
