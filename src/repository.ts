import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Action } from "./actions.js";
import { coreActions, planningActions } from "./actions.js";
import { treeSchema } from "./tree-schema.js";
import { applyCore, snapshot } from "./tree.js";
import { applyPlanning } from "./planning.js";
import { emptyTree, type Snapshot, type Tree } from "./model.js";
import { redactSecrets } from "./state.js";

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
          "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name IN ('hc_trees', 'hc_projects', 'hc_tree_meta')",
        )
        .get() as { cnt: number } | undefined
    )?.cnt ?? 0;

  if (existingTableCount < 3) {
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
      `);
    });
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
        tree.comments.filter((c) => c.answer === null).length,
      lastActivityAt: tree.activity.length > 0 ? tree.activity[tree.activity.length - 1]!.at : null,
      hasRepo: projectHasRepo(project),
      updated: stamp,
    };
  }

  const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
  if (userVersion < 1) {
    runInImmediateTx(() => {
      const currentVersion =
        (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
      if (currentVersion >= 1) return;
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
      }
      db.exec("PRAGMA user_version = 1;");
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

  function act(project: string, action: Action): void {
    modify(project, (tree) => {
      const now = new Date().toISOString();
      const core = coreActions.safeParse(action);
      if (core.success) applyCore(tree, core.data, now);
      else applyPlanning(tree, planningActions.parse(action), now);
    });
  }

  function actBatch(project: string, actions: readonly Action[]): void {
    if (actions.length === 0) return;
    modify(project, (tree) => {
      const now = new Date().toISOString();
      for (const action of actions) {
        const core = coreActions.safeParse(action);
        if (core.success) applyCore(tree, core.data, now);
        else applyPlanning(tree, planningActions.parse(action), now);
      }
    });
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
    applyEvidenceBatch,
    projects: treeProjects,
    listProjects,
    getProject,
    registerProject,
    resolveProjectId,
    view,
    inboxCountTotal,
    projectSummaries,
    checkpointWal,
    close,
  };
}

export type Repository = ReturnType<typeof createRepository>;
