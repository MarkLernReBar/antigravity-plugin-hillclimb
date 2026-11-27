import type { Action } from "./actions.js";
import type { Contract, Criterion } from "./model.js";
import { lintTree } from "./linter.js";

export interface BlueprintDefinition {
  id: string;
  name: string;
  description: string;
  tags: string[];
  goals: Array<{ key: string; parentGoalKey: string | null; title: string; brief: string; rank: number; tags?: string[] }>;
  outcomes: Array<{ key: string; goalKey: string; contract: Contract }>;
}

export const BLUEPRINTS: readonly BlueprintDefinition[] = [
  {
    id: "saas-api",
    name: "Reliable Web API",
    description: "Contract tree for latency, error handling, idempotency, and schema stability on a backend API.",
    tags: ["api", "backend", "reliability"],
    goals: [
      {
        key: "G-API",
        parentGoalKey: null,
        title: "API responses stay fast, valid, and idempotent",
        brief: "Callers receive deterministic schemas, bounded tail latency, and safe retries across every public endpoint.",
        rank: 10,
        tags: ["api"],
      },
    ],
    outcomes: [
      {
        key: "API-IDEMPOTENCY",
        goalKey: "G-API",
        contract: {
          title: "Repeated write requests execute at most once",
          story: "As an API integrator, I want retried POST requests with the same Idempotency-Key to replay the original result, so that network retries never create duplicate records.",
          criteria: [
            {
              id: "ac1",
              given: "a write request with an Idempotency-Key that already succeeded",
              when: "the client sends the same request body again",
              then: "the server returns the original status and body without creating a duplicate resource",
            },
            {
              id: "ac2",
              given: "an Idempotency-Key previously used with a different payload",
              when: "a caller reuses that key with conflicting fields",
              then: "the server rejects the request with HTTP 409 Conflict",
            },
          ],
          dependsOn: [],
          rank: 10,
          recheckDays: 30,
          tags: ["api", "safety"],
        },
      },
      {
        key: "API-VALIDATION",
        goalKey: "G-API",
        contract: {
          title: "Invalid payloads return actionable structured errors",
          story: "As an API consumer, I want malformed inputs rejected with field-level error codes, so that callers can correct requests without guessing.",
          criteria: [
            {
              id: "ac1",
              given: "a JSON request missing required fields or violating value bounds",
              when: "the endpoint validates the input",
              then: "the response returns HTTP 400 with field names and machine-readable error codes",
            },
          ],
          dependsOn: [],
          rank: 20,
          recheckDays: null,
          tags: ["api"],
        },
      },
    ],
  },
  {
    id: "auth-and-sessions",
    name: "Authentication & Session Security",
    description: "Outcomes covering login, session revocation, password reset safety, and permission boundaries.",
    tags: ["auth", "security"],
    goals: [
      {
        key: "G-AUTH",
        parentGoalKey: null,
        title: "Only authorized accounts access protected data",
        brief: "Credentials, sessions, and revocation hold under concurrent access and hostile requests.",
        rank: 10,
        tags: ["auth", "security"],
      },
    ],
    outcomes: [
      {
        key: "AUTH-REVOKE",
        goalKey: "G-AUTH",
        contract: {
          title: "Revoked sessions lose access immediately",
          story: "As an account owner, I want signing out or revoking a session to invalidate its token right away, so that a lost device cannot keep reading private data.",
          criteria: [
            {
              id: "ac1",
              given: "an active authenticated session",
              when: "the user revokes the session and replays its cookie or token",
              then: "every protected request returns HTTP 401 Unauthorized",
            },
          ],
          dependsOn: [],
          rank: 10,
          recheckDays: 14,
          tags: ["auth", "security"],
        },
      },
    ],
  },
  {
    id: "billing-and-proration",
    name: "Billing & Subscription Proration",
    description: "Invoice reconciliation, mid-cycle proration, and failed payment recovery outcomes.",
    tags: ["billing", "finance"],
    goals: [
      {
        key: "G-BILLING",
        parentGoalKey: null,
        title: "Customer invoices reconcile to the cent",
        brief: "Plan changes, seat additions, and taxes produce exact invoices with zero manual credit adjustments.",
        rank: 10,
        tags: ["billing"],
      },
    ],
    outcomes: [
      {
        key: "BILL-PRORATE",
        goalKey: "G-BILLING",
        contract: {
          title: "Mid-cycle plan changes prorate by remaining days",
          story: "As a workspace admin, I want seats added mid-month charged only for remaining days, so that teams never overpay for partial cycles.",
          criteria: [
            {
              id: "ac1",
              given: "an active monthly subscription halfway through its billing period",
              when: "the admin adds a paid seat",
              then: "the prorated charge equals the daily rate times remaining days rounded to the nearest cent",
            },
          ],
          dependsOn: [],
          rank: 10,
          recheckDays: 30,
          tags: ["billing"],
        },
      },
    ],
  },
  {
    id: "search-and-retrieval",
    name: "Search & Retrieval Quality",
    description: "Ranking NDCG, recall on held-out queries, and zero-result recovery for search & RAG pipelines.",
    tags: ["search", "retrieval", "eval"],
    goals: [
      {
        key: "G-SEARCH",
        parentGoalKey: null,
        title: "Search surfaces the right answer on unseen queries",
        brief: "Ranking quality and recall improve on held-out query splits without regressing latency or precision.",
        rank: 10,
        tags: ["search", "retrieval"],
      },
    ],
    outcomes: [
      {
        key: "SEARCH-RECALL",
        goalKey: "G-SEARCH",
        contract: {
          title: "Held-out queries retrieve relevant documents in top results",
          story: "As a user searching documentation, I want relevant passages ranked in the top results on unseen phrasings, so that answers are found on the first query.",
          criteria: [
            {
              id: "ac1",
              given: "the locked evaluation benchmark and disjoint holdout query split",
              when: "the retrieval pipeline scores both splits",
              then: "visible and held-out recall meet the target bar with zero guard regressions",
            },
          ],
          dependsOn: [],
          rank: 10,
          recheckDays: 14,
          tags: ["search", "eval"],
        },
      },
    ],
  },
  {
    id: "agent-eval-pipeline",
    name: "Coding Agent & Eval Harness",
    description: "Outcomes for task completion, cost budget caps, zero unintended side effects, and holdout generalization.",
    tags: ["agents", "eval"],
    goals: [
      {
        key: "G-EVAL",
        parentGoalKey: null,
        title: "Agent tasks complete accurately within budget",
        brief: "Autonomous runs verify real outcomes on unseen cases without exceeding cost limits or touching forbidden state.",
        rank: 10,
        tags: ["agents", "eval"],
      },
    ],
    outcomes: [
      {
        key: "EVAL-BUDGET",
        goalKey: "G-EVAL",
        contract: {
          title: "Agent eval runs complete within declared cost budgets",
          story: "As an engineer running automated evals, I want runs to finish within the suite cost cap without side effects, so that overnight sweeps stay predictable.",
          criteria: [
            {
              id: "ac1",
              given: "the locked agent-outcomes benchmark suite with cost_budget_usd set",
              when: "the candidate agent executes all cases",
              then: "total cost stays within budget and every side-effect and claim guard passes",
            },
          ],
          dependsOn: [],
          rank: 10,
          recheckDays: 14,
          tags: ["agents", "eval"],
        },
      },
    ],
  },
];

