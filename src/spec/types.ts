import { z } from "zod";

const taskScopeSchema = z.enum(["file", "function", "test", "module"]);
const mergeStrategySchema = z.enum(["sequential", "parallel-safe"]);

export const specTaskSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    depends_on: z.array(z.string().min(1)).default([]),
    owned_files: z.array(z.string().min(1)).min(1),
    scope: taskScopeSchema.default("file"),
    target: z.string().nullable().optional(),
    allow_parallel: z.boolean().default(false),
  })
  .superRefine((task, ctx) => {
    if (task.scope !== "file" && (!task.target || !task.target.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target is required when scope is not 'file'",
        path: ["target"],
      });
    }
  });

export const specSchema = z
  .object({
    version: z.literal(1),
    config: z
      .object({
        max_parallel_tasks: z.number().int().min(1).default(3),
        max_retries: z.number().int().min(0).default(2),
      })
      .default({ max_parallel_tasks: 3, max_retries: 2 }),
    merge: z
      .object({
        strategy: mergeStrategySchema.default("sequential"),
        order: z.array(z.string().min(1)).default([]),
      })
      .default({ strategy: "sequential", order: [] }),
    tasks: z.array(specTaskSchema).min(1),
  })
  .superRefine((spec, ctx) => {
    const ids = new Set<string>();
    for (const task of spec.tasks) {
      if (ids.has(task.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate task id: ${task.id}`,
          path: ["tasks"],
        });
      }
      ids.add(task.id);
    }
    for (const task of spec.tasks) {
      for (const dep of task.depends_on) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `task '${task.id}' depends_on unknown task '${dep}'`,
            path: ["tasks"],
          });
        }
      }
    }
    for (const ordered of spec.merge.order) {
      if (!ids.has(ordered)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `merge.order references unknown task '${ordered}'`,
          path: ["merge", "order"],
        });
      }
    }
  });
