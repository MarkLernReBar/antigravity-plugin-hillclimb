import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Action } from "./actions.js";
import { coreActions, planningActions } from "./actions.js";
import { treeSchema } from "./tree-schema.js";
import { applyCore, snapshot } from "./tree.js";
import { applyPlanning } from "./planning.js";
import { emptyTree, type Snapshot, type Tree } from "./model.js";

export interface ProjectInfo {
  id: string;
  name: string;
  directory: string | null;
  source: "antigravity" | "registered" | "tree";
}

export function defaultDataDir(): string {
  return (
    process.env.HILLCLIMB_DATA_DIR ||
    process.env.PLUGIN_DATA ||
    join(homedir(), ".gemini", "antigravity", "plugin_data", "hillclimb")
  );
}

export function openDatabase(dataDir = defaultDataDir()): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "hillclimb.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function readAntigravityProjects(): ProjectInfo[] {
  const dir = join(homedir(), ".gemini", "config", "projects");
  if (!existsSync(dir)) return [];
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
  return results;
}

export function createRepository(db: DatabaseSync) {
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
  `);

  const readStmt = db.prepare("SELECT body FROM hc_trees WHERE project = ?");
  const writeStmt = db.prepare(
    "INSERT INTO hc_trees(project, body) VALUES(?, ?) ON CONFLICT(project) DO UPDATE SET body = excluded.body",
  );
  const upsertProjectStmt = db.prepare(
    `INSERT INTO hc_projects(id, name, directory, created, updated) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, directory = COALESCE(excluded.directory, hc_projects.directory), updated = excluded.updated`,
  );

  function read(project: string): Tree {
    const row = readStmt.get(project) as { body: string } | undefined;
    return row ? treeSchema.parse(JSON.parse(row.body)) : emptyTree();
  }

  function modify<T>(project: string, work: (tree: Tree) => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const tree = read(project);
      const result = work(tree);
      writeStmt.run(project, JSON.stringify(treeSchema.parse(tree)));
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

  function act(project: string, action: Action): void {
    modify(project, (tree) => {
      const now = new Date().toISOString();
      const core = coreActions.safeParse(action);
      if (core.success) applyCore(tree, core.data, now);
      else applyPlanning(tree, planningActions.parse(action), now);
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

  return {
    db,
    read,
    modify,
    act,
    applyEvidenceBatch,
    projects: treeProjects,
    listProjects,
    getProject,
    registerProject,
    resolveProjectId,
    view,
  };
}

export type Repository = ReturnType<typeof createRepository>;
