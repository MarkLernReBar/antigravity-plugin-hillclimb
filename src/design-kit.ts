import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface ComponentInfo {
  name: string;
  path: string;
  exports: string[];
  propsHint: string[];
  styleImports: string[];
}

export interface DesignKitScan {
  directory: string;
  designDocs: Array<{ path: string; excerpt: string }>;
  stylesheets: string[];
  tokens: Record<string, string>;
  tokenStyleBlock: string;
  tailwindDetected: boolean;
  components: ComponentInfo[];
  componentSnippet?: { path: string; content: string; truncated: boolean } | null;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".hill-climb",
  ".hillclimb",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
]);

const COMPONENT_EXTS = new Set([".tsx", ".jsx", ".vue", ".svelte"]);
const STYLE_EXTS = new Set([".css", ".scss"]);
const COMPONENT_DIR_HINTS = [
  "src/components",
  "components",
  "src/ui",
  "ui",
  "app/components",
  "packages/ui/src",
  "packages/ui/components",
  "lib/components",
  "frontend/src/components",
  "web/src/components",
];

const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function walkFiles(root: string, maxFiles: number, maxDepth: number, filter: (relPath: string, name: string) => boolean): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < maxFiles) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) break;
      if (ent.name.startsWith(".") && ent.name !== ".storybook") continue;
      const full = join(cur.dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (cur.depth < maxDepth) stack.push({ dir: full, depth: cur.depth + 1 });
      } else if (ent.isFile()) {
        const rel = relative(root, full).replace(/\\/g, "/");
        if (filter(rel, ent.name)) out.push(rel);
      }
    }
  }
  return out.sort();
}

