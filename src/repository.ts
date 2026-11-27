import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Action } from "./actions.js";
import { coreActions, planningActions } from "./actions.js";
import { treeSchema } from "./tree-schema.js";
import { applyCore, snapshot, type ActionMeta } from "./tree.js";
import { applyPlanning } from "./planning.js";
import { emptyTree, type Snapshot, type Tree } from "./model.js";
import { redactSecrets } from "./state.js";

export interface SavedViewFilter {
  query?: string;
  signals?: string[];
  tags?: string[];
  blockedOnly?: boolean;
  availability?: string[];
  scope?: string | null;
  sortMode?: "rank" | "signal" | "updated";
}

export interface SavedView {
  id: string;
  name: string;
  filter: SavedViewFilter;
  created: string;
  updated: string;
}

export interface FocusScope {
  id: string;
  name: string;
  owner: string | null;
  releaseName: string | null;
  goalKeys: string[];
  tags: string[];
  active: boolean;
  created: string;
  updated: string;
}

export interface ArtifactRevision {
  version: number;
  title: string;
  body: string;
  actor: string | null;
  at: string;
}

export interface ArtifactRecord {
  id: string;
  folder: string;
  title: string;
  template: string | null;
  body: string;
  locked: boolean;
  version: number;
  history: ArtifactRevision[];
  citations: string[];
  actor: string | null;
  created: string;
  updated: string;
}

export type HookEvent =
  | "outcome.broken"
  | "outcome.verified"
  | "climb.bar_reached"
  | "question.answered"
  | "change.approved"
  | "flow.accepted"
  | "*";

export interface HookRecord {
  id: string;
  event: HookEvent;
  targetType: "shell" | "webhook" | "notify";
  target: string;
  enabled: boolean;
  secret: string | null;
  created: string;
  updated: string;
}

export interface SearchHit {
  project: string;
  entityType: "goal" | "outcome" | "plan" | "evidence" | "comment" | "flow" | "artifact" | "climb";
  entityId: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface TreeMutationEvent {
  project: string;
  actions: readonly Action[];
  meta?: ActionMeta;
  before: Snapshot;
  after: Snapshot;
}

export interface ProjectInfo {
  id: string;
  name: string;
  directory: string | null;
  source: "antigravity" | "registered" | "tree";
}

export interface ProjectSummary {
  project: string;
  goalCount: number;
  outcomeCount: number;
  inboxCount: number;
  lastActivityAt: string | null;
  hasRepo: boolean;
  updated: string;
}

export function defaultDataDir(): string {
  return (
    process.env.HILLCLIMB_DATA_DIR ||
    process.env.PLUGIN_DATA ||
    join(homedir(), ".gemini", "antigravity", "plugin_data", "hillclimb")
  );
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, Math.max(1, ms));
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { errcode?: unknown; message?: unknown; errstr?: unknown };
  if (typeof e.errcode === "number" && (e.errcode & 0xff) === 5) return true;
  const msg = typeof e.message === "string" ? e.message : "";
  const errstr = typeof e.errstr === "string" ? e.errstr : "";
  return msg.includes("database is locked") || errstr.includes("database is locked");
}

export function openDatabase(dataDir = defaultDataDir()): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "hillclimb.db");
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA wal_autocheckpoint = 200;");
  const deadline = Date.now() + 5000;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode;
      if (mode?.toLowerCase() === "wal") {
        break;
      }
      const nextMode = (db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined)
        ?.journal_mode;
      if (nextMode?.toLowerCase() === "wal") {
        break;
      }
      if (Date.now() >= deadline || attempt >= 150) {
        break;
      }
    } catch (error) {
      if (!isSqliteBusyError(error) || Date.now() >= deadline || attempt >= 150) {
        try {
          db.close();
        } catch {
          // ignore close error
        }
        throw error;
      }
    }
    sleepSync(10 + Math.floor(Math.random() * 25));
  }
  return db;
}

const ANTIGRAVITY_PROJECTS_CACHE_TTL_MS = 5_000;
let antigravityProjectsCache: {
  dir: string;
  at: number;
  mtimeMs: number;
  projects: ProjectInfo[];
} | null = null;

export function clearAntigravityProjectsCache(): void {
  antigravityProjectsCache = null;
}

function readAntigravityProjects(): ProjectInfo[] {
  const dir = join(homedir(), ".gemini", "config", "projects");
  let dirMtimeMs = -1;
  try {
    dirMtimeMs = statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  const now = Date.now();
  if (
    antigravityProjectsCache &&
    antigravityProjectsCache.dir === dir &&
    antigravityProjectsCache.mtimeMs === dirMtimeMs &&
    now - antigravityProjectsCache.at < ANTIGRAVITY_PROJECTS_CACHE_TTL_MS
  ) {
    return antigravityProjectsCache.projects.map((p) => ({ ...p }));
  }
  const results: ProjectInfo[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry), "utf8")) as Record<string, unknown>;
      if (raw.sidecar) continue; // Skip internal sidecar pseudo-projects
      const id = typeof raw.id === "string" ? raw.id : null;
      const name = typeof raw.name === "string" ? raw.name : id;
      if (!id || !name) continue;
      let directory: string | null = null;
      const resources = (raw.projectResources as { resources?: Array<Record<string, unknown>> } | undefined)?.resources;
      if (Array.isArray(resources)) {
        for (const res of resources) {
          const gitFolder = res.gitFolder as { folderUri?: string } | undefined;
          const folder = res.folder as { folderUri?: string } | undefined;
          const uri = gitFolder?.folderUri ?? folder?.folderUri;
          if (typeof uri === "string" && uri.startsWith("file://")) {
            try {
              directory = fileURLToPath(uri);
              break;
            } catch {
              directory = uri.slice("file://".length);
              break;
            }
          }
        }
      }
      results.push({ id, name, directory, source: "antigravity" });
    } catch {
      continue;
    }
  }
  antigravityProjectsCache = { dir, at: now, mtimeMs: dirMtimeMs, projects: results };
  return results.map((p) => ({ ...p }));
}

