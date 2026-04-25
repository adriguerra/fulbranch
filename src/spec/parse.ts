import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import type { SpecDefinition } from "../types.js";
import { specSchema } from "./types.js";

export interface ParsedSpec {
  spec: SpecDefinition;
  raw: string;
}

export function parseSpecFile(specPath: string): ParsedSpec {
  const raw = fs.readFileSync(specPath, "utf-8");
  const parsed = parseYaml(raw);
  const validated = specSchema.parse(parsed) as SpecDefinition;
  return { spec: validated, raw };
}

export function planSpec(spec: SpecDefinition): {
  order: string[];
  conflicts: Array<{ left: string; right: string; shared: string[] }>;
} {
  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const task of spec.tasks) {
    indegree.set(task.id, task.depends_on.length);
    edges.set(task.id, []);
  }
  for (const task of spec.tasks) {
    for (const dep of task.depends_on) {
      edges.get(dep)?.push(task.id);
    }
  }

  const queue = spec.tasks
    .filter((t) => indegree.get(t.id) === 0)
    .map((t) => t.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of edges.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) {
        queue.push(next);
      }
    }
  }

  const conflicts: Array<{ left: string; right: string; shared: string[] }> = [];
  for (let i = 0; i < spec.tasks.length; i += 1) {
    for (let j = i + 1; j < spec.tasks.length; j += 1) {
      const a = spec.tasks[i];
      const b = spec.tasks[j];
      const shared = a.owned_files.filter((f) => b.owned_files.includes(f));
      if (shared.length > 0) {
        conflicts.push({ left: a.id, right: b.id, shared });
      }
    }
  }
  return { order, conflicts };
}