function parseComponentFile(repoDir: string, relPath: string): ComponentInfo | null {
  let content: string;
  try {
    const st = statSync(join(repoDir, relPath));
    if (st.size > 200_000) return null;
    content = readFileSync(join(repoDir, relPath), "utf8");
  } catch {
    return null;
  }

  const exports = new Set<string>();
  const fnRe = /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g;
  for (const m of content.matchAll(fnRe)) {
    if (m[1]) exports.add(m[1]);
  }
  const constRe = /export\s+(?:const|let|class)\s+([A-Z][A-Za-z0-9_]*)\b/g;
  for (const m of content.matchAll(constRe)) {
    if (m[1]) exports.add(m[1]);
  }
  const baseName = basename(relPath, extname(relPath));
  if (exports.size === 0 && /^[A-Z]/.test(baseName)) {
    exports.add(baseName);
  }
  if (exports.size === 0) return null;

  const propsHint: string[] = [];
  const propsBlock = content.match(/(?:interface|type)\s+[A-Za-z0-9_]*Props[^{=]*[={]\s*\{([\s\S]{1,1200}?)\}/);
  if (propsBlock?.[1]) {
    for (const line of propsBlock[1].split(/\r?\n/)) {
      const pm = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/);
      if (pm?.[1] && propsHint.length < 10) propsHint.push(pm[1]);
    }
  }

  const styleImports: string[] = [];
  for (const m of content.matchAll(/import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+\.(?:css|scss))['"]/g)) {
    if (m[1] && styleImports.length < 4) styleImports.push(m[1]);
  }

  return {
    name: [...exports][0] ?? baseName,
    path: relPath,
    exports: [...exports].slice(0, 6),
    propsHint,
    styleImports,
  };
}

function extractCssTokens(repoDir: string, stylesheets: string[]): Record<string, string> {
  const tokens: Record<string, string> = {};
  const maxTokens = 120;
  for (const rel of stylesheets.slice(0, 14)) {
    if (Object.keys(tokens).length >= maxTokens) break;
    let css: string;
    try {
      const st = statSync(join(repoDir, rel));
      if (st.size > 300_000) continue;
      css = readFileSync(join(repoDir, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of css.matchAll(/(--[a-zA-Z0-9_-]{2,50})\s*:\s*([^;{}\n]{1,90});/g)) {
      const key = m[1]?.trim();
      const val = m[2]?.trim();
      if (!key || !val || tokens[key] !== undefined) continue;
      tokens[key] = val;
      if (Object.keys(tokens).length >= maxTokens) break;
    }
  }
  return tokens;
}

export function scanDesignKit(
  repoDir: string,
  opts?: { componentQuery?: string; readComponent?: string; limit?: number },
): DesignKitScan {
  const root = realpathSync(repoDir);
  const designDocs: Array<{ path: string; excerpt: string }> = [];
  for (const candidate of ["DESIGN.md", "design.md", "docs/DESIGN.md", "docs/design-system.md", "tokens.json"]) {
    const full = join(root, candidate);
    if (existsSync(full)) {
      try {
        const raw = readFileSync(full, "utf8");
        designDocs.push({
          path: candidate,
          excerpt: raw.length > 2400 ? `${raw.slice(0, 2400)}\n…[truncated]` : raw,
        });
      } catch {
        // ignore unreadable doc
      }
    }
  }

  const tailwindDetected =
    existsSync(join(root, "tailwind.config.js")) ||
    existsSync(join(root, "tailwind.config.ts")) ||
    existsSync(join(root, "tailwind.config.mjs")) ||
    existsSync(join(root, "tailwind.config.cjs"));

  const stylesheets = walkFiles(root, 40, 4, (rel, name) => {
    const ext = extname(name).toLowerCase();
    if (!STYLE_EXTS.has(ext)) return false;
    return !rel.includes(".min.");
  });
  // Prioritize theme/token/global stylesheets first
  stylesheets.sort((a, b) => {
    const score = (p: string) =>
      /(theme|token|global|variables|root|design|shell|index|app)\./i.test(p) ? 0 : 1;
    return score(a) - score(b) || a.localeCompare(b);
  });

  const tokens = extractCssTokens(root, stylesheets);
  const tokenEntries = Object.entries(tokens);
  const tokenStyleBlock =
    tokenEntries.length > 0
      ? `:root {\n${tokenEntries.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`
      : "";

  const candidateFiles = new Set<string>();
  for (const hint of COMPONENT_DIR_HINTS) {
    const dir = join(root, hint);
    if (!existsSync(dir)) continue;
    for (const rel of walkFiles(dir, 120, 4, (_r, name) => COMPONENT_EXTS.has(extname(name).toLowerCase()))) {
      candidateFiles.add(join(hint, rel).replace(/\\/g, "/"));
    }
  }
  if (candidateFiles.size === 0) {
    for (const rel of walkFiles(root, 80, 4, (_r, name) => COMPONENT_EXTS.has(extname(name).toLowerCase()))) {
      candidateFiles.add(rel);
    }
  }

  const query = opts?.componentQuery?.trim().toLowerCase() ?? "";
  const limit = Math.min(Math.max(opts?.limit ?? 35, 1), 80);
  const components: ComponentInfo[] = [];
  for (const rel of [...candidateFiles].sort()) {
    if (rel.includes(".test.") || rel.includes(".spec.") || rel.includes(".stories.")) continue;
    const parsed = parseComponentFile(root, rel);
    if (!parsed) continue;
    if (query) {
      const hay = `${parsed.name} ${parsed.path} ${parsed.exports.join(" ")} ${parsed.propsHint.join(" ")}`.toLowerCase();
      if (!hay.includes(query)) continue;
    }
    components.push(parsed);
    if (components.length >= limit) break;
  }

  let componentSnippet: { path: string; content: string; truncated: boolean } | null = null;
  if (opts?.readComponent) {
    const resolvedPath = resolveSafeWorkspacePath(root, opts.readComponent);
    if (resolvedPath && existsSync(resolvedPath)) {
      try {
        const raw = readFileSync(resolvedPath, "utf8");
        const maxChars = 6000;
        componentSnippet = {
          path: relative(root, resolvedPath).replace(/\\/g, "/"),
          content: raw.length > maxChars ? raw.slice(0, maxChars) : raw,
          truncated: raw.length > maxChars,
        };
      } catch {
        componentSnippet = null;
      }
    }
  }

  return {
    directory: root,
    designDocs,
    stylesheets: stylesheets.slice(0, 15),
    tokens,
    tokenStyleBlock,
    tailwindDetected,
    components,
    ...(opts?.readComponent ? { componentSnippet } : {}),
  };
}

export function resolveSafeWorkspacePath(repoDir: string, inputPath: string): string | null {
  try {
    const root = realpathSync(repoDir);
    const cleaned = inputPath.trim().replace(/^file:\/\//, "");
    const target = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
    const realTarget = existsSync(target) ? realpathSync(target) : target;
    const rel = relative(root, realTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return realTarget;
  } catch {
    return null;
  }
}

export function readWorkspaceImageDataUri(repoDir: string | null, imagePath: string): string | null {
  const trimmed = imagePath.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:image/")) return trimmed;
  if (!repoDir) return null;
  const resolved = resolveSafeWorkspacePath(repoDir, trimmed);
  if (!resolved || !existsSync(resolved)) return null;
  const ext = extname(resolved).toLowerCase();
  const mime = IMAGE_MIMES[ext];
  if (!mime) return null;
  try {
    const st = statSync(resolved);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    const buf = readFileSync(resolved);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