/**
 * Redact inline secrets in persisted tree contracts/proposals/evidence without
 * bumping `outcome.version`, preserving existing criterion bindings and receipts.
 */
export function sanitizeTreeSecrets(tree: Tree): boolean {
  let changed = false;
  const redactField = (value: string): string => {
    const next = redactSecrets(value);
    if (next !== value) changed = true;
    return next;
  };
  for (const goal of tree.goals) {
    goal.title = redactField(goal.title);
    goal.brief = redactField(goal.brief);
  }
  for (const outcome of tree.outcomes) {
    outcome.title = redactField(outcome.title);
    outcome.story = redactField(outcome.story);
    for (const criterion of outcome.criteria) {
      criterion.given = redactField(criterion.given);
      criterion.when = redactField(criterion.when);
      criterion.then = redactField(criterion.then);
    }
  }
  for (const change of tree.changes) {
    change.proposed.title = redactField(change.proposed.title);
    change.proposed.story = redactField(change.proposed.story);
    for (const criterion of change.proposed.criteria) {
      criterion.given = redactField(criterion.given);
      criterion.when = redactField(criterion.when);
      criterion.then = redactField(criterion.then);
    }
  }
  for (const item of tree.evidence) {
    item.source = redactField(item.source);
    item.text = redactField(item.text);
  }
  for (const comment of tree.comments) {
    comment.text = redactField(comment.text);
    if (comment.answer !== null) {
      comment.answer = redactField(comment.answer);
    }
  }
  for (const act of tree.activity) {
    act.text = redactField(act.text);
  }
  for (const prop of tree.flowProposals ?? []) {
    if (prop.note) prop.note = redactField(prop.note);
    if (prop.reviewNote) prop.reviewNote = redactField(prop.reviewNote);
  }
  return changed;
}

