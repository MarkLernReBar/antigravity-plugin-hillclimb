// Where the climb engine lives, and how it gets into a repository.
//
// The engine (climb.py, judge.py) is adapted from Bil0000/Hill-Climb
// under assets/engine. It has to run in the same shell an agent edits code in,
// so the plugin writes it into the repository it will climb, under
// `.hill-climb/engine/`, and keeps that path out of git the same way the engine
// itself does (`info/exclude`, never the tracked .gitignore).
//
// Everything here is pure: paths in, paths out. Filesystem IO lives in repo-ops.ts.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const STATE_DIR = ".hill-climb";
export const ENGINE_SUBDIR = "engine";
export const ENGINE_FILES = ["climb.py", "judge.py"] as const;
export const IGNORE_RULE = "/.hill-climb/";

export type EngineFile = (typeof ENGINE_FILES)[number];

/** Trailing slashes never matter for these joins. */
export function joinPath(base: string, ...parts: string[]): string {
  const trimmed = base.replace(/\/+$/, "");
  const rest = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter((part) => part !== "")
    .join("/");
  return rest === "" ? trimmed : `${trimmed}/${rest}`;
}

export function engineDir(repoPath: string): string {
  return joinPath(repoPath, STATE_DIR, ENGINE_SUBDIR);
}

export function engineFile(repoPath: string, name: EngineFile): string {
  return joinPath(engineDir(repoPath), name);
}

/** The `CLIMB` path the skill tells an agent to use. */
export function climbCommand(repoPath: string): string {
  return `python3 "${engineFile(repoPath, "climb.py")}"`;
}

export function stateDir(repoPath: string): string {
  return joinPath(repoPath, STATE_DIR);
}

/** Normalize `a/b/../c` without touching the disk. */
export function resolvePath(base: string, relative: string): string {
  if (isAbsolute(relative)) return normalize(relative);
  return normalize(join(base, relative));
}

export function hasIgnoreRule(excludeText: string | null): boolean {
  if (excludeText === null) return false;
  return excludeText.split("\n").some((line) => line.trim() === IGNORE_RULE);
}

export function withIgnoreRule(excludeText: string | null): string {
  const text = excludeText ?? "";
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  return `${text}${separator}${IGNORE_RULE}\n`;
}

export type GitLayout =
  | { kind: "directory"; excludePath: string }
  | { kind: "worktree"; excludePath: string };

/**
 * `info/exclude` for the repository at `repoPath`.
 *
 * A normal repository keeps it in `.git/`; a linked worktree points `.git` at a
 * `gitdir` whose `commondir` names the shared git directory, where exclude
 * lives. Getting this wrong would leave the engine untracked instead of
 * ignored, and `climb.py init` would then refuse to start.
 */
export function excludePath(
  repoPath: string,
  layout: { dotGitIsDirectory: boolean; dotGitText?: string; commonDirText?: string | null },
): GitLayout {
  if (layout.dotGitIsDirectory) {
    return { kind: "directory", excludePath: joinPath(repoPath, ".git", "info", "exclude") };
  }
  const pointer = (layout.dotGitText ?? "").trim();
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (match === null || match[1] === undefined) {
    throw new Error("`.git` is neither a directory nor a `gitdir:` pointer");
  }
  const gitdir = resolvePath(repoPath, match[1].trim());
  const common = layout.commonDirText?.trim();
  const shared = common !== undefined && common !== "" ? resolvePath(gitdir, common) : gitdir;
  return { kind: "worktree", excludePath: joinPath(shared, "info", "exclude") };
}

// ---------------------------------------------------------------------------
// Bundled engine source
// ---------------------------------------------------------------------------

function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "..", "assets", "engine"), join(here, "assets", "engine"), join(here, "..", "..", "assets", "engine")];
}

let cachedRoot: string | null = null;

/** Read one vendored script from the plugin's own directory. */
export function readEngineSource(name: EngineFile): string {
  const roots = cachedRoot === null ? candidates() : [cachedRoot];
  for (const root of roots) {
    try {
      const text = readFileSync(join(root, name), "utf8");
      cachedRoot = root;
      return text;
    } catch {
      continue;
    }
  }
  throw new Error(`the bundled engine is missing ${name}; reinstall the plugin`);
}

/** Install the released kit scripts and examples alongside the checkout's private engine. */
export function bundledKitFiles(): Array<{ path: string; content: string }> {
  // Resolving the engine locates assets in both the source and built layouts.
  readEngineSource("climb.py");
  const root = join(cachedRoot!, "..", "kits");
  function collect(relative: string): Array<{ path: string; content: string }> {
    const entries = readdirSync(join(root, relative), { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const path = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory() && entry.name !== "__pycache__") return collect(path);
      if (!entry.isFile() || entry.name.startsWith(".") || !/\.(py|md|json|jsonl)$/.test(entry.name)) return [];
      return [{ path, content: readFileSync(join(root, path), "utf8") }];
    });
  }
  return collect("");
}
