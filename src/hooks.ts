import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import type { HookEvent, HookRecord, Repository, TreeMutationEvent } from "./repository.js";
import { conversationServiceGuardReason } from "./runtime.js";
import { writeMirror } from "./mirror.js";
import { redactSecrets } from "./state.js";

export interface HookPayload {
  event: Exclude<HookEvent, "*">;
  projectId: string;
  at: string;
  key: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface AutomationDispatchResult {
  dispatched: number;
  failed: number;
  wokeConversations: string[];
}

function runShellHook(command: string, payload: HookPayload): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          HILLCLIMB_EVENT: payload.event,
          HILLCLIMB_PROJECT_ID: payload.projectId,
          HILLCLIMB_EVENT_KEY: payload.key,
          HILLCLIMB_EVENT_JSON: JSON.stringify(payload),
        },
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

function runMacNotify(title: string, message: string): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  const safeTitle = title.replace(/["\\]/g, " ").slice(0, 80);
  const safeMsg = message.replace(/["\\]/g, " ").slice(0, 180);
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", `display notification "${safeMsg}" with title "${safeTitle}"`],
      { timeout: 5_000 },
      () => resolve(),
    );
  });
}

async function postWebhookWithRetry(hook: HookRecord, payload: HookPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "antigravity-plugin-hillclimb/0.5.0",
    "X-Hillclimb-Event": payload.event,
  };
  if (hook.secret) {
    const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
    headers["X-Hillclimb-Signature"] = `sha256=${sig}`;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(hook.target, { method: "POST", headers, body, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function wakeAntigravityConversation(
  conversationId: string,
  directory: string | null,
  note: string,
): Promise<boolean> {
  const reason = conversationServiceGuardReason({ directory: directory ?? undefined });
  if (reason !== null) return false;
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(`http://${addr}/product.v1.ConversationService/CreateConversation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-antigravity-csrf-token": csrf,
      },
      body: JSON.stringify({
        title: `Hill Climb follow-up (${conversationId.slice(0, 8)})`,
        tags: ["hillclimb", "wake-on-answer", `origin:${conversationId}`],
        prompt: [{ text: redactSecrets(note) }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export function createAutomationEngine(repo: Repository) {
  const mirrorTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleMirror(projectId: string): void {
    if (repo.getSetting(projectId, "autoSyncMirror") !== "true") return;
    const dir = repo.getProject(projectId)?.directory;
    if (!dir) return;
    const prev = mirrorTimers.get(projectId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      mirrorTimers.delete(projectId);
      void writeMirror(dir, repo.view(projectId), {
        artifacts: repo.listArtifacts(projectId),
      }).catch(() => undefined);
    }, 500);
    timer.unref?.();
    mirrorTimers.set(projectId, timer);
  }

  async function dispatchEvents(projectId: string, payloads: HookPayload[]): Promise<AutomationDispatchResult> {
    if (payloads.length === 0) return { dispatched: 0, failed: 0, wokeConversations: [] };
    const hooks = repo.listHooks(projectId).filter((h) => h.enabled);
    let dispatched = 0;
    let failed = 0;
    const wokeConversations: string[] = [];

    for (const payload of payloads) {
      for (const hook of hooks) {
        if (hook.event !== "*" && hook.event !== payload.event) continue;
        try {
          if (hook.targetType === "shell") await runShellHook(hook.target, payload);
          else if (hook.targetType === "webhook") await postWebhookWithRetry(hook, payload);
          else if (hook.targetType === "notify") await runMacNotify(`Hill Climb · ${payload.event}`, payload.summary);
          dispatched += 1;
        } catch {
          failed += 1;
        }
      }

      if (
        repo.getSetting(projectId, "wakeOnAnswer") === "true" &&
        (payload.event === "question.answered" || payload.event === "change.approved" || payload.event === "flow.accepted")
      ) {
        const threadId = typeof payload.details.threadId === "string" ? payload.details.threadId : null;
        if (threadId && !threadId.startsWith("local:") && !threadId.startsWith("client:")) {
          const dir = repo.getProject(projectId)?.directory ?? null;
          const woke = await wakeAntigravityConversation(
            threadId,
            dir,
            `Hill Climb update for ${payload.key}: ${payload.summary}\nResume work on outcome ${payload.key} in ${dir ?? "this project"}.`,
          );
          if (woke) wokeConversations.push(threadId);
        }
      }
    }
    return { dispatched, failed, wokeConversations };
  }

  function handleMutation(event: TreeMutationEvent): void {
    scheduleMirror(event.project);
    const now = new Date().toISOString();
    const beforeSignals = new Map(event.before.ranked.map((r) => [r.key, r.signal]));
    const payloads: HookPayload[] = [];

    for (const afterRow of event.after.ranked) {
      const prev = beforeSignals.get(afterRow.key);
      if (prev !== afterRow.signal) {
        if (afterRow.signal === "broken") {
          payloads.push({
            event: "outcome.broken",
            projectId: event.project,
            at: now,
            key: afterRow.key,
            summary: `${afterRow.key} flipped to broken (was ${prev ?? "new"})`,
            details: { previous: prev ?? null, signal: afterRow.signal },
          });
        } else if (afterRow.signal === "verified") {
          payloads.push({
            event: "outcome.verified",
            projectId: event.project,
            at: now,
            key: afterRow.key,
            summary: `${afterRow.key} is now verified`,
            details: { previous: prev ?? null, signal: afterRow.signal },
          });
        }
      }
    }

    for (const action of event.actions) {
      if (action.op === "answer") {
        const comment = event.after.comments.find((c) => c.id === action.id);
        if (comment) {
          payloads.push({
            event: "question.answered",
            projectId: event.project,
            at: now,
            key: comment.key,
            summary: `Answered "${comment.text.slice(0, 60)}" -> "${action.answer}"`,
            details: { commentId: comment.id, answer: action.answer, threadId: comment.threadId ?? null },
          });
        }
      } else if (action.op === "approve_change") {
        const change = event.after.changes.find((c) => c.id === action.id);
        if (change) {
          payloads.push({
            event: "change.approved",
            projectId: event.project,
            at: now,
            key: change.key,
            summary: `Approved ${change.kind === "create" ? "new outcome" : "contract change"} ${change.key}`,
            details: { changeId: change.id, kind: change.kind ?? "edit", threadId: change.threadId ?? null },
          });
        }
      } else if (action.op === "accept_flow_change") {
        const prop = event.after.flowProposals.find((p) => p.id === action.id);
        if (prop) {
          payloads.push({
            event: "flow.accepted",
            projectId: event.project,
            at: now,
            key: prop.flowName,
            summary: `Accepted flow ${prop.kind} on "${prop.flowName}"`,
            details: { proposalId: prop.id, flowName: prop.flowName, threadId: prop.threadId ?? null },
          });
        }
      }
    }

    if (payloads.length > 0) {
      void dispatchEvents(event.project, payloads).catch(() => undefined);
    }
  }

  const unsubscribe = repo.onMutation(handleMutation);

  function stop(): void {
    unsubscribe();
    for (const timer of mirrorTimers.values()) clearTimeout(timer);
    mirrorTimers.clear();
  }

  return {
    dispatchEvents,
    stop,
  };
}

export function ingestAlert(
  repo: Repository,
  input: {
    project: string;
    key: string;
    message: string;
    source: string;
    severity?: "critical" | "error" | "warning" | "info";
    criterionIds?: string[];
    track?: string;
    actor?: string;
  },
): { projectId: string; key: string; kind: "denies" | "note"; signal: string } {
  const tree = repo.read(input.project);
  const outcome = tree.outcomes.find((o) => o.key === input.key);
  if (!outcome) {
    throw new Error(`Unknown outcome "${input.key}" in project "${input.project}"`);
  }
  const sev = input.severity ?? "error";
  const kind: "denies" | "note" = sev === "critical" || sev === "error" ? "denies" : "note";
  const criterionIds =
    input.criterionIds && input.criterionIds.length > 0
      ? input.criterionIds
      : kind === "denies"
        ? outcome.criteria.map((c) => c.id)
        : [];
  const track = input.track ?? "main";
  repo.act(
    input.project,
    {
      op: "add_evidence",
      key: input.key,
      version: outcome.version,
      kind,
      criterionIds,
      text: `[alert:${sev}] ${input.message.trim()}`,
      source: input.source.startsWith("alert:") ? input.source : `alert:${input.source}`,
      track,
    },
    { actor: input.actor ?? "monitoring", via: "hook" },
  );
  const after = repo.view(input.project, track);
  const signal = after.ranked.find((r) => r.key === input.key)?.signal ?? "unverified";
  return { projectId: input.project, key: input.key, kind, signal };
}
