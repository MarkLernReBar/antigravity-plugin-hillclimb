import { z } from "zod";
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const optionalKey = z.preprocess((v) => (v === "" || v === undefined ? null : v), key.nullable());
const word = z.string().trim().min(1);
const optionalWord = z.preprocess((v) => (v === "" || v === undefined ? null : v), word.nullable());
const criterion = z.object({ id: key, given: word, when: word, then: word });
const contract = z.object({
  title: word,
  story: word,
  criteria: z.array(criterion).min(1),
  dependsOn: z.array(key).default([]),
  rank: z.number().int().nonnegative().default(100),
  recheckDays: z.number().positive().nullable().default(null),
});
const track = key.default("main");
export const coreActions = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create_goal"),
    key,
    parentGoalKey: optionalKey,
    title: word,
    brief: word,
    rank: z.number().int().nonnegative().default(100),
  }),
  z.object({ op: z.literal("create_outcome"), key, goalKey: key, contract }),
  z.object({
    op: z.literal("propose_change"),
    key,
    version: z.number().int().positive(),
    contract,
  }),
  z.object({ op: z.literal("approve_change"), id: word }),
  z.object({ op: z.literal("reject_change"), id: word }),
  z.object({
    op: z.literal("claim_outcome"),
    key,
    threadId: word,
    hours: z.number().positive().max(168).default(4),
  }),
  z.object({ op: z.literal("release_outcome"), key, threadId: word }),
  z.object({
    op: z.literal("add_evidence"),
    key,
    version: z.number().int().positive(),
    receiptId: z.string().min(1).max(256).optional(),
    kind: z.enum(["confirms", "denies", "note"]),
    criterionIds: z.array(key),
    text: word,
    source: word,
    track,
  }),
]);
export const planningActions = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write_plan"), key, body: word }),
  z.object({
    op: z.literal("revise_plan"),
    key,
    version: z.number().int().positive(),
    body: word,
  }),
  z.object({
    op: z.literal("comment"),
    key,
    text: word,
    options: z.array(word).default([]),
    parentId: optionalWord,
  }),
  z.object({ op: z.literal("answer"), id: word, answer: word }),
  z.object({ op: z.literal("create_track"), name: key, description: word }),
  z.object({
    op: z.literal("promote_track"),
    name: key,
    keys: z.array(key).min(1),
  }),
  z.object({
    op: z.literal("create_release"),
    name: word,
    keys: z.array(key).min(1),
    date: z.string().date(),
    scenario: word,
  }),
  z.object({
    op: z.literal("create_flow"),
    name: word,
    frames: z
      .array(z.object({ title: word, key, criterionId: key, html: word }))
      .min(1),
  }),
  z.object({
    op: z.literal("pin"),
    name: word,
    frame: z.number().int().nonnegative(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    text: word,
  }),
]);
export const actionSchema = z.union([coreActions, planningActions]);
export type CoreAction = z.infer<typeof coreActions>;
export type PlanningAction = z.infer<typeof planningActions>;
export type Action = CoreAction | PlanningAction;
