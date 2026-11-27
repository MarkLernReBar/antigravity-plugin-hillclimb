import { z } from "zod";

const s = z.string();
const n = z.number();
const b = z.boolean();
const strings = z.array(s);
const actorVia = z.enum(["ui", "mcp", "cli", "ci", "auto-track", "hook", "rest"]);
const availability = z.enum(["active", "blocked", "deferred"]);
const viewport = z.object({ width: n, height: n });

const criterion = z.object({ id: s, given: s, when: s, then: s });
const goal = z.object({
  key: s,
  parentGoalKey: s.nullable(),
  title: s,
  brief: s,
  rank: n,
  tags: strings.optional(),
  created: s,
  updated: s.optional(),
});
const contract = z.object({
  title: s,
  story: s,
  criteria: criterion.array(),
  dependsOn: strings,
  rank: n,
  recheckDays: n.nullable(),
  tags: strings.optional(),
});
const outcome = contract.extend({
  key: s,
  goalKey: s,
  version: n,
  availability: availability.optional(),
  availabilityReason: s.nullable().optional(),
  deferredUntil: s.nullable().optional(),
  created: s,
  updated: s,
});
const claim = z.object({ key: s, threadId: s, expires: s });
const signal = z.enum(["verified", "unverified", "broken", "stale", "recheck"]);
const change = z.object({
  id: s,
  key: s,
  kind: z.enum(["edit", "create"]).optional(),
  goalKey: s.optional(),
  baseVersion: n,
  proposed: contract,
  state: z.enum(["pending", "approved", "rejected"]),
  threadId: s.nullable().optional(),
  actor: s.optional(),
  via: actorVia.optional(),
  created: s,
});

const pin = z.object({
  id: s.optional(),
  x: n,
  y: n,
  text: s,
  kind: z.enum(["point", "rect", "arrow", "path", "step"]).optional(),
  geometry: z.record(s, z.union([n, z.array(n)])).optional(),
  selector: s.nullable().optional(),
  forAgents: b.optional(),
  resolved: b.optional(),
  resolvedBy: s.nullable().optional(),
  created: s.optional(),
});

const frameRevision = z.object({
  version: n,
  title: s,
  html: s,
  kind: z.enum(["html", "image"]).optional(),
  imagePath: s.nullable().optional(),
  viewport: viewport.nullable().optional(),
  notes: s.nullable().optional(),
  at: s,
  actor: s.nullable().optional(),
  ref: s.nullable().optional(),
});

const flowProposalFrame = z.object({
  title: s,
  html: s,
  criterionId: s,
  key: s,
  kind: z.enum(["html", "image"]).optional(),
  imagePath: s.nullable().optional(),
  viewport: viewport.nullable().optional(),
  notes: s.nullable().optional(),
  componentRefs: strings.optional(),
});

const flowProposal = z.object({
  id: s,
  kind: z.enum(["change", "new_flow", "new_step"]),
  flowName: s,
  folder: s.nullable().optional(),
  designKit: s.nullable().optional(),
  frameIndex: n.nullable(),
  basedOnVersion: n.nullable(),
  frame: flowProposalFrame.nullable().optional(),
  frames: flowProposalFrame.array().nullable().optional(),
  componentRefs: strings.optional(),
  selfGrade: s.nullable().optional(),
  ref: s.nullable().optional(),
  spot: z.object({ x: n, y: n }).nullable().optional(),
  note: s.nullable().optional(),
  state: z.enum(["pending", "accepted", "rejected"]),
  reviewNote: s.nullable().optional(),
  threadId: s.nullable().optional(),
  actor: s.nullable().optional(),
  via: actorVia.optional(),
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
      attachments: z.object({ label: s, path: s, mimeType: s.optional() }).array().optional(),
      actor: s.optional(),
      via: actorVia.optional(),
      created: s,
    })
    .array(),
  plans: z.object({ key: s, version: n, body: s, actor: s.optional(), via: actorVia.optional(), created: s }).array(),
  comments: z
    .object({
      id: s,
      key: s,
      parentId: s.nullable(),
      planVersion: n.nullable().optional(),
      text: s,
      options: strings,
      answer: s.nullable(),
      threadId: s.nullable().optional(),
      actor: s.optional(),
      via: actorVia.optional(),
      created: s,
    })
    .array(),
  tracks: z.object({ name: s, description: s }).array(),
  releases: z.object({ name: s, keys: strings, scenario: s, date: s }).array(),
  flows: z
    .object({
      name: s,
      folder: s.nullable().optional(),
      designKit: s.nullable().optional(),
      frames: z
        .object({
          title: s,
          html: s,
          criterionId: s,
          key: s,
          kind: z.enum(["html", "image"]).optional(),
          imagePath: s.nullable().optional(),
          viewport: viewport.nullable().optional(),
          notes: s.nullable().optional(),
          version: n.optional(),
          history: frameRevision.array().optional(),
          liveImagePath: s.nullable().optional(),
          driftDetected: b.optional(),
          driftNote: s.nullable().optional(),
          componentRefs: strings.optional(),
          pins: pin.array(),
        })
        .array(),
    })
    .array(),
  flowProposals: flowProposal.array().optional(),
  activity: z
    .object({
      track: s.optional(),
      at: s,
      key: s,
      text: s,
      signal: signal.nullable(),
      actor: s.optional(),
      via: actorVia.optional(),
    })
    .array(),
});