export function listBlueprints() {
  return BLUEPRINTS.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    tags: b.tags,
    goalCount: b.goals.length,
    outcomeCount: b.outcomes.length,
  }));
}

export function blueprintActions(
  blueprintId: string,
  opts?: { asProposals?: boolean; keyPrefix?: string; existingKeys?: Set<string> },
): { blueprint: BlueprintDefinition; actions: Action[]; lint: ReturnType<typeof lintTree> } {
  const bp = BLUEPRINTS.find((b) => b.id === blueprintId);
  if (!bp) {
    throw new Error(`Unknown blueprint "${blueprintId}". Available: ${BLUEPRINTS.map((b) => b.id).join(", ")}`);
  }
  const existing = opts?.existingKeys ?? new Set<string>();
  const prefix = opts?.keyPrefix?.trim() || "";
  const mapKey = (k: string) => (prefix ? `${prefix}-${k}` : k);
  const actions: Action[] = [];

  for (const g of bp.goals) {
    const gk = mapKey(g.key);
    if (!existing.has(gk)) {
      actions.push({
        op: "create_goal",
        key: gk,
        parentGoalKey: g.parentGoalKey ? mapKey(g.parentGoalKey) : null,
        title: g.title,
        brief: g.brief,
        rank: g.rank,
        ...(g.tags ? { tags: g.tags } : {}),
      });
    }
  }
  for (const o of bp.outcomes) {
    const ok = mapKey(o.key);
    if (existing.has(ok)) continue;
    const contract: Contract = {
      ...o.contract,
      dependsOn: o.contract.dependsOn.map(mapKey),
    };
    if (opts?.asProposals) {
      actions.push({ op: "propose_outcome", key: ok, goalKey: mapKey(o.goalKey), contract });
    } else {
      actions.push({ op: "create_outcome", key: ok, goalKey: mapKey(o.goalKey), contract });
    }
  }

  const lint = lintTree({
    goals: bp.goals.map((g) => ({ key: mapKey(g.key), parentGoalKey: g.parentGoalKey ? mapKey(g.parentGoalKey) : null, title: g.title, brief: g.brief })),
    outcomes: bp.outcomes.map((o) => ({
      key: mapKey(o.key),
      goalKey: mapKey(o.goalKey),
      title: o.contract.title,
      story: o.contract.story,
      criteria: o.contract.criteria,
      dependsOn: o.contract.dependsOn.map(mapKey),
      rank: o.contract.rank,
      recheckDays: o.contract.recheckDays,
    })),
  });
  return { blueprint: bp, actions, lint };
}

