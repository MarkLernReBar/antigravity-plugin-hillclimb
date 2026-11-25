// The verifier configuration a dispatch runs with, and its typed schema.
//
// A check command is an engineering decision, not a field of the outcome
// contract, so it is stored per (project, outcome, version, engine) and never
// derived from prose. The schema below is typed against the bridge's own
// `RepoRig` / `SearchRig` interfaces: if the bridge's rig shape changes, this
// file stops compiling rather than drifting silently. The bridge still
// validates semantics (missing_check, missing_holdout, …) when it builds a
// recipe; this layer is about shape and liveness.

import { z } from "zod";
import type { RepoRig, Rig, SearchRig } from "./search-bridge.js";

export type { RepoRig, Rig, SearchRig };

const command = z.string().trim().min(1).max(4000);
const commands = z.array(command).min(1).max(64);
/** The rig's own scope: at least one id, no repeats. Subset membership is checked by the bridge. */
const criterionIds = z
  .array(z.string().trim().min(1).max(96))
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, "criterion ids must be unique");

const repoRigObject = z.object({
  engine: z.literal("repo"),
  check: commands,
  direction: z.enum(["min", "max"]),
  target: z.number(),
  guard: commands,
  holdout: command,
  lock: commands,
  name: z.string().trim().min(1).max(96).optional(),
  score: z.array(command).min(1).max(64).optional(),
  runs: z.number().int().positive().max(1000).optional(),
  minGain: z.string().trim().min(1).max(64).regex(/^(?:\d+(?:\.\d*)?|\.\d+)%?$/, "Minimum gain must be a nonnegative number or percentage").optional(),
  maxSteps: z.number().int().positive().max(100_000).optional(),
  maxHours: z.number().positive().max(8760).optional(),
  after: z.enum(["stop", "raise"]).optional(),
  preflight: command.optional(),
  criterionIds: criterionIds.optional(),
  scoreMode: z.enum(["numeric", "failure-count"]).optional(),
  paired: z.boolean().optional(),
  hard: z.boolean().optional(),
});

const searchRigObject = z.object({
  engine: z.literal("search"),
  problemId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "problem id must be lowercase [a-z0-9._-]"),
  metric: z.string().trim().min(1).max(200),
  higherIsBetter: z.boolean(),
  target: z.number(),
  verifier: z.string().trim().min(1).max(200_000),
  baseline: z.string().trim().min(1).max(200_000),
  criterionIds: criterionIds.optional(),
  holdout: z.boolean().optional(),
  budget: z.string().trim().min(1).max(32).optional(),
  agent: z.string().trim().min(1).max(64).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  parallelSearches: z.number().int().positive().max(64).optional(),
  runner: z.string().trim().min(1).max(200).optional(),
  // a named climber replaces the legacy greedy run; omitted keeps it
  climber: z
    .object({
      name: z.enum(["greedy", "openevolve", "gepa"]),
      tuner: z.enum(["random", "optuna"]).optional(),
      featureDimensions: z.array(z.string().regex(/^[a-z0-9][a-z0-9_]*$/, "feature dimension names are lowercase words")).min(1).max(3).optional(),
      tuneBudget: z.number().int().nonnegative().max(1000).optional(),
    })
    .optional(),
});

export const repoRigSchema: z.ZodType<RepoRig> = repoRigObject;
export const searchRigSchema: z.ZodType<SearchRig> = searchRigObject;
export const rigSchema: z.ZodType<Rig> = z.discriminatedUnion("engine", [repoRigObject, searchRigObject]);

/** Parse an unknown rig into the bridge's own type, or say exactly what is wrong. */
export function parseRig(value: unknown): Rig {
  return rigSchema.parse(value);
}

export function engineOf(value: unknown): "repo" | "search" | null {
  const parsed = rigSchema.safeParse(value);
  return parsed.success ? parsed.data.engine : null;
}
