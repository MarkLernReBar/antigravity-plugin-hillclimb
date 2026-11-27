#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { createRepository, defaultDataDir, openDatabase, type Repository } from "./repository.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createAutoTracker } from "./auto-track.js";
import {
  formatSetupText,
  getClimbCard,
  getClimbList,
  getClimbLog,
  getClimbNotes,
  getClimbStatus,
  getClimbVerdict,
  installEngine,
  resolveRepoDirectory,
  scanProjectClimbs,
  type ScanProjectClimbsOptions,
} from "./repo-ops.js";
import { actionSchema, type Action } from "./actions.js";
import { lintTree } from "./linter.js";
import { previewPromotion } from "./planning.js";
import { writeMirror } from "./mirror.js";
import { ingestJunitReport, postTestEvidenceBundle } from "./ci-ingest.js";
import { runStudyPreview, runStudyReport } from "./studies.js";
import { HillClimbError } from "./errors.js";
import { rigSchema } from "./rig.js";
import { computeInsights } from "./insights.js";
import { ARTIFACT_TEMPLATES, exportShareableReport, generateArtifactFromTemplate, type ArtifactTemplateId } from "./artifacts.js";
import { blueprintActions, listBlueprints, parseMarkdownImport } from "./templates.js";
import { createAutomationEngine, ingestAlert } from "./hooks.js";
import type { Contract, Criterion, Evidence, Outcome, Snapshot, Tree } from "./model.js";
import type { HookEvent, SearchHit } from "./repository.js";

const APP_URI = "ui://hillclimb/app.html";
const OUTPUT_LIMIT = 24_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_TEXT = 4000;
const MAX_EVIDENCE_TEXT = 800;

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const keySchema = z.string().regex(KEY_PATTERN, "keys match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$");

const criterionInputSchema = z.object({
  id: keySchema,
  given: z.string().trim().min(1),
  when: z.string().trim().min(1),
  then: z.string().trim().min(1),
});

const contractInputSchema = z.object({
  title: z.string().trim().min(1),
  story: z.string().trim().min(1),
  criteria: z.array(criterionInputSchema).min(1),
  dependsOn: z.array(keySchema).max(20).default([]),
  rank: z.number().int().nonnegative().default(100),
  recheckDays: z.number().positive().nullable().default(null),
});

function parseDataDirArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir" && argv[i + 1]) return argv[i + 1]!;
    if (arg.startsWith("--data-dir=")) return arg.slice("--data-dir=".length);
    if (arg.startsWith("--data_dir=")) return arg.slice("--data_dir=".length);
  }
  return defaultDataDir();
}

function resolveAppHtml(): string {
  const envPath = process.env.HILLCLIMB_APP_HTML;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...(envPath ? [envPath] : []),
    join(here, "app.html"),
    join(here, "..", "dist", "app.html"),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      continue;
    }
  }
  return `<!doctype html><html><body><p>Hill Climb UI bundle (dist/app.html) not built yet. Run <code>npm run build</code> in the plugin directory.</p></body></html>`;
}