function makeKey(prefix: string, title: string, taken: Set<string>): string {
  const words = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 3)
    .join("-");
  const base = `${prefix}-${words || "ITEM"}`.slice(0, 40);
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  const k = `${base}-${n}`;
  taken.add(k);
  return k;
}

/**
 * Parse Markdown user stories, checklists, or Given/When/Then blocks into Hill Climb actions
 * and run the 22-rule contract linter over the preview before saving.
 */
export function parseMarkdownImport(
  markdown: string,
  opts?: {
    goalKey?: string;
    goalTitle?: string;
    prefix?: string;
    asProposals?: boolean;
    existingKeys?: Set<string>;
    tags?: string[];
  },
): {
  actions: Action[];
  goalsCreated: number;
  outcomesParsed: number;
  lint: ReturnType<typeof lintTree>;
} {
  const lines = markdown.split(/\r?\n/);
  const taken = new Set<string>(opts?.existingKeys ?? []);
  const prefix = (opts?.prefix?.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "") || "HC").slice(0, 12);
  let currentGoalKey = opts?.goalKey?.trim() || "";
  const goals: Array<{ key: string; parentGoalKey: string | null; title: string; brief: string; rank: number }> = [];
  const outcomes: Array<{ key: string; goalKey: string; contract: Contract }> = [];

  const ensureGoal = (title?: string, brief?: string) => {
    if (currentGoalKey) return currentGoalKey;
    const gTitle = title?.trim() || opts?.goalTitle?.trim() || "Imported product requirements";
    const gKey = makeKey("G", gTitle, taken);
    currentGoalKey = gKey;
    goals.push({
      key: gKey,
      parentGoalKey: null,
      title: gTitle,
      brief: brief?.trim() || `Outcomes imported for ${gTitle}.`,
      rank: (goals.length + 1) * 10,
    });
    return gKey;
  };

  interface PendingItem {
    title: string;
    story: string;
    criteria: Criterion[];
    goalKey: string;
  }
  let current: PendingItem | null = null;
  let pendingGiven = "";
  let pendingWhen = "";

  const flush = () => {
    if (!current) return;
    if (current.criteria.length === 0) {
      current.criteria.push({
        id: "ac1",
        given: "the relevant user context is ready",
        when: "the behavior is exercised",
        then: current.title,
      });
    }
    const story =
      current.story ||
      `As a user, I want ${current.title.charAt(0).toLowerCase() + current.title.slice(1)}, so that the workflow works reliably.`;
    outcomes.push({
      key: makeKey(prefix, current.title, taken),
      goalKey: current.goalKey,
      contract: {
        title: current.title,
        story,
        criteria: current.criteria,
        dependsOn: [],
        rank: (outcomes.length + 1) * 10,
        recheckDays: null,
        ...(opts?.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
      },
    });
    current = null;
    pendingGiven = "";
    pendingWhen = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Heading level 1 or 2 starts a Goal
    const h2 = /^#{1,2}\s+(.+)$/.exec(line);
    if (h2) {
      flush();
      const title = h2[1]!.trim();
      if (!opts?.goalKey) {
        currentGoalKey = "";
        ensureGoal(title);
      }
      continue;
    }

    // Heading level 3 starts an Outcome
    const h3 = /^###+\s+(.+)$/.exec(line);
    if (h3) {
      flush();
      const gKey = ensureGoal();
      current = { title: h3[1]!.trim(), story: "", criteria: [], goalKey: gKey };
      continue;
    }

    // Checklist or bullet item (excluding Given/When/Then sub-bullets)
    const bullet = /^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (bullet) {
      const body = bullet[1]!.trim();
      if (/^(?:given|when|then)\b/i.test(body)) {
        // handled below
      } else if (/^as\s+(?:a|an|the)\s+/i.test(body)) {
        if (current && !current.story) {
          current.story = body;
        } else {
          flush();
          const gKey = ensureGoal();
          const wantMatch = /i\s+want\s+([^,]+)/i.exec(body);
          const derivedTitle = wantMatch ? wantMatch[1]!.trim() : body.slice(0, 80);
          current = {
            title: derivedTitle.charAt(0).toUpperCase() + derivedTitle.slice(1),
            story: body,
            criteria: [],
            goalKey: gKey,
          };
        }
        continue;
      } else {
        flush();
        const gKey = ensureGoal();
        current = { title: body.replace(/\.$/, ""), story: "", criteria: [], goalKey: gKey };
        continue;
      }
    }

    const clean = line.replace(/^[-*]\s+/, "");
    // Inline single-line Given ..., when ..., then ...
    const inlineGwt = /^given\s+(.+?),?\s+when\s+(.+?),?\s+then\s+(.+)$/i.exec(clean);
    if (inlineGwt) {
      if (!current) {
        const gKey = ensureGoal();
        current = { title: inlineGwt[3]!.trim().replace(/\.$/, ""), story: "", criteria: [], goalKey: gKey };
      }
      current.criteria.push({
        id: `ac${current.criteria.length + 1}`,
        given: inlineGwt[1]!.trim(),
        when: inlineGwt[2]!.trim(),
        then: inlineGwt[3]!.trim(),
      });
      pendingGiven = "";
      pendingWhen = "";
      continue;
    }

    const givenM = /^given\s+(.+)$/i.exec(clean);
    if (givenM) {
      pendingGiven = givenM[1]!.trim();
      continue;
    }
    const whenM = /^when\s+(.+)$/i.exec(clean);
    if (whenM) {
      pendingWhen = whenM[1]!.trim();
      continue;
    }
    const thenM = /^then\s+(.+)$/i.exec(clean);
    if (thenM) {
      if (!current) {
        const gKey = ensureGoal();
        current = { title: thenM[1]!.trim().replace(/\.$/, ""), story: "", criteria: [], goalKey: gKey };
      }
      current.criteria.push({
        id: `ac${current.criteria.length + 1}`,
        given: pendingGiven || "the precondition holds",
        when: pendingWhen || "the user performs the action",
        then: thenM[1]!.trim(),
      });
      pendingGiven = "";
      pendingWhen = "";
      continue;
    }

    if (/^as\s+(?:a|an|the)\s+/i.test(clean)) {
      if (current && !current.story) {
        current.story = clean;
      } else {
        flush();
        const gKey = ensureGoal();
        const wantMatch = /i\s+want\s+([^,]+)/i.exec(clean);
        const derivedTitle = wantMatch ? wantMatch[1]!.trim() : clean.slice(0, 80);
        current = {
          title: derivedTitle.charAt(0).toUpperCase() + derivedTitle.slice(1),
          story: clean,
          criteria: [],
          goalKey: gKey,
        };
      }
    }
  }
  flush();

  const actions: Action[] = [];
  for (const g of goals) {
    actions.push({
      op: "create_goal",
      key: g.key,
      parentGoalKey: g.parentGoalKey,
      title: g.title,
      brief: g.brief,
      rank: g.rank,
      ...(opts?.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
    });
  }
  for (const o of outcomes) {
    if (opts?.asProposals) {
      actions.push({ op: "propose_outcome", key: o.key, goalKey: o.goalKey, contract: o.contract });
    } else {
      actions.push({ op: "create_outcome", key: o.key, goalKey: o.goalKey, contract: o.contract });
    }
  }

  const lint = lintTree({
    goals,
    outcomes: outcomes.map((o) => ({
      key: o.key,
      goalKey: o.goalKey,
      title: o.contract.title,
      story: o.contract.story,
      criteria: o.contract.criteria,
      dependsOn: o.contract.dependsOn,
      rank: o.contract.rank,
      recheckDays: o.contract.recheckDays,
    })),
  });

  return { actions, goalsCreated: goals.length, outcomesParsed: outcomes.length, lint };
}
