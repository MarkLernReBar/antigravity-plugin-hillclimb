import { z } from "zod";
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const optionalKey = z.preprocess((v) => (v === "" || v === undefined ? null : v), key.nullable());
const word = z.string().trim().min(1);
const optionalWord = z.preprocess((v) => (v === "" || v === undefined ? null : v), word.nullable());
const tag = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,63}$/);
const tagsList = z.array(tag).max(20);
const criterion = z.object({ id: key, given: word, when: word, then: word });
const contract = z.object({
  title: word,
  story: word,
  criteria: z.array(criterion).min(1),
  dependsOn: z.array(key).default([]),
  rank: z.number().int().nonnegative().default(100),
  recheckDays: z.number().positive().nullable().default(null),
  tags: tagsList.optional(),
});
const track = key.default("main");
const attachment = z.object({
  label: word.max(160),
  path: word.max(1024),
  mimeType: z.string().trim().min(1).max(128).optional(),
});
const viewport = z.object({
  width: z.number().int().min(100).max(8000),
  height: z.number().int().min(100).max(8000),
});
const frameInput = z.object({
  title: word,
  key,
  criterionId: key,
  html: z.string().default(""),
  kind: z.enum(["html", "image"]).optional(),
  imagePath: optionalWord.optional(),
  viewport: viewport.nullable().optional(),
  notes: optionalWord.optional(),
  componentRefs: z.array(word).max(20).optional(),
});

export const coreActions = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create_goal"),
    key,
    parentGoalKey: optionalKey,
    title: word,
    brief: word,
    rank: z.number().int().nonnegative().default(100),
    tags: tagsList.optional(),
  }),
  z.object({
    op: z.literal("update_goal"),
    key,
    title: word.optional(),
    brief: word.optional(),
    rank: z.number().int().nonnegative().optional(),
    parentGoalKey: optionalKey.optional(),
    tags: tagsList.optional(),
  }),
  z.object({ op: z.literal("create_outcome"), key, goalKey: key, contract }),
  z.object({
    op: z.literal("propose_outcome"),
    key,
    goalKey: key,
    contract,
    threadId: optionalWord.optional(),
  }),
  z.object({
    op: z.literal("propose_change"),
    key,
    version: z.number().int().positive(),
    contract,
    threadId: optionalWord.optional(),
  }),
  z.object({ op: z.literal("approve_change"), id: word }),
  z.object({ op: z.literal("reject_change"), id: word }),
  z.object({
    op: z.literal("set_outcome_availability"),
    key,
    availability: z.enum(["active", "blocked", "deferred"]),
    reason: optionalWord.optional(),
    deferredUntil: optionalWord.optional(),
  }),
  z.object({
    op: z.literal("set_tags"),
    key,
    target: z.enum(["outcome", "goal"]).optional(),
    tags: tagsList,
  }),
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
    attachments: z.array(attachment).max(12).optional(),
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
    planVersion: z.number().int().positive().nullable().optional(),
    threadId: optionalWord.optional(),
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
    op: z.literal("revise_release"),
    name: word,
    scenario: word,
    keys: z.array(key).min(1).optional(),
    date: z.string().date().optional(),
    newName: word.optional(),
  }),
  z.object({
    op: z.literal("create_flow"),
    name: word,
    folder: optionalWord.optional(),
    designKit: optionalWord.optional(),
    frames: z.array(frameInput).min(1),
  }),
  z.object({
    op: z.literal("pin"),
    name: word,
    frame: z.number().int().nonnegative(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    text: word,
    kind: z.enum(["point", "rect", "arrow", "path", "step"]).optional(),
    geometry: z.record(z.string(), z.union([z.number(), z.array(z.number())])).optional(),
    selector: optionalWord.optional(),
    forAgents: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("resolve_pin"),
    name: word,
    frame: z.number().int().nonnegative(),
    pinId: optionalWord.optional(),
    pinIndex: z.number().int().nonnegative().optional(),
    resolved: z.boolean().default(true),
    resolvedBy: optionalWord.optional(),
  }),
  z.object({
    op: z.literal("propose_flow_change"),
    kind: z.enum(["change", "new_flow", "new_step"]).default("change"),
    flowName: word,
    folder: optionalWord.optional(),
    designKit: optionalWord.optional(),
    frameIndex: z.number().int().nonnegative().nullable().optional(),
    basedOnVersion: z.number().int().positive().nullable().optional(),
    frame: frameInput.nullable().optional(),
    frames: z.array(frameInput).min(1).nullable().optional(),
    componentRefs: z.array(word).max(20).optional(),
    selfGrade: optionalWord.optional(),
    ref: optionalWord.optional(),
    spot: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional(),
    note: optionalWord.optional(),
    threadId: optionalWord.optional(),
  }),
  z.object({
    op: z.literal("accept_flow_change"),
    id: word,
    reviewNote: optionalWord.optional(),
  }),
  z.object({
    op: z.literal("reject_flow_change"),
    id: word,
    reviewNote: optionalWord.optional(),
  }),
  z.object({
    op: z.literal("restore_frame_version"),
    flowName: word,
    frameIndex: z.number().int().nonnegative(),
    version: z.number().int().positive(),
  }),
  z.object({
    op: z.literal("set_frame_drift"),
    flowName: word,
    frameIndex: z.number().int().nonnegative(),
    liveImagePath: optionalWord.optional(),
    driftDetected: z.boolean(),
    driftNote: optionalWord.optional(),
  }),
]);
export const actionSchema = z.union([coreActions, planningActions]);
export type CoreAction = z.infer<typeof coreActions>;
export type PlanningAction = z.infer<typeof planningActions>;
export type Action = CoreAction | PlanningAction;
