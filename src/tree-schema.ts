import { z } from "zod";

const s = z.string();
const n = z.number();
const strings = z.array(s);

const criterion = z.object({ id: s, given: s, when: s, then: s });
const goal = z.object({
  key: s,
  parentGoalKey: s.nullable(),
  title: s,
  brief: s,
  rank: n,
  created: s,
});
const contract = z.object({
  title: s,
  story: s,
  criteria: criterion.array(),
  dependsOn: strings,
  rank: n,
  recheckDays: n.nullable(),
});
const outcome = contract.extend({
  key: s,
  goalKey: s,
  version: n,
  created: s,
  updated: s,
});
const claim = z.object({ key: s, threadId: s, expires: s });
const signal = z.enum(["verified", "unverified", "broken", "stale", "recheck"]);
const change = z.object({
  id: s,
  key: s,
  baseVersion: n,
  proposed: contract,
  state: z.enum(["pending", "approved", "rejected"]),
  created: s,
});

export const treeSchema = z.object({
  goals: goal.array(),
  outcomes: outcome.array(),
  claims: claim.array(),
  changes: change.array(),
  evidence: z
    .object({
      id: s,
      key: s,
      version: n,
      criterionIds: strings,
      kind: z.enum(["confirms", "denies", "note"]),
      track: s,
      text: s,
      source: s,
      created: s,
    })
    .array(),
  plans: z.object({ key: s, version: n, body: s, created: s }).array(),
  comments: z
    .object({
      id: s,
      key: s,
      parentId: s.nullable(),
      text: s,
      options: strings,
      answer: s.nullable(),
      created: s,
    })
    .array(),
  tracks: z.object({ name: s, description: s }).array(),
  releases: z.object({ name: s, keys: strings, scenario: s, date: s }).array(),
  flows: z
    .object({
      name: s,
      frames: z
        .object({
          title: s,
          html: s,
          criterionId: s,
          key: s,
          pins: z.object({ x: n, y: n, text: s }).array(),
        })
        .array(),
    })
    .array(),
  activity: z
    .object({
      track: s.optional(),
      at: s,
      key: s,
      text: s,
      signal: signal.nullable(),
    })
    .array(),
});