export function createRepository(db: DatabaseSync) {
  function runInImmediateTx<T>(fn: () => T): T {
    const deadline = Date.now() + 5000;
    for (let attempt = 0; ; attempt += 1) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!isSqliteBusyError(error) || Date.now() >= deadline || attempt >= 150) {
          throw error;
        }
        sleepSync(10 + Math.floor(Math.random() * 25));
      }
    }
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback error
      }
      throw error;
    }
  }

  const existingTableCount =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name IN ('hc_trees', 'hc_projects', 'hc_tree_meta', 'hc_views', 'hc_scopes', 'hc_artifacts', 'hc_hooks', 'hc_project_settings')",
        )
        .get() as { cnt: number } | undefined
    )?.cnt ?? 0;

  if (existingTableCount < 8) {
    runInImmediateTx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hc_trees(
          project TEXT PRIMARY KEY,
          body TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hc_projects(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          directory TEXT,
          created TEXT NOT NULL,
          updated TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hc_tree_meta(
          project TEXT PRIMARY KEY,
          goal_count INTEGER NOT NULL DEFAULT 0,
          outcome_count INTEGER NOT NULL DEFAULT 0,
          inbox_count INTEGER NOT NULL DEFAULT 0,
          last_activity_at TEXT,
          has_repo INTEGER NOT NULL DEFAULT 0,
          updated TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hc_project_settings(
          project TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated TEXT NOT NULL,
          PRIMARY KEY (project, key)
        );
        CREATE TABLE IF NOT EXISTS hc_views(
          project TEXT NOT NULL,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          filter_json TEXT NOT NULL,
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          PRIMARY KEY (project, id)
        );
        CREATE TABLE IF NOT EXISTS hc_scopes(
          project TEXT NOT NULL,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          owner TEXT,
          release_name TEXT,
          goal_keys_json TEXT NOT NULL DEFAULT '[]',
          tags_json TEXT NOT NULL DEFAULT '[]',
          active INTEGER NOT NULL DEFAULT 0,
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          PRIMARY KEY (project, id)
        );
        CREATE TABLE IF NOT EXISTS hc_artifacts(
          project TEXT NOT NULL,
          id TEXT NOT NULL,
          folder TEXT NOT NULL DEFAULT 'General',
          title TEXT NOT NULL,
          template TEXT,
          body TEXT NOT NULL,
          locked INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          history_json TEXT NOT NULL DEFAULT '[]',
          citations_json TEXT NOT NULL DEFAULT '[]',
          actor TEXT,
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          PRIMARY KEY (project, id)
        );
        CREATE TABLE IF NOT EXISTS hc_hooks(
          project TEXT NOT NULL,
          id TEXT NOT NULL,
          event TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          secret TEXT,
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          PRIMARY KEY (project, id)
        );
      `);
    });
  }

  let ftsAvailable = true;
  try {
    const hasFts = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hc_fts' LIMIT 1")
      .get();
    if (!hasFts) {
      runInImmediateTx(() => {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS hc_fts USING fts5(
            project UNINDEXED,
            entity_type UNINDEXED,
            entity_id UNINDEXED,
            title,
            body,
            tokenize='unicode61'
          );
        `);
      });
    }
  } catch {
    ftsAvailable = false;
  }

  const readStmt = db.prepare("SELECT body FROM hc_trees WHERE project = ?");
  const writeStmt = db.prepare(
    "INSERT INTO hc_trees(project, body) VALUES(?, ?) ON CONFLICT(project) DO UPDATE SET body = excluded.body",
  );
  const upsertProjectStmt = db.prepare(
    `INSERT INTO hc_projects(id, name, directory, created, updated) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, directory = COALESCE(excluded.directory, hc_projects.directory), updated = excluded.updated`,
  );
  const projectDirStmt = db.prepare("SELECT directory FROM hc_projects WHERE id = ?");
  const hasMetaStmt = db.prepare("SELECT 1 FROM hc_tree_meta WHERE project = ? LIMIT 1");
  const upsertMetaStmt = db.prepare(
    `INSERT INTO hc_tree_meta(project, goal_count, outcome_count, inbox_count, last_activity_at, has_repo, updated)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project) DO UPDATE SET
       goal_count = excluded.goal_count,
       outcome_count = excluded.outcome_count,
       inbox_count = excluded.inbox_count,
       last_activity_at = excluded.last_activity_at,
       has_repo = excluded.has_repo,
       updated = excluded.updated`,
  );
  const markMetaRepoStmt = db.prepare("UPDATE hc_tree_meta SET has_repo = 1 WHERE project = ?");
  const sumInboxStmt = db.prepare("SELECT COALESCE(SUM(inbox_count), 0) AS total FROM hc_tree_meta");
  const listMetaStmt = db.prepare(
    "SELECT project, goal_count, outcome_count, inbox_count, last_activity_at, has_repo, updated FROM hc_tree_meta ORDER BY updated DESC",
  );

  function projectHasRepo(project: string): boolean {
    const reg = projectDirStmt.get(project) as { directory: string | null } | undefined;
    if (reg?.directory) return true;
    return readAntigravityProjects().some((p) => p.id === project && Boolean(p.directory));
  }

  function computeTreeMeta(project: string, tree: Tree, stamp = new Date().toISOString()) {
    return {
      goalCount: tree.goals.length,
      outcomeCount: tree.outcomes.length,
      inboxCount:
        tree.changes.filter((c) => c.state === "pending").length +
        tree.comments.filter((c) => c.answer === null).length +
        (tree.flowProposals ?? []).filter((p) => p.state === "pending").length,
      lastActivityAt: tree.activity.length > 0 ? tree.activity[tree.activity.length - 1]!.at : null,
      hasRepo: projectHasRepo(project),
      updated: stamp,
    };
  }

  const deleteFtsProjectStmt = ftsAvailable
    ? db.prepare("DELETE FROM hc_fts WHERE project = ? AND entity_type != 'artifact'")
    : null;
  const deleteFtsArtifactStmt = ftsAvailable
    ? db.prepare("DELETE FROM hc_fts WHERE project = ? AND entity_type = 'artifact' AND entity_id = ?")
    : null;
  const insertFtsStmt = ftsAvailable
    ? db.prepare("INSERT INTO hc_fts(project, entity_type, entity_id, title, body) VALUES(?, ?, ?, ?, ?)")
    : null;

  function reindexTreeFts(project: string, tree: Tree): void {
    if (!ftsAvailable || !deleteFtsProjectStmt || !insertFtsStmt) return;
    deleteFtsProjectStmt.run(project);
    for (const g of tree.goals) {
      insertFtsStmt.run(project, "goal", g.key, `${g.key} ${g.title}`, `${g.brief} ${(g.tags ?? []).join(" ")}`);
    }
    for (const o of tree.outcomes) {
      const critText = o.criteria.map((c) => `${c.id} given ${c.given} when ${c.when} then ${c.then}`).join("\n");
      insertFtsStmt.run(
        project,
        "outcome",
        o.key,
        `${o.key} ${o.title}`,
        `${o.story}\n${critText}\n${(o.tags ?? []).join(" ")} ${o.availabilityReason ?? ""}`,
      );
    }
    for (const p of tree.plans) {
      insertFtsStmt.run(project, "plan", `${p.key}@v${p.version}`, `${p.key} plan v${p.version}`, p.body);
    }
    for (const e of tree.evidence) {
      insertFtsStmt.run(project, "evidence", e.id, `${e.key} ${e.kind} ${e.source}`, e.text);
    }
    for (const c of tree.comments) {
      insertFtsStmt.run(
        project,
        "comment",
        c.id,
        `${c.key} comment`,
        `${c.text} ${c.options.join(" ")} ${c.answer ?? ""}`,
      );
    }
    for (const f of tree.flows) {
      const fBody = f.frames
        .map((fr) => `${fr.title} ${fr.key} ${fr.criterionId} ${fr.notes ?? ""} ${fr.pins.map((p) => p.text).join(" ")}`)
        .join("\n");
      insertFtsStmt.run(project, "flow", f.name, `${f.folder ? `${f.folder} / ` : ""}${f.name}`, fBody);
    }
  }

  function reindexArtifactFts(project: string, art: ArtifactRecord): void {
    if (!ftsAvailable || !deleteFtsArtifactStmt || !insertFtsStmt) return;
    deleteFtsArtifactStmt.run(project, art.id);
    insertFtsStmt.run(project, "artifact", art.id, `${art.folder} / ${art.title}`, `${art.body}\n${art.citations.join(" ")}`);
  }

  const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
  if (userVersion < 2) {
    runInImmediateTx(() => {
      const currentVersion =
        (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
      if (currentVersion >= 2) return;
      const rows = db.prepare("SELECT project, body FROM hc_trees").all() as Array<{ project: string; body: string }>;
      const stamp = new Date().toISOString();
      for (const row of rows) {
        const tree = treeSchema.parse(JSON.parse(row.body));
        if (sanitizeTreeSecrets(tree)) {
          writeStmt.run(row.project, JSON.stringify(tree));
        }
        const meta = computeTreeMeta(row.project, tree, stamp);
        upsertMetaStmt.run(
          row.project,
          meta.goalCount,
          meta.outcomeCount,
          meta.inboxCount,
          meta.lastActivityAt,
          meta.hasRepo ? 1 : 0,
          meta.updated,
        );
        reindexTreeFts(row.project, tree);
      }
      db.exec("PRAGMA user_version = 2;");
    });
  } else {
    const missingCount =
      (
        db
          .prepare("SELECT COUNT(*) AS cnt FROM hc_trees t LEFT JOIN hc_tree_meta m ON m.project = t.project WHERE m.project IS NULL")
          .get() as { cnt: number } | undefined
      )?.cnt ?? 0;
    if (missingCount > 0) {
      runInImmediateTx(() => {
        const missing = db
          .prepare("SELECT t.project, t.body FROM hc_trees t LEFT JOIN hc_tree_meta m ON m.project = t.project WHERE m.project IS NULL")
          .all() as Array<{ project: string; body: string }>;
        if (missing.length === 0) return;
        const stamp = new Date().toISOString();
        for (const row of missing) {
          const tree = treeSchema.parse(JSON.parse(row.body));
          if (sanitizeTreeSecrets(tree)) {
            writeStmt.run(row.project, JSON.stringify(tree));
          }
          const meta = computeTreeMeta(row.project, tree, stamp);
          upsertMetaStmt.run(
            row.project,
            meta.goalCount,
            meta.outcomeCount,
            meta.inboxCount,
            meta.lastActivityAt,
            meta.hasRepo ? 1 : 0,
            meta.updated,
          );
          reindexTreeFts(row.project, tree);
        }
      });
    }
  }

  function read(project: string): Tree {
    const row = readStmt.get(project) as { body: string } | undefined;
    if (!row) return emptyTree();
    const tree = treeSchema.parse(JSON.parse(row.body));
    sanitizeTreeSecrets(tree);
    return tree;
  }

  function modify<T>(project: string, work: (tree: Tree) => T): T {
    return runInImmediateTx(() => {
      const row = readStmt.get(project) as { body: string } | undefined;
      const tree = row ? treeSchema.parse(JSON.parse(row.body)) : emptyTree();
      const sanitizedBefore = sanitizeTreeSecrets(tree);
      const beforeWork = JSON.stringify(tree);
      const result = work(tree);
      const sanitizedAfter = sanitizeTreeSecrets(tree);
      const nextBody = JSON.stringify(tree);
      const bodyChanged = row === undefined || sanitizedBefore || sanitizedAfter || nextBody !== beforeWork;
      const metaExists = hasMetaStmt.get(project) !== undefined;
      if (bodyChanged || !metaExists) {
        if (bodyChanged) {
          writeStmt.run(project, nextBody);
          reindexTreeFts(project, tree);
        }
        const meta = computeTreeMeta(project, tree);
        upsertMetaStmt.run(
          project,
          meta.goalCount,
          meta.outcomeCount,
          meta.inboxCount,
          meta.lastActivityAt,
          meta.hasRepo ? 1 : 0,
          meta.updated,
        );
      }
      return result;
    });
  }

  const mutationListeners = new Set<(event: TreeMutationEvent) => void>();
  function onMutation(listener: (event: TreeMutationEvent) => void): () => void {
    mutationListeners.add(listener);
    return () => mutationListeners.delete(listener);
  }

  function emitMutation(event: TreeMutationEvent): void {
    for (const listener of mutationListeners) {
      try {
        listener(event);
      } catch {
        // non-fatal listener error
      }
    }
  }

  function act(project: string, action: Action, meta?: ActionMeta): void {
    const before = mutationListeners.size > 0 ? view(project) : null;
    modify(project, (tree) => {
      const now = new Date().toISOString();
      const core = coreActions.safeParse(action);
      if (core.success) applyCore(tree, core.data, now, meta);
      else applyPlanning(tree, planningActions.parse(action), now, meta);
    });
    if (before && mutationListeners.size > 0) {
      emitMutation({ project, actions: [action], meta, before, after: view(project) });
    }
  }

  function actBatch(project: string, actions: readonly Action[], meta?: ActionMeta): void {
    if (actions.length === 0) return;
    const before = mutationListeners.size > 0 ? view(project) : null;
    modify(project, (tree) => {
      const now = new Date().toISOString();
      for (const action of actions) {
        const core = coreActions.safeParse(action);
        if (core.success) applyCore(tree, core.data, now, meta);
        else applyPlanning(tree, planningActions.parse(action), now, meta);
      }
    });
    if (before && mutationListeners.size > 0) {
      emitMutation({ project, actions, meta, before, after: view(project) });
    }
  }

  function applyEvidenceBatch(
    project: string,
    actions: readonly Extract<Action, { op: "add_evidence" }>[],
  ): void {
    modify(project, (tree) => {
      const now = new Date().toISOString();
      for (const action of actions) {
        const outcome = tree.outcomes.find((o) => o.key === action.key);
        if (outcome?.version !== action.version) {
          throw new Error("Evidence batch no longer matches the contract version for " + action.key);
        }
        applyCore(tree, action, now);
      }
    });
  }

  function treeProjects(): string[] {
    const rows = db.prepare("SELECT project FROM hc_trees").all() as Array<{ project: string }>;
    return rows.map((row) => row.project);
  }

  function registerProject(input: { id?: string; name?: string; directory?: string | null }): ProjectInfo {
    const directory = input.directory ? resolve(input.directory) : null;
    const baseName = input.name?.trim() || (directory ? basename(directory) : "") || input.id?.trim() || "project";
    const id =
      input.id?.trim() ||
      baseName
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") ||
      "project";
    const stamp = new Date().toISOString();
    upsertProjectStmt.run(id, baseName, directory, stamp, stamp);
    clearAntigravityProjectsCache();
    if (directory) {
      markMetaRepoStmt.run(id);
    }
    return { id, name: baseName, directory, source: "registered" };
  }

  function listProjects(): ProjectInfo[] {
    const byId = new Map<string, ProjectInfo>();
    // 1. Auto-discovered Antigravity projects
    for (const p of readAntigravityProjects()) {
      byId.set(p.id, p);
    }
    // 2. Registered Hill Climb projects (can enrich or override directory/name)
    const registered = db
      .prepare("SELECT id, name, directory FROM hc_projects ORDER BY updated DESC")
      .all() as Array<{ id: string; name: string; directory: string | null }>;
    for (const r of registered) {
      const existing = byId.get(r.id);
      byId.set(r.id, {
        id: r.id,
        name: r.name || existing?.name || r.id,
        directory: r.directory ?? existing?.directory ?? null,
        source: existing ? existing.source : "registered",
      });
    }
    // 3. Any project ID that already has a tree stored in hc_trees
    for (const id of treeProjects()) {
      if (!byId.has(id)) {
        byId.set(id, { id, name: id, directory: null, source: "tree" });
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function getProject(idOrDir: string): ProjectInfo | null {
    const all = listProjects();
    const byId = all.find((p) => p.id === idOrDir);
    if (byId) return byId;
    const byName = all.find((p) => p.name === idOrDir);
    if (byName) return byName;
    const abs = idOrDir.startsWith("/") ? resolve(idOrDir) : null;
    if (abs) {
      const byDir = all.find((p) => p.directory && resolve(p.directory) === abs);
      if (byDir) return byDir;
    }
    return null;
  }

  function resolveProjectId(override?: string | null, directory?: string | null): string {
    if (override && override.trim() !== "") {
      const found = getProject(override.trim());
      return found ? found.id : override.trim();
    }
    if (directory && directory.trim() !== "") {
      const abs = resolve(directory.trim());
      const found = getProject(abs);
      if (found) return found.id;
      const registered = registerProject({ directory: abs });
      return registered.id;
    }
    const envProject = process.env.ANTIGRAVITY_PROJECT_ID;
    if (envProject && envProject !== "outside-of-project") {
      return envProject;
    }
    const all = listProjects();
    if (all.length === 1 && all[0]) return all[0].id;
    return "default";
  }

  function view(project: string, track = "main"): Snapshot {
    return snapshot(read(project), track);
  }

  function inboxCountTotal(): number {
    return (sumInboxStmt.get() as { total: number } | undefined)?.total ?? 0;
  }

  function projectSummaries(): ProjectSummary[] {
    const rows = listMetaStmt.all() as Array<{
      project: string;
      goal_count: number;
      outcome_count: number;
      inbox_count: number;
      last_activity_at: string | null;
      has_repo: number;
      updated: string;
    }>;
    return rows.map((row) => ({
      project: row.project,
      goalCount: row.goal_count,
      outcomeCount: row.outcome_count,
      inboxCount: row.inbox_count,
      lastActivityAt: row.last_activity_at,
      hasRepo: row.has_repo !== 0,
      updated: row.updated,
    }));
  }

  // -------------------------------------------------------------------------
  // Settings, Saved Views, Focus Scopes, Artifacts, Hooks & FTS5 Search
  // -------------------------------------------------------------------------

  const getSettingStmt = db.prepare("SELECT value FROM hc_project_settings WHERE project = ? AND key = ?");
  const setSettingStmt = db.prepare(
    "INSERT INTO hc_project_settings(project, key, value, updated) VALUES(?, ?, ?, ?) ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated = excluded.updated",
  );

  function getSetting(project: string, key: string): string | null {
    const row = getSettingStmt.get(project, key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  function setSetting(project: string, key: string, value: string): void {
    setSettingStmt.run(project, key, value, new Date().toISOString());
  }

  function slugId(prefix: string, name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return `${prefix}_${base || "item"}_${Date.now().toString(36).slice(-4)}`;
  }

  function listViews(project: string): SavedView[] {
    const rows = db
      .prepare("SELECT id, name, filter_json, created, updated FROM hc_views WHERE project = ? ORDER BY updated DESC")
      .all(project) as Array<{ id: string; name: string; filter_json: string; created: string; updated: string }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      filter: JSON.parse(r.filter_json) as SavedViewFilter,
      created: r.created,
      updated: r.updated,
    }));
  }

  function saveView(project: string, input: { id?: string; name: string; filter: SavedViewFilter }): SavedView {
    const name = input.name.trim();
    if (!name) throw new Error("Saved view name must be non-empty");
    const now = new Date().toISOString();
    const id = input.id?.trim() || slugId("vw", name);
    const existing = db
      .prepare("SELECT created FROM hc_views WHERE project = ? AND id = ?")
      .get(project, id) as { created: string } | undefined;
    const created = existing?.created ?? now;
    db.prepare(
      `INSERT INTO hc_views(project, id, name, filter_json, created, updated) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(project, id) DO UPDATE SET name = excluded.name, filter_json = excluded.filter_json, updated = excluded.updated`,
    ).run(project, id, name, JSON.stringify(input.filter ?? {}), created, now);
    return { id, name, filter: input.filter ?? {}, created, updated: now };
  }

  function deleteView(project: string, id: string): boolean {
    const res = db.prepare("DELETE FROM hc_views WHERE project = ? AND id = ?").run(project, id);
    return Number(res.changes ?? 0) > 0;
  }

  function listScopes(project: string): FocusScope[] {
    const rows = db
      .prepare(
        "SELECT id, name, owner, release_name, goal_keys_json, tags_json, active, created, updated FROM hc_scopes WHERE project = ? ORDER BY active DESC, updated DESC",
      )
      .all(project) as Array<{
      id: string;
      name: string;
      owner: string | null;
      release_name: string | null;
      goal_keys_json: string;
      tags_json: string;
      active: number;
      created: string;
      updated: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      owner: r.owner,
      releaseName: r.release_name,
      goalKeys: JSON.parse(r.goal_keys_json) as string[],
      tags: JSON.parse(r.tags_json) as string[],
      active: r.active !== 0,
      created: r.created,
      updated: r.updated,
    }));
  }

  function saveScope(
    project: string,
    input: {
      id?: string;
      name: string;
      owner?: string | null;
      releaseName?: string | null;
      goalKeys?: string[];
      tags?: string[];
      active?: boolean;
    },
  ): FocusScope {
    const name = input.name.trim();
    if (!name) throw new Error("Focus scope name must be non-empty");
    const now = new Date().toISOString();
    const id = input.id?.trim() || slugId("sc", name);
    const existing = db
      .prepare("SELECT created FROM hc_scopes WHERE project = ? AND id = ?")
      .get(project, id) as { created: string } | undefined;
    const created = existing?.created ?? now;
    const active = Boolean(input.active);
    runInImmediateTx(() => {
      if (active) {
        db.prepare("UPDATE hc_scopes SET active = 0 WHERE project = ?").run(project);
      }
      db.prepare(
        `INSERT INTO hc_scopes(project, id, name, owner, release_name, goal_keys_json, tags_json, active, created, updated)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, id) DO UPDATE SET
           name = excluded.name,
           owner = excluded.owner,
           release_name = excluded.release_name,
           goal_keys_json = excluded.goal_keys_json,
           tags_json = excluded.tags_json,
           active = excluded.active,
           updated = excluded.updated`,
      ).run(
        project,
        id,
        name,
        input.owner?.trim() || null,
        input.releaseName?.trim() || null,
        JSON.stringify(input.goalKeys ?? []),
        JSON.stringify(input.tags ?? []),
        active ? 1 : 0,
        created,
        now,
      );
    });
    return {
      id,
      name,
      owner: input.owner?.trim() || null,
      releaseName: input.releaseName?.trim() || null,
      goalKeys: input.goalKeys ?? [],
      tags: input.tags ?? [],
      active,
      created,
      updated: now,
    };
  }

  function deleteScope(project: string, id: string): boolean {
    const res = db.prepare("DELETE FROM hc_scopes WHERE project = ? AND id = ?").run(project, id);
    return Number(res.changes ?? 0) > 0;
  }

  function resolveScopeOutcomeKeys(project: string, scopeRef: string | null | undefined, snap?: Snapshot): Set<string> | null {
    const treeSnap = snap ?? view(project);
    const scopes = listScopes(project);
    let chosen: FocusScope | undefined;
    if (scopeRef && scopeRef.trim() !== "") {
      const wanted = scopeRef.trim();
      chosen = scopes.find((s) => s.id === wanted || s.name.toLowerCase() === wanted.toLowerCase());
      if (!chosen) {
        // Also allow passing a release name, goal key, or tag:foo directly as an ad-hoc scope
        const byRelease = treeSnap.releases.find((r) => r.name.toLowerCase() === wanted.toLowerCase());
        if (byRelease) return new Set(byRelease.keys);
        if (treeSnap.goals.some((g) => g.key === wanted)) {
          return new Set(
            treeSnap.ranked
              .filter((r) => r.ancestors.some((g) => g.key === wanted))
              .map((r) => r.key),
          );
        }
        const tagName = wanted.startsWith("tag:") ? wanted.slice(4) : wanted;
        const tagged = treeSnap.ranked.filter((r) => (r.tags ?? []).includes(tagName)).map((r) => r.key);
        if (tagged.length > 0) return new Set(tagged);
        return new Set();
      }
    } else {
      return null;
    }
    const allowed = new Set<string>();
    if (chosen.releaseName) {
      for (const rel of treeSnap.releases) {
        if (rel.name === chosen.releaseName) rel.keys.forEach((k) => allowed.add(k));
      }
    }
    if (chosen.goalKeys.length > 0) {
      const gSet = new Set(chosen.goalKeys);
      for (const r of treeSnap.ranked) {
        if (r.ancestors.some((g) => gSet.has(g.key))) allowed.add(r.key);
      }
    }
    if (chosen.tags.length > 0) {
      const tSet = new Set(chosen.tags);
      for (const r of treeSnap.ranked) {
        if ((r.tags ?? []).some((t) => tSet.has(t))) allowed.add(r.key);
      }
    }
    return allowed;
  }

  function rowToArtifact(r: {
    id: string;
    folder: string;
    title: string;
    template: string | null;
    body: string;
    locked: number;
    version: number;
    history_json: string;
    citations_json: string;
    actor: string | null;
    created: string;
    updated: string;
  }): ArtifactRecord {
    return {
      id: r.id,
      folder: r.folder,
      title: r.title,
      template: r.template,
      body: r.body,
      locked: r.locked !== 0,
      version: r.version,
      history: JSON.parse(r.history_json) as ArtifactRevision[],
      citations: JSON.parse(r.citations_json) as string[],
      actor: r.actor,
      created: r.created,
      updated: r.updated,
    };
  }

  function listArtifacts(project: string, folder?: string): ArtifactRecord[] {
    const rows = folder
      ? (db
          .prepare("SELECT * FROM hc_artifacts WHERE project = ? AND folder = ? ORDER BY updated DESC")
          .all(project, folder) as Array<Parameters<typeof rowToArtifact>[0]>)
      : (db
          .prepare("SELECT * FROM hc_artifacts WHERE project = ? ORDER BY updated DESC")
          .all(project) as Array<Parameters<typeof rowToArtifact>[0]>);
    return rows.map(rowToArtifact);
  }

  function getArtifact(project: string, id: string): ArtifactRecord | null {
    const row = db
      .prepare("SELECT * FROM hc_artifacts WHERE project = ? AND id = ?")
      .get(project, id) as Parameters<typeof rowToArtifact>[0] | undefined;
    return row ? rowToArtifact(row) : null;
  }

  function saveArtifact(
    project: string,
    input: {
      id?: string;
      folder?: string;
      title: string;
      template?: string | null;
      body: string;
      citations?: string[];
      locked?: boolean;
      actor?: string | null;
    },
  ): ArtifactRecord {
    const title = redactSecrets(input.title.trim());
    if (!title) throw new Error("Artifact title must be non-empty");
    const body = redactSecrets(input.body);
    const folder = (input.folder?.trim() || "General").slice(0, 80);
    const now = new Date().toISOString();
    const id = input.id?.trim() || slugId("art", title);
    const existing = getArtifact(project, id);
    if (existing?.locked && input.locked !== false) {
      throw new Error(`Artifact "${existing.title}" (${id}) is locked; unlock it before editing.`);
    }
    const history: ArtifactRevision[] = existing ? [...existing.history] : [];
    let version = existing ? existing.version : 1;
    if (existing && (existing.body !== body || existing.title !== title)) {
      history.push({
        version: existing.version,
        title: existing.title,
        body: existing.body,
        actor: existing.actor,
        at: existing.updated,
      });
      version = existing.version + 1;
    }
    const locked = input.locked ?? existing?.locked ?? false;
    const citations = [...new Set(input.citations ?? existing?.citations ?? [])];
    const record: ArtifactRecord = {
      id,
      folder,
      title,
      template: input.template ?? existing?.template ?? null,
      body,
      locked,
      version,
      history,
      citations,
      actor: input.actor ?? existing?.actor ?? null,
      created: existing?.created ?? now,
      updated: now,
    };
    runInImmediateTx(() => {
      db.prepare(
        `INSERT INTO hc_artifacts(project, id, folder, title, template, body, locked, version, history_json, citations_json, actor, created, updated)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, id) DO UPDATE SET
           folder = excluded.folder,
           title = excluded.title,
           template = excluded.template,
           body = excluded.body,
           locked = excluded.locked,
           version = excluded.version,
           history_json = excluded.history_json,
           citations_json = excluded.citations_json,
           actor = excluded.actor,
           updated = excluded.updated`,
      ).run(
        project,
        record.id,
        record.folder,
        record.title,
        record.template,
        record.body,
        record.locked ? 1 : 0,
        record.version,
        JSON.stringify(record.history),
        JSON.stringify(record.citations),
        record.actor,
        record.created,
        record.updated,
      );
      reindexArtifactFts(project, record);
    });
    return record;
  }

  function deleteArtifact(project: string, id: string): boolean {
    const existing = getArtifact(project, id);
    if (existing?.locked) throw new Error(`Artifact "${id}" is locked; unlock it first.`);
    const res = db.prepare("DELETE FROM hc_artifacts WHERE project = ? AND id = ?").run(project, id);
    if (ftsAvailable && deleteFtsArtifactStmt) {
      deleteFtsArtifactStmt.run(project, id);
    }
    return Number(res.changes ?? 0) > 0;
  }

  function listHooks(project: string): HookRecord[] {
    const rows = db
      .prepare("SELECT * FROM hc_hooks WHERE project = ? ORDER BY updated DESC")
      .all(project) as Array<{
      id: string;
      event: string;
      target_type: string;
      target: string;
      enabled: number;
      secret: string | null;
      created: string;
      updated: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      event: r.event as HookEvent,
      targetType: r.target_type as HookRecord["targetType"],
      target: r.target,
      enabled: r.enabled !== 0,
      secret: r.secret,
      created: r.created,
      updated: r.updated,
    }));
  }

  function saveHook(
    project: string,
    input: {
      id?: string;
      event: HookEvent;
      targetType: HookRecord["targetType"];
      target: string;
      enabled?: boolean;
      secret?: string | null;
    },
  ): HookRecord {
    const target = input.target.trim();
    if (!target) throw new Error("Hook target must be non-empty");
    const now = new Date().toISOString();
    const id = input.id?.trim() || slugId("hk", `${input.event}-${input.targetType}`);
    const existing = db
      .prepare("SELECT created FROM hc_hooks WHERE project = ? AND id = ?")
      .get(project, id) as { created: string } | undefined;
    const created = existing?.created ?? now;
    const enabled = input.enabled ?? true;
    db.prepare(
      `INSERT INTO hc_hooks(project, id, event, target_type, target, enabled, secret, created, updated)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project, id) DO UPDATE SET
         event = excluded.event,
         target_type = excluded.target_type,
         target = excluded.target,
         enabled = excluded.enabled,
         secret = excluded.secret,
         updated = excluded.updated`,
    ).run(project, id, input.event, input.targetType, target, enabled ? 1 : 0, input.secret ?? null, created, now);
    return { id, event: input.event, targetType: input.targetType, target, enabled, secret: input.secret ?? null, created, updated: now };
  }

  function deleteHook(project: string, id: string): boolean {
    const res = db.prepare("DELETE FROM hc_hooks WHERE project = ? AND id = ?").run(project, id);
    return Number(res.changes ?? 0) > 0;
  }

  function sanitizeFtsQuery(raw: string): string {
    const terms = raw
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/["'*():^]/g, "").trim())
      .filter((t) => t.length > 0);
    if (terms.length === 0) return "";
    return terms.map((t) => `"${t}"*`).join(" AND ");
  }

  function search(
    project: string | null,
    query: string,
    opts?: { types?: SearchHit["entityType"][]; limit?: number },
  ): SearchHit[] {
    const q = query.trim();
    const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
    if (!q) return [];
    const typeFilter = opts?.types && opts.types.length > 0 ? new Set(opts.types) : null;
    if (ftsAvailable) {
      const ftsQuery = sanitizeFtsQuery(q);
      if (ftsQuery) {
        try {
          const sql = project
            ? `SELECT project, entity_type, entity_id, title, snippet(hc_fts, 4, '[', ']', '…', 20) AS snippet, bm25(hc_fts) AS score
               FROM hc_fts WHERE project = ? AND hc_fts MATCH ? ORDER BY score LIMIT ?`
            : `SELECT project, entity_type, entity_id, title, snippet(hc_fts, 4, '[', ']', '…', 20) AS snippet, bm25(hc_fts) AS score
               FROM hc_fts WHERE hc_fts MATCH ? ORDER BY score LIMIT ?`;
          const rows = (project
            ? db.prepare(sql).all(project, ftsQuery, limit * 2)
            : db.prepare(sql).all(ftsQuery, limit * 2)) as Array<{
            project: string;
            entity_type: SearchHit["entityType"];
            entity_id: string;
            title: string;
            snippet: string;
            score: number;
          }>;
          const filtered = rows
            .filter((r) => !typeFilter || typeFilter.has(r.entity_type))
            .slice(0, limit)
            .map((r) => ({
              project: r.project,
              entityType: r.entity_type,
              entityId: r.entity_id,
              title: r.title,
              snippet: r.snippet || r.title,
              rank: Number.isFinite(r.score) ? Number(r.score.toFixed(4)) : 0,
            }));
          if (filtered.length > 0) return filtered;
        } catch {
          // fall through to linear fallback
        }
      }
    }
    // Substring fallback (covers partial punctuation/UUID/non-FTS environments)
    const needle = q.toLowerCase();
    const pids = project ? [project] : treeProjects();
    const hits: SearchHit[] = [];
    const pushIf = (p: string, type: SearchHit["entityType"], id: string, title: string, body: string) => {
      if (typeFilter && !typeFilter.has(type)) return;
      const hay = `${title}\n${body}`.toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx === -1) return;
      const start = Math.max(0, idx - 40);
      hits.push({
        project: p,
        entityType: type,
        entityId: id,
        title,
        snippet: body.slice(start, start + 140).trim() || title,
        rank: idx,
      });
    };
    for (const p of pids) {
      const t = read(p);
      for (const g of t.goals) pushIf(p, "goal", g.key, `${g.key} ${g.title}`, `${g.brief} ${(g.tags ?? []).join(" ")}`);
      for (const o of t.outcomes) {
        pushIf(p, "outcome", o.key, `${o.key} ${o.title}`, `${o.story} ${o.criteria.map((c) => `${c.given} ${c.when} ${c.then}`).join(" ")}`);
      }
      for (const pl of t.plans) pushIf(p, "plan", `${pl.key}@v${pl.version}`, `${pl.key} plan v${pl.version}`, pl.body);
      for (const ev of t.evidence) pushIf(p, "evidence", ev.id, `${ev.key} ${ev.kind}`, `${ev.source} ${ev.text}`);
      for (const cm of t.comments) pushIf(p, "comment", cm.id, `${cm.key} comment`, `${cm.text} ${cm.answer ?? ""}`);
      for (const fl of t.flows) pushIf(p, "flow", fl.name, fl.name, fl.frames.map((fr) => `${fr.title} ${fr.notes ?? ""}`).join(" "));
      for (const art of listArtifacts(p)) pushIf(p, "artifact", art.id, art.title, art.body);
    }
    return hits.slice(0, limit);
  }

  function checkpointWal(): void {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // ignore checkpoint errors if DB is read-only or closed
    }
  }

  function close(): void {
    checkpointWal();
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }

  return {
    db,
    read,
    modify,
    act,
    actBatch,
    onMutation,
    applyEvidenceBatch,
    projects: treeProjects,
    listProjects,
    getProject,
    registerProject,
    resolveProjectId,
    view,
    inboxCountTotal,
    projectSummaries,
    getSetting,
    setSetting,
    listViews,
    saveView,
    deleteView,
    listScopes,
    saveScope,
    deleteScope,
    resolveScopeOutcomeKeys,
    listArtifacts,
    getArtifact,
    saveArtifact,
    deleteArtifact,
    listHooks,
    saveHook,
    deleteHook,
    search,
    checkpointWal,
    close,
  };
}

export type Repository = ReturnType<typeof createRepository>;