function cap(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n\n[output truncated at ${OUTPUT_LIMIT} characters — narrow the query]`;
}

function windowOf<T>(items: readonly T[], limit: number, offset: number) {
  const total = items.length;
  const start = Math.min(Math.max(offset, 0), total);
  const slice = items.slice(start, start + limit);
  const next = start + slice.length < total ? start + slice.length : null;
  return { total, offset: start, limit, returned: slice.length, hasMore: next !== null, nextOffset: next, items: slice };
}

function bound(text: string, max = MAX_TEXT) {
  const chars = text.length;
  return chars <= max ? { text, chars, truncated: false } : { text: text.slice(0, max), chars, truncated: true };
}

function inboxOf(snapshot: Snapshot) {
  return {
    count: snapshot.inbox,
    pendingChanges: snapshot.changes.filter((change) => change.state === "pending").length,
    openQuestions: snapshot.comments.filter((comment) => comment.answer === null).length,
    pendingFlowChanges: snapshot.flowProposals.filter((proposal) => proposal.state === "pending").length,
  };
}

function outcomeOf(tree: Tree, wanted: string): Outcome {
  const outcome = tree.outcomes.find((row) => row.key === wanted);
  if (outcome === undefined) {
    const known = tree.outcomes.map((row) => row.key);
    throw new Error(
      known.length === 0
        ? "this project has no outcomes yet; create one first"
        : `unknown outcome ${wanted}; this tree has ${known.join(", ")}`,
    );
  }
  return outcome;
}

function isDecision(action: Action): boolean {
  return (
    action.op === "approve_change" ||
    action.op === "reject_change" ||
    action.op === "promote_track" ||
    action.op === "accept_flow_change" ||
    action.op === "reject_flow_change"
  );
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text: cap(text) }] };
}

function jsonResult(data: Record<string, unknown>, textSummary?: string) {
  const text = textSummary ?? JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text: cap(text) }],
    structuredContent: data,
  };
}

function appJsonResult(data: Record<string, unknown>, textSummary = "OK") {
  return {
    content: [{ type: "text" as const, text: cap(textSummary) }],
    structuredContent: data,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof HillClimbError ? error.hint : undefined;
  return {
    content: [{ type: "text" as const, text: hint ? `${message}\n${hint}` : message }],
    isError: true as const,
  };
}

function defaultSessionActor(): string {
  return process.env.ANTIGRAVITY_CONVERSATION_ID || "antigravity-session";
}

export function createHillClimbServer(repo: Repository, runtime: Runtime): McpServer {
  const autoTracker = createAutoTracker(repo);
  createAutomationEngine(repo);
  const projectSettingsOf = (projectId: string) => ({
    autoSyncMirror: repo.getSetting(projectId, "autoSyncMirror") === "true",
    wakeOnAnswer: repo.getSetting(projectId, "wakeOnAnswer") === "true",
    requireApprovalForNewOutcomes: repo.getSetting(projectId, "requireApprovalForNewOutcomes") === "true",
    designKit: repo.getSetting(projectId, "designKit") ?? "",
  });
  const searchWithClimbs = (
    projectId: string | null,
    query: string,
    opts?: { types?: SearchHit["entityType"][]; limit?: number },
  ): SearchHit[] => {
    const base = repo.search(projectId, query, opts);
    const wantClimbs = !opts?.types || opts.types.length === 0 || opts.types.includes("climb");
    if (!wantClimbs || !projectId) return base;
    const dir = repo.getProject(projectId)?.directory ?? null;
    if (!dir) return base;
    const needle = query.trim().toLowerCase();
    if (!needle) return base;
    const scanned = scanProjectClimbs(dir, { rowLimit: 25, includeNotes: true });
    const extra: SearchHit[] = [];
    for (const c of scanned.climbs) {
      const hay = `${c.name} ${c.goal ?? ""} ${c.notes} ${c.rows.map((r) => `${r.idea ?? ""} ${r.why ?? ""}`).join(" ")}`.toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx === -1) continue;
      extra.push({
        project: projectId,
        entityType: "climb",
        entityId: c.id,
        title: `${c.name} (${c.workerLabel})`,
        snippet: `${c.verdict} · ${c.baseline ?? "—"} -> ${c.best ?? "—"} · ${c.goal ?? ""}`.trim(),
        rank: 0,
      });
    }
    return [...base, ...extra].slice(0, opts?.limit ?? 30);
  };
  const scanAndSync = (projectId: string, opts?: ScanProjectClimbsOptions) => {
    const dir = repo.getProject(projectId)?.directory ?? null;
    const scanned = scanProjectClimbs(dir, opts);
    return autoTracker.syncScannedClimbs(projectId, scanned);
  };
  const pickDefaultProject = (projects: ReturnType<Repository["listProjects"]>): string => {
    const envId = process.env.ANTIGRAVITY_PROJECT_ID;
    if (envId && envId !== "outside-of-project" && projects.some((p) => p.id === envId)) {
      return envId;
    }
    // Prefer a project that already has outcomes (most recently active first) using O(1) SQL metadata
    const summaries = new Map(repo.projectSummaries().map((s) => [s.project, s]));
    let bestPopulated: { id: string; score: number } | null = null;
    for (const p of projects) {
      const meta = summaries.get(p.id);
      if (meta && (meta.outcomeCount > 0 || meta.goalCount > 0)) {
        const lastAt = meta.lastActivityAt ? Date.parse(meta.lastActivityAt) || 0 : 0;
        const score = lastAt > 0 ? lastAt : meta.outcomeCount;
        if (!bestPopulated || score > bestPopulated.score) {
          bestPopulated = { id: p.id, score };
        }
      }
    }
    if (bestPopulated) return bestPopulated.id;
    // Otherwise prefer a project with an actual linked repository directory
    const withDir = projects.find((p) => Boolean(p.directory));
    if (withDir) return withDir.id;
    return projects[0]?.id ?? repo.resolveProjectId();
  };
  const server = new McpServer(
    { name: "hillclimb", version: "0.5.1" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // -------------------------------------------------------------------------
  // MCP App UI Resource
  // -------------------------------------------------------------------------

  registerAppResource(
    server,
    "Hill Climb Workspace",
    APP_URI,
    {
      title: "Hill Climb",
      description: "Interactive Hill Climb workspace: outcome map & outline, inbox approvals, roadmap, flows, live score charts, and verifier editor.",
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: resolveAppHtml(),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  // -------------------------------------------------------------------------
  // UI Entrypoint Tool (aux_pane + global + inline)
  // -------------------------------------------------------------------------

  registerAppTool(
    server,
    "hillclimb_open",
    {
      title: "Hill Climb",
      description: "Open interactive Hill Climb UI (outcomes, climbs, inbox, roadmap, flows, insights, reports).",
      inputSchema: {
        projectId: z.string().optional(),
        page: z.enum(["tree", "climbs", "inbox", "roadmap", "flows", "insights", "reports"]).optional(),
        outcomeKey: z.string().optional(),
        track: z.string().optional(),
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "Hill Climb" },
            { type: "global", title: "Hill Climb" },
          ],
        },
      },
    },
    async (args) => {
      try {
        const projects = repo.listProjects();
        const chosen = args.projectId
          ? repo.resolveProjectId(args.projectId)
          : pickDefaultProject(projects);
        const track = args.track ?? "main";
        const repoClimbs = scanAndSync(chosen, { rowLimit: 25, includeNotes: false });
        const tree = repo.view(chosen, track);
        const inboxCount = repo.inboxCountTotal();
        const defaultPage = args.page ?? (tree.outcomes.length === 0 && repoClimbs.climbs.length > 0 ? "climbs" : "tree");
        const payload = {
          projects,
          projectId: chosen,
          page: defaultPage,
          outcomeKey: args.outcomeKey ?? null,
          track,
          tree,
          repoClimbs,
          inboxCount,
          views: repo.listViews(chosen),
          scopes: repo.listScopes(chosen),
          settings: projectSettingsOf(chosen),
        };
        const summary = `Opened Hill Climb for project "${chosen}" (${tree.outcomes.length} outcomes, ${repoClimbs.climbs.length} repo climb(s), ${tree.next.length} ready next, ${tree.inbox} inbox item(s)).`;
        return appJsonResult(payload, summary);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Repo Engine Tools (model-visible)
  // -------------------------------------------------------------------------

  server.registerTool(
    "hillclimb_setup",
    {
      title: "Install engine",
      description: "Install climb.py, judge.py, and 5 kits into `.hill-climb/` and exclude it in `.git/info/exclude`.",
      inputSchema: {
        directory: z.string().min(1).max(1024).optional(),
      },
    },
    async ({ directory }) => {
      try {
        const dir = resolveRepoDirectory(directory);
        const result = installEngine(dir);
        return textResult(formatSetupText(result, dir));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_status",
    {
      title: "Climb status",
      description: "Read climb score, bar, trail, and verdict from card.json/log.jsonl without running checks.",
      inputSchema: {
        name: z.string().min(1).max(64).optional(),
        directory: z.string().min(1).max(1024).optional(),
        last: z.number().int().min(0).max(200).optional(),
        format: z.enum(["compact", "full"]).default("compact"),
      },
    },
    async ({ name, directory, last, format }) => {
      try {
        const dir = resolveRepoDirectory(directory);
        const rowCount = last ?? (format === "full" ? 15 : 10);
        const res = getClimbStatus(dir, name, rowCount);
        if (format === "full") {
          return jsonResult({ directory: dir, engine: res.engine, ...res.summary }, res.textWithNext);
        }
        const { recent: _recent, ...compactSummary } = res.summary;
        return jsonResult(
          { directory: dir, engine: res.engine, ...compactSummary, recentCount: res.summary.recent.length },
          res.textWithNext,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_card",
    {
      title: "Climb card",
      description: "Read climb rig from card.json (check, guards, holdout, locked paths).",
      inputSchema: {
        name: z.string().min(1).max(64).optional(),
        directory: z.string().min(1).max(1024).optional(),
      },
    },
    async ({ name, directory }) => {
      try {
        const dir = resolveRepoDirectory(directory);
        const res = getClimbCard(dir, name);
        return jsonResult(res.data, res.text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_list",
    {
      title: "List climbs",
      description: "List climbs across repo and linked worktrees.",
      inputSchema: {
        directory: z.string().min(1).max(1024).optional(),
        includeWorktrees: z.boolean().default(true),
        includeRows: z.boolean().default(false),
        includeNotes: z.boolean().default(false),
      },
    },
    async ({ directory, includeWorktrees, includeRows, includeNotes }) => {
      try {
        const dir = resolveRepoDirectory(directory);
        if (includeWorktrees) {
          const scanned = scanProjectClimbs(dir, {
            rowLimit: includeRows ? 50 : 0,
            includeNotes,
          });
          const text =
            scanned.climbs.length === 0
              ? `No climbs in ${dir} (checked ${scanned.worktreesScanned} linked worktree(s)).`
              : scanned.climbs
                  .map((c) =>
                    c.status === "active"
                      ? `${c.name} (${c.isMainCheckout ? "main" : c.worktreeName}): ${c.baseline} -> ${c.best} (${c.direction}), ${c.steps} steps [${c.verdict}]`
                      : `${c.name} (${c.isMainCheckout ? "main" : c.worktreeName}): preparing (${c.preparedFiles} staged files, awaiting climb.py init)`,
                  )
                  .join("\n");
          const payload =
            includeRows || includeNotes
              ? (scanned as unknown as Record<string, unknown>)
              : ({
                  ...scanned,
                  climbs: scanned.climbs.map(({ rows: _rows, notes: _notes, ...rest }) => rest),
                } as unknown as Record<string, unknown>);
          return jsonResult(payload, text);
        }
        const res = getClimbList(dir);
        return jsonResult({ directory: dir, climbs: res.climbs, prepared: res.prepared }, res.text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_log",
    {
      title: "Climb log/notes",
      description: "Read log.jsonl, notes.md, or verdict for a repo climb.",
      inputSchema: {
        mode: z.enum(["log", "notes", "verdict"]).default("log"),
        name: z.string().min(1).max(64).optional(),
        directory: z.string().min(1).max(1024).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ mode, name, directory, limit }) => {
      try {
        const dir = resolveRepoDirectory(directory);
        if (mode === "notes") return textResult(getClimbNotes(dir, name));
        if (mode === "verdict") return textResult(getClimbVerdict(dir, name));
        const res = getClimbLog(dir, name, limit ?? 40);
        return jsonResult({ name: res.name, rows: res.rows }, res.text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Outer Loop: Projects, Contract Tree, Workflow Tools (model-visible)
  // -------------------------------------------------------------------------

  server.registerTool(
    "hillclimb_projects",
    {
      title: "Projects",
      description: "List or register Hill Climb projects.",
      inputSchema: {
        registerDirectory: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
      },
    },
    async ({ registerDirectory, id, name }) => {
      try {
        if (registerDirectory) {
          const registered = repo.registerProject({ id, name, directory: registerDirectory });
          return jsonResult({ registered, projects: repo.listProjects() });
        }
        return jsonResult({ projects: repo.listProjects() });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_tree",
    {
      title: "Contract tree",
      description: "Read ranked outcomes, next work, and inbox (or one outcome via `key`).",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: z.string().optional(),
        track: z.string().optional(),
        tag: z.string().optional(),
        scope: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        evidenceLimit: z.number().int().min(1).max(MAX_LIMIT).default(20),
        commentLimit: z.number().int().min(1).max(MAX_LIMIT).default(20),
      },
    },
    async ({ projectId, directory, key, track, tag, scope, limit, offset, evidenceLimit, commentLimit }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        const trackName = track ?? "main";
        scanAndSync(pid);
        const s = repo.view(pid, trackName);
        if (key && !s.outcomes.some((o) => o.key === key)) {
          throw new Error("Unknown outcome " + key);
        }
        if (key) {
          const allPlans = s.plans.filter((p) => p.key === key);
          const allEvidence = s.evidence.filter((e) => e.key === key && e.track === trackName);
          const allComments = s.comments.filter((c) => c.key === key);
          const plans = allPlans.slice(-5).map((p) => ({
            ...p,
            body: bound(p.body, MAX_TEXT).text,
            bodyTruncated: p.body.length > MAX_TEXT,
          }));
          const evidence = allEvidence.slice(-evidenceLimit).map((e) => ({
            ...e,
            text: bound(e.text, MAX_EVIDENCE_TEXT).text,
            textTruncated: e.text.length > MAX_EVIDENCE_TEXT,
          }));
          const comments = allComments.slice(-commentLimit).map((c) => ({
            ...c,
            text: bound(c.text, MAX_EVIDENCE_TEXT).text,
            textTruncated: c.text.length > MAX_EVIDENCE_TEXT,
          }));
          return jsonResult({
            projectId: pid,
            track: trackName,
            contract: s.outcomes.find((o) => o.key === key),
            rank: s.ranked.find((o) => o.key === key),
            plans,
            evidence,
            comments,
            counts: { plans: allPlans.length, evidence: allEvidence.length, comments: allComments.length },
            inbox: s.inbox,
          });
        }
        const scopeKeys = scope ? repo.resolveScopeOutcomeKeys(pid, scope, s) : null;
        const rankedAll = s.ranked
          .filter((r) => (!scopeKeys || scopeKeys.has(r.key)) && (!tag || (r.tags ?? []).includes(tag)))
          .map(({ key: k, signal, blockedBy, claim, availability, availabilityReason, tags, sectionNumber }) => ({
            key: k,
            signal,
            blockedBy,
            claim,
            availability,
            availabilityReason,
            tags,
            sectionNumber,
          }));
        const page = windowOf(rankedAll, limit, offset);
        const allowedNext = new Set(rankedAll.map((r) => r.key));
        return jsonResult({
          projectId: pid,
          track: trackName,
          goals: s.goals,
          ranked: page.items,
          pagination: {
            total: page.total,
            offset: page.offset,
            limit: page.limit,
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
          },
          next: s.next.filter((k) => allowedNext.has(k)),
          inbox: s.inbox,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_next_outcomes",
    {
      title: "Next outcomes",
      description: "Rank-ordered `next` queue (unblocked, unclaimed, active) plus inbox counts.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        track: z.string().optional(),
        scope: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        offset: z.number().int().min(0).default(0),
        includeContract: z.boolean().default(false),
        includeBlocked: z.boolean().default(false),
      },
    },
    async ({ projectId, directory, track, scope, tag, limit, offset, includeContract, includeBlocked }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        const trackName = track ?? "main";
        scanAndSync(pid);
        const snapshot = repo.view(pid, trackName);
        const activeScope = scope ?? repo.listScopes(pid).find((s) => s.active)?.name ?? null;
        const scopeKeys = activeScope ? repo.resolveScopeOutcomeKeys(pid, activeScope, snapshot) : null;
        const outcomeByKey = new Map(snapshot.outcomes.map((row) => [row.key, row]));
        const rankByKey = new Map(snapshot.ranked.map((row) => [row.key, row]));
        const matchesFilter = (wanted: string) => {
          if (scopeKeys && !scopeKeys.has(wanted)) return false;
          if (tag && !(rankByKey.get(wanted)?.tags ?? []).includes(tag)) return false;
          return true;
        };
        const formatRow = (wanted: string) => {
          const rank = rankByKey.get(wanted);
          const outcome = outcomeByKey.get(wanted);
          return {
            key: wanted,
            title: outcome?.title ?? wanted,
            goalKey: outcome?.goalKey ?? null,
            sectionNumber: rank?.sectionNumber ?? "",
            version: outcome?.version ?? null,
            signal: rank?.signal ?? "unverified",
            availability: rank?.availability ?? "active",
            availabilityReason: rank?.availabilityReason ?? null,
            deferredUntil: rank?.deferredUntil ?? null,
            tags: rank?.tags ?? [],
            blockedBy: rank?.blockedBy ?? [],
            claim: rank?.claim ?? null,
            ...(includeContract && outcome
              ? { story: outcome.story, criteria: outcome.criteria, dependsOn: outcome.dependsOn }
              : {}),
          };
        };
        const rows = snapshot.next.filter(matchesFilter).map(formatRow);
        const counts: Record<string, number> = {};
        for (const rank of snapshot.ranked) counts[rank.signal] = (counts[rank.signal] ?? 0) + 1;
        const blocked = includeBlocked
          ? snapshot.ranked
              .filter(
                (r) =>
                  matchesFilter(r.key) &&
                  r.signal !== "verified" &&
                  (r.blockedBy.length > 0 || (r.availability ?? "active") !== "active"),
              )
              .map((r) => formatRow(r.key))
          : undefined;
        return jsonResult({
          projectId: pid,
          track: trackName,
          activeScope,
          queue: windowOf(rows, limit, offset),
          ...(includeBlocked ? { blocked: windowOf(blocked ?? [], limit, 0) } : {}),
          outcomeCount: snapshot.outcomes.length,
          bySignal: counts,
          inbox: inboxOf(snapshot),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_outcome",
    {
      title: "Inspect one outcome",
      description:
        "One outcome in full: its contract and version, goal chain, derived signal, live claim, latest plan, and paged evidence & comments.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        track: z.string().optional(),
        evidenceLimit: z.number().int().min(1).max(MAX_LIMIT).default(10),
        evidenceOffset: z.number().int().min(0).default(0),
        commentLimit: z.number().int().min(1).max(MAX_LIMIT).default(10),
        commentOffset: z.number().int().min(0).default(0),
        planChars: z.number().int().min(1).max(MAX_TEXT).default(MAX_TEXT),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const trackName = input.track ?? "main";
        const tree = repo.read(pid);
        const outcome = outcomeOf(tree, input.key);
        const snapshot = repo.view(pid, trackName);
        const rank = snapshot.ranked.find((row) => row.key === input.key);
        const evidence = tree.evidence
          .filter((row) => row.key === input.key && row.track === trackName)
          .map((row) => ({
            id: row.id,
            version: row.version,
            kind: row.kind,
            criterionIds: row.criterionIds,
            source: row.source,
            created: row.created,
            text: bound(row.text, MAX_EVIDENCE_TEXT),
          }));
        const comments = tree.comments
          .filter((row) => row.key === input.key)
          .map((row) => ({
            id: row.id,
            parentId: row.parentId,
            text: bound(row.text, MAX_EVIDENCE_TEXT),
            options: row.options,
            answer: row.answer,
            created: row.created,
          }));
        const plans = tree.plans.filter((row) => row.key === input.key);
        const latest = plans.reduce<(typeof plans)[number] | null>(
          (best, row) => (best === null || row.version > best.version ? row : best),
          null,
        );
        const linkedFlows = tree.flows.flatMap((flow) =>
          flow.frames
            .map((frame, frameIndex) => ({ flow, frame, frameIndex }))
            .filter(({ frame }) => frame.key === input.key)
            .map(({ flow, frame, frameIndex }) => ({
              flowName: flow.name,
              folder: flow.folder ?? null,
              designKit: flow.designKit ?? repo.getSetting(pid, "designKit") ?? null,
              frameIndex,
              title: frame.title,
              criterionId: frame.criterionId,
              kind: frame.kind ?? "html",
              version: frame.version ?? 1,
              imagePath: frame.imagePath ?? null,
              viewport: frame.viewport ?? null,
              notes: frame.notes ?? null,
              driftDetected: Boolean(frame.driftDetected),
              openAgentPins: frame.pins.filter((p) => !p.resolved && (p.forAgents ?? true)),
            })),
        );
        return jsonResult({
          projectId: pid,
          track: trackName,
          key: outcome.key,
          version: outcome.version,
          sectionNumber: rank?.sectionNumber ?? "",
          availability: rank?.availability ?? "active",
          availabilityReason: rank?.availabilityReason ?? null,
          deferredUntil: rank?.deferredUntil ?? null,
          tags: rank?.tags ?? [],
          contract: {
            title: outcome.title,
            story: outcome.story,
            criteria: outcome.criteria,
            dependsOn: outcome.dependsOn,
            rank: outcome.rank,
            recheckDays: outcome.recheckDays,
            tags: outcome.tags ?? [],
          },
          goalChain: rank?.ancestors.map((goal) => ({ key: goal.key, title: goal.title, brief: goal.brief })) ?? [],
          signal: rank?.signal ?? "unverified",
          blockedBy: rank?.blockedBy ?? [],
          claim: rank?.claim ?? null,
          plan: latest === null ? null : { version: latest.version, created: latest.created, body: bound(latest.body, input.planChars) },
          planVersions: plans.map((row) => row.version).sort((a, b) => a - b),
          evidence: windowOf(evidence, input.evidenceLimit, input.evidenceOffset),
          comments: windowOf(comments, input.commentLimit, input.commentOffset),
          linkedFlows,
          pendingChange: snapshot.changes.filter((change) => change.key === input.key && change.state === "pending").at(-1) ?? null,
          pendingFlowProposals: snapshot.flowProposals.filter(
            (p) => p.state === "pending" && (p.frame?.key === input.key || (p.frames ?? []).some((f) => f.key === input.key)),
          ),
          inbox: inboxOf(snapshot),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_act",
    {
      title: "Tree action",
      description: "Apply one or batched tree action(s) (`op` JSON). Human decisions (`approve_change`, `reject_change`, `accept_flow_change`, `reject_flow_change`, `promote_track`) require UI confirmation.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        action: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
        actions: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).min(1).max(50).optional(),
      },
    },
    async ({ projectId, directory, action, actions }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        const rawList = actions ?? (action !== undefined ? [action] : []);
        if (rawList.length === 0) {
          throw new Error("Pass `action` or a non-empty `actions` array.");
        }
        const requireApproval = repo.getSetting(pid, "requireApprovalForNewOutcomes") === "true";
        const parsedList = rawList.map((item) => {
          const raw = typeof item === "string" ? JSON.parse(item) : item;
          const parsed = actionSchema.parse(raw);
          if (isDecision(parsed)) {
            throw new HillClimbError("Review this decision in the Hill Climb UI inbox (human confirmation required).", {
              code: "human_decision_required",
              hint: "Call hillclimb_open with page='inbox', 'flows', or 'roadmap' so the user can review and confirm.",
            });
          }
          if (requireApproval && parsed.op === "create_outcome") {
            throw new HillClimbError("This project requires human approval for new outcomes.", {
              code: "approval_required_for_new_outcome",
              hint: "Use op='propose_outcome' instead so the user can approve it in the Inbox.",
            });
          }
          return parsed;
        });
        const meta = { actor: defaultSessionActor(), via: "mcp" as const };
        if (parsedList.length === 1) {
          repo.act(pid, parsedList[0]!, meta);
        } else {
          repo.actBatch(pid, parsedList, meta);
        }
        const view = repo.view(pid);
        const createdKeys = new Set(
          parsedList
            .filter((p): p is Extract<Action, { op: "create_goal" | "create_outcome" }> => p.op === "create_goal" || p.op === "create_outcome")
            .map((p) => p.key),
        );
        return jsonResult({
          ok: true,
          projectId: pid,
          applied: parsedList.length,
          inbox: view.inbox,
          ...(createdKeys.size > 0
            ? { lint: lintTree(view).findings.filter((f) => createdKeys.has(f.itemKey)) }
            : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_propose_change",
    {
      title: "Propose edit",
      description: "File a pending contract edit for human review in Inbox.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        contract: z.record(z.string(), z.unknown()),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const tree = repo.read(pid);
        const outcome = outcomeOf(tree, input.key);
        const parsedContract = contractInputSchema.parse(input.contract);
        const contract: Contract = {
          title: parsedContract.title,
          story: parsedContract.story,
          criteria: parsedContract.criteria as Criterion[],
          dependsOn: parsedContract.dependsOn,
          rank: parsedContract.rank,
          recheckDays: parsedContract.recheckDays,
        };
        repo.act(pid, { op: "propose_change", key: input.key, version: outcome.version, contract });
        const after = repo.view(pid, "main");
        const pending = after.changes.filter((change) => change.key === input.key && change.state === "pending").at(-1);
        return jsonResult({
          projectId: pid,
          proposed: pending?.id ?? null,
          key: input.key,
          baseVersion: outcome.version,
          state: pending?.state ?? "unknown",
          approved: false,
          next: "A person reviews this in the Hill Climb Inbox; nothing about the outcome changed yet.",
          inbox: inboxOf(after),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_lint_tree",
    {
      title: "Lint contract tree (22 rules)",
      description:
        "Apply the 22-rule contract writing rubric (O1-O6, C1-C9, G1-G4, P1-P3) to this project's goals and outcomes. Read-only.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema.optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        offset: z.number().int().min(0).default(0),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const tree = repo.read(pid);
        const outcomes = input.key === undefined ? tree.outcomes : [outcomeOf(tree, input.key)];
        const version = outcomes.reduce<number | null>(
          (best, row) => (best === null || row.version > best ? row.version : best),
          null,
        );
        const result = lintTree({
          goals: tree.goals,
          outcomes,
          ...(version !== null ? { contractVersion: version } : {}),
        });
        const findings = result.findings.map((finding) => ({
          id: finding.id,
          itemKey: finding.itemKey,
          itemType: finding.itemType,
          criterionId: finding.criterionId ?? null,
          checkCode: finding.checkCode,
          checkTitle: finding.checkTitle,
          severity: finding.severity,
          now: finding.now,
          issue: finding.issue,
          proposed: finding.proposed,
          movesTo: finding.movesTo,
        }));
        return jsonResult({
          projectId: pid,
          passed: result.passed,
          errorCount: result.errorCount,
          warningCount: result.warningCount,
          contractVersion: version,
          scope: input.key ?? "tree",
          findings: windowOf(findings, input.limit, input.offset),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_claim",
    {
      title: "Claim outcome lease",
      description: "Take a time-boxed lease on an outcome so two agents do not climb the same one.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        hours: z.number().positive().max(168).default(4),
        threadId: z.string().optional().describe("Lease holder ID (defaults to current conversation ID)"),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const holder = input.threadId ?? defaultSessionActor();
        outcomeOf(repo.read(pid), input.key);
        repo.act(pid, { op: "claim_outcome", key: input.key, threadId: holder, hours: input.hours });
        const after = repo.view(pid, "main");
        const rank = after.ranked.find((r) => r.key === input.key);
        return jsonResult({ projectId: pid, key: input.key, claim: rank?.claim ?? null, inbox: inboxOf(after) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_release",
    {
      title: "Release outcome lease",
      description: "Release this session's lease on an outcome.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        threadId: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const holder = input.threadId ?? defaultSessionActor();
        outcomeOf(repo.read(pid), input.key);
        repo.act(pid, { op: "release_outcome", key: input.key, threadId: holder });
        const after = repo.view(pid, "main");
        const rank = after.ranked.find((r) => r.key === input.key);
        return jsonResult({ projectId: pid, key: input.key, claim: rank?.claim ?? null, inbox: inboxOf(after) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_plan_write",
    {
      title: "Write or revise outcome plan",
      description: "Write version 1 or append a revised full-text implementation plan for an outcome.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        body: z.string().trim().min(1),
        version: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const tree = repo.read(pid);
        outcomeOf(tree, input.key);
        const plans = tree.plans.filter((row) => row.key === input.key);
        const latest = plans.reduce<(typeof plans)[number] | null>(
          (best, row) => (best === null || row.version > best.version ? row : best),
          null,
        );
        const action: Action =
          latest === null
            ? { op: "write_plan", key: input.key, body: input.body }
            : { op: "revise_plan", key: input.key, version: input.version ?? latest.version, body: input.body };
        repo.act(pid, action);
        const after = repo.view(pid, "main");
        const written = after.plans
          .filter((row) => row.key === input.key)
          .reduce<(typeof after.plans)[number] | null>((best, row) => (best === null || row.version > best.version ? row : best), null);
        return jsonResult({
          projectId: pid,
          key: input.key,
          planVersion: written?.version ?? null,
          created: written?.created ?? null,
          chars: input.body.length,
          inbox: inboxOf(after),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_comment",
    {
      title: "Post comment, question, or answer",
      description: "Post a comment or multi-option decision question on an outcome, or record a user's answer to an open question.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema.optional(),
        text: z.string().trim().min(1).optional(),
        options: z.array(z.string().trim().min(1)).max(8).default([]),
        parentId: z.string().trim().min(1).nullable().default(null),
        planVersion: z.number().int().positive().nullable().optional().describe("Optional plan version this comment refers to"),
        answer: z.object({ id: z.string().trim().min(1), answer: z.string().trim().min(1) }).optional(),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const actor = defaultSessionActor();
        if (input.answer !== undefined) {
          repo.act(pid, { op: "answer", id: input.answer.id, answer: input.answer.answer }, { actor, via: "mcp" });
          const after = repo.view(pid, "main");
          const answered = after.comments.find((c) => c.id === input.answer?.id);
          return jsonResult({
            projectId: pid,
            answered: input.answer.id,
            key: answered?.key ?? null,
            answer: answered?.answer ?? null,
            inbox: inboxOf(after),
          });
        }
        if (input.key === undefined || input.text === undefined) {
          throw new Error("pass either `answer: {id, answer}`, or `key` and `text` to post a comment");
        }
        outcomeOf(repo.read(pid), input.key);
        repo.act(
          pid,
          {
            op: "comment",
            key: input.key,
            text: input.text,
            options: input.options,
            parentId: input.parentId,
            planVersion: input.planVersion ?? null,
            threadId: input.options.length > 0 ? actor : null,
          },
          { actor, via: "mcp" },
        );
        const after = repo.view(pid, "main");
        const posted = after.comments.filter((c) => c.key === input.key).at(-1);
        return jsonResult({
          projectId: pid,
          comment: posted?.id ?? null,
          key: input.key,
          isQuestion: input.options.length > 0,
          inbox: inboxOf(after),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_inbox",
    {
      title: "Read approval inbox",
      description: "Read pending contract changes waiting for human approval and open questions waiting for answers.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema.optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        offset: z.number().int().min(0).default(0),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const snapshot = repo.view(pid, "main");
        const inScope = (wanted: string) => input.key === undefined || wanted === input.key;
        const changes = snapshot.changes
          .filter((change) => change.state === "pending" && inScope(change.key))
          .map((change) => {
            const outcome = snapshot.outcomes.find((row) => row.key === change.key);
            return {
              id: change.id,
              key: change.key,
              baseVersion: change.baseVersion,
              currentVersion: outcome?.version ?? null,
              title: change.proposed.title,
              created: change.created,
              review: "approve_change / reject_change are confirmed by a person in the Hill Climb UI",
            };
          });
        const questions = snapshot.comments
          .filter((comment) => comment.answer === null && inScope(comment.key))
          .map((comment) => ({
            id: comment.id,
            key: comment.key,
            parentId: comment.parentId,
            text: bound(comment.text, MAX_EVIDENCE_TEXT),
            options: comment.options,
            created: comment.created,
          }));
        const flowProposals = snapshot.flowProposals
          .filter(
            (proposal) =>
              proposal.state === "pending" &&
              (input.key === undefined ||
                proposal.frame?.key === input.key ||
                (proposal.frames ?? []).some((f) => f.key === input.key)),
          )
          .map((proposal) => ({
            id: proposal.id,
            kind: proposal.kind,
            flowName: proposal.flowName,
            frameIndex: proposal.frameIndex,
            basedOnVersion: proposal.basedOnVersion,
            selfGrade: proposal.selfGrade ?? null,
            ref: proposal.ref ?? null,
            note: proposal.note ?? null,
            created: proposal.created,
            review: "accept_flow_change / reject_flow_change are confirmed by a person in the Hill Climb UI",
          }));
        return jsonResult({
          projectId: pid,
          scope: input.key ?? "project",
          inbox: inboxOf(snapshot),
          changes: windowOf(changes, input.limit, input.offset),
          questions: windowOf(questions, input.limit, input.offset),
          flowProposals: windowOf(flowProposals, input.limit, input.offset),
          next: windowOf(snapshot.next, input.limit, input.offset),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_add_evidence",
    {
      title: "Add evidence",
      description: "Record version-scoped `confirms`, `denies`, or `note` evidence on an outcome.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        kind: z.enum(["confirms", "denies", "note"]),
        criterionIds: z.array(keySchema).default([]),
        text: z.string().trim().min(1),
        source: z.string().trim().min(1),
        attachments: z.array(z.record(z.string(), z.unknown())).max(12).optional(),
        track: z.string().optional(),
        version: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const trackName = input.track ?? "main";
        const tree = repo.read(pid);
        const outcome = outcomeOf(tree, input.key);
        const version = input.version ?? outcome.version;
        if (version !== outcome.version) {
          throw new Error(`evidence for ${input.key} v${version} is not evidence for v${outcome.version}`);
        }
        const known = outcome.criteria.map((c) => c.id);
        const unknown = input.criterionIds.filter((id) => !known.includes(id));
        if (unknown.length > 0) {
          throw new Error(`criterion ${unknown.join(", ")} is not in ${input.key} v${outcome.version}`);
        }
        if (new Set(input.criterionIds).size !== input.criterionIds.length) {
          throw new Error("duplicate criterion ids in evidence");
        }
        if (!tree.tracks.some((row) => row.name === trackName)) {
          throw new Error(`unknown track ${trackName}`);
        }
        const parsedAttachments = input.attachments
          ? input.attachments.map((a) => ({
              label: String(a.label ?? "Attachment"),
              path: String(a.path ?? ""),
              ...(typeof a.mimeType === "string" ? { mimeType: a.mimeType } : {}),
            }))
          : undefined;
        repo.act(
          pid,
          {
            op: "add_evidence",
            key: input.key,
            version,
            kind: input.kind,
            criterionIds: input.criterionIds,
            text: input.text,
            source: input.source,
            ...(parsedAttachments ? { attachments: parsedAttachments } : {}),
            track: trackName,
          },
          { actor: defaultSessionActor(), via: "mcp" },
        );
        const after = repo.view(pid, trackName);
        return jsonResult({
          projectId: pid,
          key: input.key,
          version,
          kind: input.kind,
          criterionIds: input.criterionIds,
          track: trackName,
          signal: after.ranked.find((r) => r.key === input.key)?.signal ?? "unverified",
          evidence: after.evidence.filter((row) => row.key === input.key).at(-1)?.id ?? null,
          inbox: inboxOf(after),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_set_status",
    {
      title: "Set status",
      description: "Record `verified` (citing confirming evidenceIds) or `broken` (writes `denies`).",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        status: z.enum(["verified", "broken"]),
        evidenceIds: z.array(z.string().trim().min(1)).default([]),
        criterionIds: z.array(keySchema).default([]),
        text: z.string().trim().min(1).optional(),
        source: z.string().trim().min(1).optional(),
        track: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const trackName = input.track ?? "main";
        const tree = repo.read(pid);
        const outcome = outcomeOf(tree, input.key);
        const snapshot = repo.view(pid, trackName);
        const signal = snapshot.ranked.find((r) => r.key === input.key)?.signal ?? "unverified";
        const criteria = outcome.criteria.map((c) => c.id);
        const actor = defaultSessionActor();

        if (input.status === "verified") {
          if (signal !== "verified" && signal !== "recheck") {
            throw new Error(`${input.key} derives ${signal} at v${outcome.version}, not verified; record criterion-bound confirms evidence first.`);
          }
          if (input.evidenceIds.length === 0) {
            throw new Error("name the confirming evidence ids this status rests on (evidenceIds)");
          }
          const cited = input.evidenceIds.map((id) => {
            const row = tree.evidence.find((e) => e.id === id && e.key === input.key);
            if (!row) throw new Error(`no evidence ${id} on ${input.key}`);
            return row as Evidence;
          });
          for (const row of cited) {
            if (row.version !== outcome.version) throw new Error(`evidence ${row.id} is for v${row.version}, not v${outcome.version}`);
            if (row.kind !== "confirms") throw new Error(`evidence ${row.id} is a ${row.kind}, not a confirms`);
            if (row.track !== trackName) throw new Error(`evidence ${row.id} is on track ${row.track}, not ${trackName}`);
          }
          const covered = new Set<string>();
          for (const row of cited) {
            if (row.criterionIds.length === 0) criteria.forEach((id) => covered.add(id));
            else row.criterionIds.forEach((id) => covered.add(id));
          }
          const uncovered = criteria.filter((id) => !covered.has(id));
          if (uncovered.length > 0) {
            throw new Error(`the cited evidence still lacks ${uncovered.join(", ")}`);
          }
          repo.act(pid, {
            op: "add_evidence",
            key: input.key,
            version: outcome.version,
            kind: "note",
            criterionIds: [],
            text: `Status verified recorded at v${outcome.version} on ${cited.map((r) => r.id).join(", ")}.`,
            source: `status:verified:${actor}`,
            track: trackName,
          });
          const after = repo.view(pid, trackName);
          return jsonResult({
            projectId: pid,
            key: input.key,
            status: "verified",
            recorded: "note",
            restsOn: cited.map((r) => r.id),
            criteria,
            signal: after.ranked.find((r) => r.key === input.key)?.signal ?? "unverified",
            inbox: inboxOf(after),
          });
        }

        if (!input.text) throw new Error("say what broke: pass `text` describing the failing evidence");
        const criterionIds = input.criterionIds.length > 0 ? input.criterionIds : criteria;
        const unknown = criterionIds.filter((id) => !criteria.includes(id));
        if (unknown.length > 0) throw new Error(`criterion ${unknown.join(", ")} is not in ${input.key} v${outcome.version}`);
        repo.act(pid, {
          op: "add_evidence",
          key: input.key,
          version: outcome.version,
          kind: "denies",
          criterionIds,
          text: input.text,
          source: input.source ?? `status:broken:${actor}`,
          track: trackName,
        });
        const after = repo.view(pid, trackName);
        return jsonResult({
          projectId: pid,
          key: input.key,
          status: "broken",
          recorded: "denies",
          criterionIds,
          signal: after.ranked.find((r) => r.key === input.key)?.signal ?? "unverified",
          inbox: inboxOf(after),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_sync",
    {
      title: "Sync .hillclimb/ markdown mirror",
      description: "Export a readable `.hillclimb/` projection (INDEX.md, tree.json, goals/, outcomes/, plans/) into the project workspace.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional().describe("Repository path where `.hillclimb/` will be written"),
      },
    },
    async ({ projectId, directory }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        const target = directory ?? repo.getProject(pid)?.directory;
        if (!target) {
          throw new HillClimbError(`Project ${pid} has no registered directory; pass directory.`, { code: "missing_directory" });
        }
        const result = await writeMirror(target, repo.view(pid), {
          artifacts: repo.listArtifacts(pid),
          scannedClimbs: scanProjectClimbs(target, { rowLimit: 10, includeNotes: true }),
        });
        return jsonResult({ projectId: pid, ...result });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Verifier Rigs, Dispatch, Live Search & Receipts (model-visible)
  // -------------------------------------------------------------------------

  server.registerTool(
    "hillclimb_rig",
    {
      title: "Verifier rig",
      description: "Read or save version-bound `repo` or `search` verifier rig.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        engine: z.enum(["repo", "search"]),
        rig: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ projectId, directory, key, engine, rig }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        if (rig) {
          const parsedRig = rigSchema.parse(rig);
          const outcome = outcomeOf(repo.read(pid), key);
          const saved = runtime.saveRig(pid, key, outcome.version, parsedRig);
          return jsonResult({ projectId: pid, key, saved, rig: runtime.getRig(pid, key, engine) });
        }
        return jsonResult({ projectId: pid, key, engine, rig: runtime.getRig(pid, key, engine) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_search_start",
    {
      title: "Start climb",
      description: "Dispatch a repo climb or evolutionary search worker for an outcome.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        engine: z.enum(["repo", "search"]).default("search"),
        track: z.string().optional(),
      },
    },
    async ({ projectId, directory, key, engine, track }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        const trackName = track ?? "main";
        const result = await runtime.dispatch(pid, key, engine, trackName, { directory });
        return jsonResult({
          projectId: pid,
          key,
          track: trackName,
          engine,
          ...result,
          next: "Read progress with hillclimb_search_status; collect verified proof with hillclimb_search_summit.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_search_status",
    {
      title: "Live search status",
      description: "Read live climb/search baseline, best, target, steps, MAP-Elites cells, and worker status.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        track: z.string().optional(),
        rowsLimit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        rowsOffset: z.number().int().min(0).default(0),
      },
    },
    async ({ projectId, directory, key, track, rowsLimit, rowsOffset }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        const trackName = track ?? "main";
        scanAndSync(pid);
        const snapshot = repo.view(pid, trackName);
        outcomeOf(repo.read(pid), key);
        const live = await runtime.live(pid, key, trackName);
        const worker = runtime.run(pid, key, trackName);
        return jsonResult({
          projectId: pid,
          key,
          track: trackName,
          worker,
          signal: snapshot.ranked.find((r) => r.key === key)?.signal ?? "unverified",
          engine: live.engine,
          baseline: live.baseline,
          best: live.best,
          target: live.target,
          remaining: live.best === null || live.target === null ? null : Number((live.best - live.target).toFixed(6)),
          holdout: live.holdout,
          search: live.search ?? null,
          elite: live.elite ?? [],
          rows: windowOf(live.rows, rowsLimit, rowsOffset),
          inbox: inboxOf(snapshot),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_search_summit",
    {
      title: "Verify summit",
      description: "Reconcile runs, verify receipt against contract version/criteria, and confirm evidence.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        key: keySchema,
        track: z.string().optional(),
      },
    },
    async ({ projectId, directory, key, track }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        const trackName = track ?? "main";
        const outcome = outcomeOf(repo.read(pid), key);
        const report = await runtime.reconcile(pid);
        const run = runtime.run(pid, key, trackName);
        if (!run) throw new Error(`no run has been dispatched for ${key} on track ${trackName}`);
        if (run.state === "superseded") throw new Error(`run ${run.runId} was superseded: ${run.lastError ?? ""}`);
        if (run.state === "failed") throw new Error(`run ${run.runId} failed: ${run.lastError ?? ""}`);
        const booked = runtime.receipts(run.runId);
        const applied = [...booked].reverse().find((r) => r.state === "applied");
        const refused = booked.find((r) => r.state === "refused");
        if (!applied) {
          if (refused) throw new Error(`run ${run.runId} wrote receipt ${refused.id}, refused: ${refused.refusal ?? "unknown"}`);
          throw new Error(`no verified receipt yet for run ${run.runId} (state: ${run.state}).`);
        }
        const tree = repo.read(pid);
        const evidenceId = applied.evidenceId ?? applied.id;
        const persisted = tree.evidence.find((e) => e.id === evidenceId);
        if (!persisted) throw new Error(`receipt ${applied.id} marked applied but evidence ${evidenceId} missing from ledger`);
        if (persisted.version !== outcome.version) {
          throw new Error(`receipt ${applied.id} proved v${persisted.version}, but contract is now v${outcome.version}`);
        }
        const after = repo.view(pid, trackName);
        const criteria = outcome.criteria.map((c) => c.id);
        const uncovered = criteria.filter((id) => !persisted.criterionIds.includes(id));
        return jsonResult({
          projectId: pid,
          key,
          track: trackName,
          run,
          reconciled: report,
          receipt: {
            id: applied.id,
            evidenceId,
            kind: persisted.kind,
            criterionIds: persisted.criterionIds,
            source: persisted.source,
            created: persisted.created,
            text: bound(persisted.text, MAX_EVIDENCE_TEXT),
          },
          signal: after.ranked.find((r) => r.key === key)?.signal ?? "unverified",
          uncoveredCriteria: uncovered,
          inbox: inboxOf(after),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // CI Evidence & Equal-Budget Studies (model-visible)
  // -------------------------------------------------------------------------

  server.registerTool(
    "hillclimb_ingest_junit",
    {
      title: "Ingest CI report",
      description: "Parse JUnit/JSON/text report for outcome tags (dry-run by default; apply=true writes).",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        report: z.string(),
        format: z.enum(["auto", "junit", "json", "text"]).default("auto"),
        source: z.string().optional(),
        track: z.string().optional(),
        prefixes: z.string().optional(),
        contractFrozenAt: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        apply: z.boolean().default(false),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const res = ingestJunitReport(repo, {
          project: pid,
          report: input.report,
          directory: input.directory ?? repo.getProject(pid)?.directory ?? process.cwd(),
          format: input.format,
          source: input.source,
          track: input.track,
          prefixes: input.prefixes,
          contractFrozenAt: input.contractFrozenAt,
          limit: input.limit,
          apply: input.apply,
        });
        return jsonResult({ exitCode: res.exitCode, ...res.payload });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_post_test_evidence",
    {
      title: "Apply CI evidence bundle",
      description:
        "Validate and dry-run or atomically apply a `ci-evidence.json` bundle produced by `assets/ci/hillclimb-evidence.mjs`.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        bundle: z.string().describe("Path to ci-evidence.json"),
        track: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        apply: z.boolean().default(false),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const res = postTestEvidenceBundle(repo, {
          project: pid,
          bundle: input.bundle,
          directory: input.directory ?? repo.getProject(pid)?.directory ?? process.cwd(),
          track: input.track,
          limit: input.limit,
          apply: input.apply,
        });
        return jsonResult({ exitCode: res.exitCode, ...res.payload });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_study_preview",
    {
      title: "Study preview",
      description: "Expand study spec job matrix and equal-budget allocation without running searches.",
      inputSchema: {
        spec: z.string().optional(),
        directory: z.string().optional(),
        candidates: z.number().int().min(1).optional(),
        verifierRepeat: z.number().int().min(1).max(100).optional(),
        trialAllowance: z.number().int().min(0).optional(),
        repeats: z.number().int().min(1).max(1000).optional(),
        budget: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const res = await runStudyPreview({
          spec: input.spec,
          dir: input.directory,
          candidates: input.candidates,
          verifierRepeat: input.verifierRepeat,
          trialAllowance: input.trialAllowance,
          repeats: input.repeats,
          budget: input.budget,
        });
        return jsonResult(res.preview as unknown as Record<string, unknown>, res.text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_study_report",
    {
      title: "Study report",
      description: "Read or reconstruct matched-repeats equal-budget study comparison.",
      inputSchema: {
        directory: z.string().optional(),
        artifact: z.string().optional(),
        study: z.string().optional(),
        run: z.string().optional(),
        problem: z.string().optional(),
        control: z.string().optional(),
        noiseFloor: z.number().optional(),
      },
    },
    async (input) => {
      try {
        const res = await runStudyReport({
          dir: input.directory,
          artifact: input.artifact,
          study: input.study,
          run: input.run,
          problem: input.problem,
          control: input.control,
          noiseFloor: input.noiseFloor,
        });
        return jsonResult(res.report as unknown as Record<string, unknown>, res.text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Search, Insights, Artifacts & Blueprints/Import (model-visible)
  // -------------------------------------------------------------------------

  server.registerTool(
    "hillclimb_search",
    {
      title: "Search",
      description: "Full-text FTS5 search across goals, outcomes, plans, evidence, comments, flows, artifacts, and climbs.",
      inputSchema: {
        query: z.string().trim().min(1),
        projectId: z.string().optional(),
        directory: z.string().optional(),
        types: z.array(z.enum(["goal", "outcome", "plan", "evidence", "comment", "flow", "artifact", "climb"])).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ query, projectId, directory, types, limit }) => {
      try {
        const pid = projectId || directory ? repo.resolveProjectId(projectId, directory) : null;
        const hits = searchWithClimbs(pid, query, { types, limit });
        const summary =
          hits.length === 0
            ? `No matches for "${query}".`
            : hits.map((h) => `[${h.entityType}] ${h.entityId} — ${h.title}: ${h.snippet}`).join("\n");
        return jsonResult({ query, projectId: pid, count: hits.length, hits }, summary);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_insights",
    {
      title: "Insights",
      description: "Daily verifications, streak, provenance, and climb keep-rate/holdout analytics.",
      inputSchema: {
        projectId: z.string().optional(),
        directory: z.string().optional(),
        days: z.number().int().min(1).max(365).default(30),
        track: z.string().optional(),
      },
    },
    async ({ projectId, directory, days, track }) => {
      try {
        const pid = repo.resolveProjectId(projectId, directory);
        const dir = repo.getProject(pid)?.directory ?? null;
        const scanned = dir ? scanProjectClimbs(dir, { rowLimit: 50, includeNotes: false }) : null;
        const insights = computeInsights(repo, pid, { days, track: track ?? "main", scannedClimbs: scanned });
        const summary = `Insights (${pid}, ${days}d): ${insights.totals.verifiedRatePct}% verified (${insights.totals.bySignal.verified}/${insights.totals.outcomes}), streak ${insights.streakDays}d, climbs ${insights.climbs.keptSteps}/${insights.climbs.totalSteps} kept (${insights.climbs.holdoutChecksRun} holdouts).`;
        return jsonResult(insights as unknown as Record<string, unknown>, summary);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_artifact",
    {
      title: "Artifacts & export",
      description: "List, get, save, generate from template, delete, or export HTML/Markdown snapshots.",
      inputSchema: {
        mode: z.enum(["list", "get", "save", "generate", "export", "delete"]).default("list"),
        projectId: z.string().optional(),
        directory: z.string().optional(),
        id: z.string().optional(),
        folder: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        template: z.enum(["weekly-update", "release-readiness", "climb-experiment-report", "compliance-audit", "postmortem"]).optional(),
        releaseName: z.string().optional(),
        format: z.enum(["html", "markdown"]).optional(),
        scope: z.string().optional(),
        locked: z.boolean().optional(),
        save: z.boolean().default(true),
        citations: z.array(z.string()).optional(),
      },
    },
    async (input) => {
      try {
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const dir = repo.getProject(pid)?.directory ?? null;
        if (input.mode === "list") {
          const artifacts = repo.listArtifacts(pid, input.folder).map(({ history: _h, body, ...rest }) => ({
            ...rest,
            chars: body.length,
          }));
          return jsonResult({ projectId: pid, templates: ARTIFACT_TEMPLATES, artifacts });
        }
        if (input.mode === "get") {
          if (!input.id) throw new Error("Pass `id` for mode='get'.");
          const artifact = repo.getArtifact(pid, input.id);
          if (!artifact) throw new Error(`Unknown artifact "${input.id}".`);
          return jsonResult({ projectId: pid, artifact }, artifact.body);
        }
        if (input.mode === "delete") {
          if (!input.id) throw new Error("Pass `id` for mode='delete'.");
          return jsonResult({ projectId: pid, deleted: repo.deleteArtifact(pid, input.id) });
        }
        if (input.mode === "save") {
          const saved = repo.saveArtifact(pid, {
            id: input.id,
            folder: input.folder,
            title: input.title ?? "Untitled report",
            body: input.body ?? "",
            citations: input.citations,
            locked: input.locked,
            actor: defaultSessionActor(),
          });
          return jsonResult({ projectId: pid, artifact: saved }, `Saved artifact "${saved.title}" (${saved.id} v${saved.version}).`);
        }
        const scanned = dir ? scanProjectClimbs(dir, { rowLimit: 25, includeNotes: false }) : null;
        if (input.mode === "export") {
          const exported = exportShareableReport(repo, pid, {
            format: input.format ?? "html",
            releaseName: input.releaseName,
            scope: input.scope,
            scannedClimbs: scanned,
          });
          return jsonResult(
            exported as unknown as Record<string, unknown>,
            `Exported ${exported.format} snapshot "${exported.filename}" (${exported.outcomesIncluded} outcomes, ${exported.content.length} chars).`,
          );
        }
        const gen = generateArtifactFromTemplate(repo, pid, {
          template: (input.template ?? "weekly-update") as ArtifactTemplateId,
          title: input.title,
          folder: input.folder,
          releaseName: input.releaseName,
          scannedClimbs: scanned,
          actor: defaultSessionActor(),
          save: input.save,
        });
        return jsonResult({ projectId: pid, ...gen }, gen.body);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hillclimb_import",
    {
      title: "Import blueprints/MD",
      description: "List blueprints or preview/import a blueprint or Markdown spec with 22-rule lint.",
      inputSchema: {
        mode: z.enum(["blueprints", "blueprint", "markdown"]).default("blueprints"),
        projectId: z.string().optional(),
        directory: z.string().optional(),
        blueprintId: z.string().optional(),
        markdown: z.string().optional(),
        goalKey: z.string().optional(),
        prefix: z.string().optional(),
        tags: z.array(z.string()).optional(),
        asProposals: z.boolean().default(false),
        apply: z.boolean().default(false),
      },
    },
    async (input) => {
      try {
        if (input.mode === "blueprints") {
          return jsonResult({ blueprints: listBlueprints() });
        }
        const pid = repo.resolveProjectId(input.projectId, input.directory);
        const existingTree = repo.read(pid);
        const existingKeys = new Set([
          ...existingTree.goals.map((g) => g.key),
          ...existingTree.outcomes.map((o) => o.key),
        ]);
        const requireApproval = repo.getSetting(pid, "requireApprovalForNewOutcomes") === "true";
        const asProposals = input.asProposals || requireApproval;
        let actions: Action[] = [];
        let lint: ReturnType<typeof lintTree>;
        if (input.mode === "blueprint") {
          if (!input.blueprintId) throw new Error("Pass `blueprintId` for mode='blueprint'.");
          const built = blueprintActions(input.blueprintId, { asProposals, keyPrefix: input.prefix, existingKeys });
          actions = built.actions;
          lint = built.lint;
        } else {
          if (!input.markdown?.trim()) throw new Error("Pass `markdown` for mode='markdown'.");
          const parsed = parseMarkdownImport(input.markdown, {
            goalKey: input.goalKey,
            prefix: input.prefix,
            asProposals,
            existingKeys,
            tags: input.tags,
          });
          actions = parsed.actions;
          lint = parsed.lint;
        }
        if (input.apply && actions.length > 0) {
          repo.actBatch(pid, actions, { actor: defaultSessionActor(), via: "mcp" });
        }
        return jsonResult({
          projectId: pid,
          applied: input.apply ? actions.length : 0,
          actionCount: actions.length,
          asProposals,
          lint: { passed: lint.passed, errorCount: lint.errorCount, warningCount: lint.warningCount, findings: lint.findings.slice(0, 20) },
          actions: input.apply ? undefined : actions,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // App-Only UI RPC Tools (hidden from model; callable only by MCP App)
  // -------------------------------------------------------------------------

  const APP_ONLY = { ui: { visibility: ["app"] as ("app" | "model")[] } };

  registerAppTool(
    server,
    "app_projects",
    { description: "List projects for UI", _meta: APP_ONLY },
    async () => {
      try {
        const projects = repo.listProjects();
        const inboxCount = repo.inboxCountTotal();
        return appJsonResult({ projects, inboxCount }, `${projects.length} project(s), ${inboxCount} inbox item(s)`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_register_project",
    {
      description: "Register a workspace project from UI",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        directory: z.string().optional(),
      },
      _meta: APP_ONLY,
    },
    async ({ id, name, directory }) => {
      try {
        const project = repo.registerProject({ id, name, directory: directory ?? null });
        return appJsonResult({ project, projects: repo.listProjects() }, `Registered project ${project.id}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_tree",
    {
      description: "Read tree snapshot and scanned repo climbs for UI",
      inputSchema: { projectId: z.string().min(1), track: z.string().optional(), force: z.boolean().optional() },
      _meta: APP_ONLY,
    },
    async ({ projectId, track, force }) => {
      try {
        const repoClimbs = scanAndSync(projectId, { force });
        const tree = repo.view(projectId, track ?? "main");
        const inboxCount = repo.inboxCountTotal();
        return appJsonResult(
          {
            tree,
            repoClimbs,
            inboxCount,
            views: repo.listViews(projectId),
            scopes: repo.listScopes(projectId),
            settings: projectSettingsOf(projectId),
          },
          `Tree ${projectId} (${tree.outcomes.length} outcomes, ${repoClimbs.climbs.length} climb(s), ${inboxCount} inbox)`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_repo_climbs",
    {
      description: "Scan project repository and linked git worktrees for active/prepared climb.py runs",
      inputSchema: { projectId: z.string().min(1), force: z.boolean().optional() },
      _meta: APP_ONLY,
    },
    async ({ projectId, force }) => {
      try {
        const repoClimbs = scanAndSync(projectId, { force: force ?? true });
        return appJsonResult(
          repoClimbs as unknown as Record<string, unknown>,
          `${repoClimbs.climbs.length} climb(s) in ${projectId}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_set_auto_track",
    {
      description: "Enable or disable automatic tracking of repo climbs into Outcomes",
      inputSchema: { projectId: z.string().min(1), enabled: z.boolean(), track: z.string().optional() },
      _meta: APP_ONLY,
    },
    async ({ projectId, enabled, track }) => {
      try {
        autoTracker.setAutoTrackEnabled(projectId, enabled);
        const repoClimbs = scanAndSync(projectId);
        const tree = repo.view(projectId, track ?? "main");
        const inboxCount = repo.inboxCountTotal();
        return appJsonResult(
          { ok: true, autoTrackClimbs: enabled, tree, repoClimbs, inboxCount },
          `Auto-track ${enabled ? "enabled" : "disabled"} for ${projectId}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_track_climb",
    {
      description: "Track a specific repo climb (including archived worktree climbs) as an Outcome",
      inputSchema: { projectId: z.string().min(1), climbId: z.string().min(1), track: z.string().optional() },
      _meta: APP_ONLY,
    },
    async ({ projectId, climbId, track }) => {
      try {
        const dir = repo.getProject(projectId)?.directory ?? null;
        const scanned = scanProjectClimbs(dir);
        const target = scanned.climbs.find((c) => c.id === climbId || c.name === climbId);
        if (!target) {
          throw new Error(`Climb "${climbId}" was not found in this project.`);
        }
        const outcomeKey = autoTracker.trackClimb(projectId, target, { autoCreated: false });
        const repoClimbs = autoTracker.syncScannedClimbs(projectId, scanned);
        const tree = repo.view(projectId, track ?? "main");
        const inboxCount = repo.inboxCountTotal();
        return appJsonResult(
          { ok: true, outcomeKey, tree, repoClimbs, inboxCount },
          `Tracked climb ${climbId} as ${outcomeKey}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_act",
    {
      description: "Apply a tree action from UI (supports human-confirmed contract decisions)",
      inputSchema: {
        projectId: z.string().min(1),
        action: z.record(z.string(), z.unknown()),
        confirmed: z.boolean().optional(),
        track: z.string().optional(),
      },
      _meta: APP_ONLY,
    },
    async ({ projectId, action, confirmed, track }) => {
      try {
        const parsed = actionSchema.parse(action);
        if (isDecision(parsed) && confirmed !== true) {
          throw new Error("Human confirmation required before approving/rejecting a contract change, flow change, or promoting a track.");
        }
        repo.act(projectId, parsed, { actor: "human", via: "ui" });
        const tree = repo.view(projectId, track ?? "main");
        const inboxCount = repo.inboxCountTotal();
        return appJsonResult({ ok: true, tree, inboxCount }, `Applied ${parsed.op} on ${projectId}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_preview",
    {
      description: "Preview track promotion from UI",
      inputSchema: { projectId: z.string().min(1), name: z.string().min(1), keys: z.array(z.string()) },
      _meta: APP_ONLY,
    },
    async ({ projectId, name, keys }) => {
      try {
        const preview = previewPromotion(repo.read(projectId), name, keys);
        const rows = preview.outcomes.map((p) => ({
          key: p.key,
          ready: p.readiness === "proven",
          from: p.live ?? "missing",
          to: p.track ?? "missing",
        }));
        return appJsonResult(
          { rows, summary: preview.summary, canApply: preview.canApply, reason: preview.reason },
          `Promotion preview: ${preview.summary.proven}/${preview.summary.total} proven`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_get_rig",
    {
      description: "Read saved verifier rig for outcome",
      inputSchema: { projectId: z.string().min(1), key: z.string().min(1), engine: z.enum(["repo", "search"]) },
      _meta: APP_ONLY,
    },
    async ({ projectId, key, engine }) => {
      try {
        const rig = runtime.getRig(projectId, key, engine);
        return appJsonResult({ rig }, rig ? `Rig loaded for ${key} (${engine})` : `No ${engine} rig for ${key}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_save_rig",
    {
      description: "Save verifier rig from UI",
      inputSchema: {
        projectId: z.string().min(1),
        key: z.string().min(1),
        version: z.number().int().positive(),
        rig: z.record(z.string(), z.unknown()),
      },
      _meta: APP_ONLY,
    },
    async ({ projectId, key, version, rig }) => {
      try {
        const parsedRig = rigSchema.parse(rig);
        const saved = runtime.saveRig(projectId, key, version, parsedRig);
        return appJsonResult({ ok: true, saved }, `Saved ${parsedRig.engine} rig for ${key} v${version}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_dispatch",
    {
      description: "Dispatch climb worker from UI",
      inputSchema: {
        projectId: z.string().min(1),
        key: z.string().min(1),
        engine: z.enum(["repo", "search"]),
        track: z.string().default("main"),
        deferWorkerLaunch: z.boolean().optional(),
      },
      _meta: APP_ONLY,
    },
    async ({ projectId, key, engine, track, deferWorkerLaunch }) => {
      try {
        const result = await runtime.dispatch(projectId, key, engine, track, { deferWorkerLaunch });
        return appJsonResult(result as unknown as Record<string, unknown>, `Dispatched ${result.runId} for ${key}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_attach_worker",
    {
      description: "Bind client-launched conversation ID to a dispatched run",
      inputSchema: { runId: z.string().min(1), conversationId: z.string().min(1) },
      _meta: APP_ONLY,
    },
    async ({ runId, conversationId }) => {
      try {
        const run = runtime.attachWorker(runId, conversationId);
        return appJsonResult({ ok: true, run }, `Attached ${conversationId} to ${runId}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_live",
    {
      description: "Read live climb/search state for UI",
      inputSchema: { projectId: z.string().min(1), key: z.string().min(1), track: z.string().default("main") },
      _meta: APP_ONLY,
    },
    async ({ projectId, key, track }) => {
      try {
        const live = await runtime.live(projectId, key, track);
        if (live.engine === null) {
          const dir = repo.getProject(projectId)?.directory ?? null;
          const fallback = autoTracker.liveForOutcome(projectId, key, dir);
          if (fallback) {
            return appJsonResult(fallback as unknown as Record<string, unknown>, `Live fallback for ${key}`);
          }
        }
        return appJsonResult(live as unknown as Record<string, unknown>, `Live status for ${key}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_reconcile",
    {
      description: "Reconcile active runs from UI",
      inputSchema: { projectId: z.string().optional() },
      _meta: APP_ONLY,
    },
    async ({ projectId }) => {
      try {
        const report = await runtime.reconcile(projectId);
        return appJsonResult(
          report as unknown as Record<string, unknown>,
          `Reconciled ${report.scanned} run(s): ${report.applied} applied`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_sync",
    {
      description: "Sync .hillclimb/ markdown mirror from UI",
      inputSchema: { projectId: z.string().min(1) },
      _meta: APP_ONLY,
    },
    async ({ projectId }) => {
      try {
        const dir = repo.getProject(projectId)?.directory;
        if (!dir) throw new Error(`Project ${projectId} has no registered workspace directory.`);
        const res = await writeMirror(dir, repo.view(projectId), {
          artifacts: repo.listArtifacts(projectId),
          scannedClimbs: scanProjectClimbs(dir, { rowLimit: 10, includeNotes: true }),
        });
        return appJsonResult(res, `Synced ${res.files} files to ${res.root}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_lint",
    {
      description: "Run 22-rule contract linter from UI",
      inputSchema: { projectId: z.string().min(1) },
      _meta: APP_ONLY,
    },
    async ({ projectId }) => {
      try {
        const result = lintTree(repo.read(projectId));
        return appJsonResult(
          result as unknown as Record<string, unknown>,
          `Lint ${result.passed ? "passed" : "failed"} (${result.errorCount} errors, ${result.warningCount} warnings)`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_search",
    {
      description: "Search everything for UI Cmd+K palette",
      inputSchema: { projectId: z.string().optional(), query: z.string(), limit: z.number().int().min(1).max(50).optional() },
      _meta: APP_ONLY,
    },
    async ({ projectId, query, limit }) => {
      try {
        const hits = searchWithClimbs(projectId ?? null, query, { limit: limit ?? 25 });
        return appJsonResult({ hits }, `${hits.length} hit(s)`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_insights",
    {
      description: "Compute project + climb insights for UI",
      inputSchema: { projectId: z.string().min(1), days: z.number().int().min(1).max(365).optional(), track: z.string().optional() },
      _meta: APP_ONLY,
    },
    async ({ projectId, days, track }) => {
      try {
        const dir = repo.getProject(projectId)?.directory ?? null;
        const scanned = dir ? scanProjectClimbs(dir, { rowLimit: 50, includeNotes: false }) : null;
        const insights = computeInsights(repo, projectId, { days: days ?? 30, track: track ?? "main", scannedClimbs: scanned });
        return appJsonResult(insights as unknown as Record<string, unknown>, `Insights ${projectId}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_artifacts",
    {
      description: "Manage artifacts and exports from UI",
      inputSchema: {
        projectId: z.string().min(1),
        mode: z.enum(["list", "save", "generate", "export", "delete"]),
        payload: z.record(z.string(), z.unknown()).optional(),
      },
      _meta: APP_ONLY,
    },
    async ({ projectId, mode, payload }) => {
      try {
        const p = payload ?? {};
        const dir = repo.getProject(projectId)?.directory ?? null;
        if (mode === "list") {
          return appJsonResult({ templates: ARTIFACT_TEMPLATES, artifacts: repo.listArtifacts(projectId) }, "Artifacts loaded");
        }
        if (mode === "delete") {
          repo.deleteArtifact(projectId, String(p.id ?? ""));
          return appJsonResult({ artifacts: repo.listArtifacts(projectId) }, "Artifact deleted");
        }
        if (mode === "save") {
          const saved = repo.saveArtifact(projectId, {
            id: typeof p.id === "string" ? p.id : undefined,
            folder: typeof p.folder === "string" ? p.folder : undefined,
            title: String(p.title ?? "Untitled"),
            body: String(p.body ?? ""),
            locked: typeof p.locked === "boolean" ? p.locked : undefined,
            citations: Array.isArray(p.citations) ? p.citations.map(String) : undefined,
            actor: "human",
          });
          return appJsonResult({ artifact: saved, artifacts: repo.listArtifacts(projectId) }, `Saved ${saved.title}`);
        }
        const scanned = dir ? scanProjectClimbs(dir, { rowLimit: 25, includeNotes: false }) : null;
        if (mode === "export") {
          const exported = exportShareableReport(repo, projectId, {
            format: p.format === "markdown" ? "markdown" : "html",
            track: typeof p.track === "string" ? p.track : "main",
            releaseName: typeof p.releaseName === "string" ? p.releaseName : undefined,
            scope: typeof p.scope === "string" ? p.scope : undefined,
            scannedClimbs: scanned,
          });
          return appJsonResult(exported as unknown as Record<string, unknown>, `Exported ${exported.filename}`);
        }
        const gen = generateArtifactFromTemplate(repo, projectId, {
          template: (typeof p.template === "string" ? p.template : "weekly-update") as ArtifactTemplateId,
          title: typeof p.title === "string" ? p.title : undefined,
          folder: typeof p.folder === "string" ? p.folder : undefined,
          releaseName: typeof p.releaseName === "string" ? p.releaseName : undefined,
          scannedClimbs: scanned,
          actor: "human",
          save: true,
        });
        return appJsonResult({ artifact: gen.saved, artifacts: repo.listArtifacts(projectId) }, `Generated ${gen.title}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_views_scopes",
    {
      description: "Manage saved views, focus scopes, settings, and automation hooks from UI",
      inputSchema: {
        projectId: z.string().min(1),
        mode: z.enum(["list", "save_view", "delete_view", "save_scope", "delete_scope", "set_setting", "save_hook", "delete_hook"]),
        payload: z.record(z.string(), z.unknown()).optional(),
      },
      _meta: APP_ONLY,
    },
    async ({ projectId, mode, payload }) => {
      try {
        const p = payload ?? {};
        if (mode === "save_view") {
          repo.saveView(projectId, {
            id: typeof p.id === "string" ? p.id : undefined,
            name: String(p.name ?? ""),
            filter: (p.filter ?? {}) as Record<string, unknown>,
          });
        } else if (mode === "delete_view") {
          repo.deleteView(projectId, String(p.id ?? ""));
        } else if (mode === "save_scope") {
          repo.saveScope(projectId, {
            id: typeof p.id === "string" ? p.id : undefined,
            name: String(p.name ?? ""),
            owner: typeof p.owner === "string" ? p.owner : null,
            releaseName: typeof p.releaseName === "string" ? p.releaseName : null,
            goalKeys: Array.isArray(p.goalKeys) ? p.goalKeys.map(String) : [],
            tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
            active: Boolean(p.active),
          });
        } else if (mode === "delete_scope") {
          repo.deleteScope(projectId, String(p.id ?? ""));
        } else if (mode === "set_setting") {
          repo.setSetting(projectId, String(p.key ?? ""), String(p.value ?? ""));
        } else if (mode === "save_hook") {
          repo.saveHook(projectId, {
            id: typeof p.id === "string" ? p.id : undefined,
            event: (typeof p.event === "string" ? p.event : "*") as HookEvent,
            targetType: (p.targetType === "webhook" || p.targetType === "notify" ? p.targetType : "shell"),
            target: String(p.target ?? ""),
            enabled: p.enabled !== false,
            secret: typeof p.secret === "string" ? p.secret : null,
          });
        } else if (mode === "delete_hook") {
          repo.deleteHook(projectId, String(p.id ?? ""));
        }
        return appJsonResult(
          {
            views: repo.listViews(projectId),
            scopes: repo.listScopes(projectId),
            hooks: repo.listHooks(projectId),
            settings: projectSettingsOf(projectId),
          },
          `Updated ${mode}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_import",
    {
      description: "List blueprints, preview or apply blueprint/Markdown imports from UI",
      inputSchema: {
        projectId: z.string().min(1),
        mode: z.enum(["blueprints", "preview", "apply"]),
        payload: z.record(z.string(), z.unknown()).optional(),
      },
      _meta: APP_ONLY,
    },
    async ({ projectId, mode, payload }) => {
      try {
        if (mode === "blueprints") {
          return appJsonResult({ blueprints: listBlueprints() }, "Blueprints loaded");
        }
        const p = payload ?? {};
        const existingTree = repo.read(projectId);
        const existingKeys = new Set([
          ...existingTree.goals.map((g) => g.key),
          ...existingTree.outcomes.map((o) => o.key),
        ]);
        const asProposals = Boolean(p.asProposals);
        const built =
          typeof p.blueprintId === "string" && p.blueprintId.trim() !== ""
            ? blueprintActions(p.blueprintId, {
                asProposals,
                keyPrefix: typeof p.prefix === "string" ? p.prefix : undefined,
                existingKeys,
              })
            : parseMarkdownImport(String(p.markdown ?? ""), {
                goalKey: typeof p.goalKey === "string" ? p.goalKey : undefined,
                prefix: typeof p.prefix === "string" ? p.prefix : undefined,
                asProposals,
                existingKeys,
              });
        if (mode === "apply" && built.actions.length > 0) {
          repo.actBatch(projectId, built.actions, { actor: "human", via: "ui" });
        }
        return appJsonResult(
          {
            applied: mode === "apply" ? built.actions.length : 0,
            actionCount: built.actions.length,
            lint: built.lint,
            tree: mode === "apply" ? repo.view(projectId, typeof p.track === "string" ? p.track : "main") : undefined,
            inboxCount: repo.inboxCountTotal(),
          },
          `${mode} ${built.actions.length} action(s)`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

function isMainEntrypoint(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return resolve(fileURLToPath(metaUrl)) === resolve(process.argv[1]);
  }
}

const isEntrypoint = isMainEntrypoint(import.meta.url);
if (isEntrypoint) {
  const dataDir = parseDataDirArg(process.argv.slice(2));
  const db = openDatabase(dataDir);
  const repo = createRepository(db);
  const runtime = createRuntime(repo, { automatic: true });
  const server = createHillClimbServer(repo, runtime);
  const transport = new StdioServerTransport();

  const shutdown = () => {
    runtime.stop();
    repo.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
}
