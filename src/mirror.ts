import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Snapshot } from "./model.js";
import type { ArtifactRecord } from "./repository.js";
import type { ScannedProjectClimbs } from "./repo-ops.js";

export interface MirrorOptions {
  artifacts?: ArtifactRecord[];
  scannedClimbs?: ScannedProjectClimbs | null;
}

function safeFileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

export async function writeMirror(
  directory: string,
  tree: Snapshot,
  opts?: MirrorOptions,
): Promise<{ root: string; files: number; pruned: number }> {
  const entries: [string, string][] = [];
  const expectedByDir = new Map<string, Set<string>>([
    ["goals", new Set()],
    ["outcomes", new Set()],
    ["plans", new Set()],
    ["flows", new Set()],
    ["reports", new Set()],
    ["climbs", new Set()],
  ]);
  const track = (file: string) => {
    const slash = file.indexOf("/");
    if (slash > 0) {
      expectedByDir.get(file.slice(0, slash))?.add(basename(file));
    }
  };
  const add = (file: string, lines: string[]) => {
    track(file);
    entries.push([file, lines.join("\n") + "\n"]);
  };

  for (const g of tree.goals) {
    add("goals/" + g.key + ".md", [
      "# " + g.title,
      "",
      g.brief,
      "",
      ...(g.tags && g.tags.length > 0 ? ["Tags: " + g.tags.join(", "), ""] : []),
      "Parent: " + (g.parentGoalKey ?? "Charter"),
    ]);
  }

  for (const r of tree.ranked) {
    const o = tree.outcomes.find((item) => item.key === r.key)!;
    add("outcomes/" + o.key + ".md", [
      "# " + (r.sectionNumber ? r.sectionNumber + " " : "") + o.title,
      "",
      o.story,
      "",
      "Version " +
        o.version +
        " · " +
        r.signal +
        (r.availability && r.availability !== "active" ? " · " + r.availability : ""),
      ...(r.tags && r.tags.length > 0 ? ["Tags: " + r.tags.join(", ")] : []),
      "",
      ...r.ancestors.map((g) => g.title + " — " + g.brief),
      "",
      ...o.criteria.map(
        (c) =>
          "## " +
          c.id +
          "\n\nGiven " +
          c.given +
          "\nWhen " +
          c.when +
          "\nThen " +
          c.then,
      ),
    ]);
    const ledger = tree.evidence
      .filter((e) => e.key === o.key)
      .map((e) => JSON.stringify(e));
    const evidenceFile = "outcomes/" + o.key + ".evidence.jsonl";
    track(evidenceFile);
    entries.push([
      evidenceFile,
      ledger.length ? ledger.join("\n") + "\n" : "",
    ]);
    for (const p of tree.plans.filter((p) => p.key === o.key)) {
      add("plans/" + o.key + "-v" + p.version + ".md", [
        "# " + o.key + " · plan " + p.version,
        "",
        p.body,
      ]);
    }
  }

  for (const flow of tree.flows) {
    const flowLines = [
      `# ${flow.folder ? `${flow.folder} / ` : ""}${flow.name}`,
      ...(flow.designKit ? ["", `Design Kit: \`${flow.designKit}\``] : []),
      "",
      ...flow.frames.flatMap((fr, idx) => [
        `## Step ${idx + 1}: ${fr.title} (v${fr.version ?? 1})`,
        `- Outcome: \`${fr.key}\` · Criterion: \`${fr.criterionId}\` · Kind: \`${fr.kind ?? "html"}\``,
        ...(fr.imagePath ? [`- Image: \`${fr.imagePath}\``] : []),
        ...(fr.notes ? [`- Notes: ${fr.notes}`] : []),
        ...(fr.driftDetected ? [`- Drift: DETECTED (${fr.driftNote ?? "live differs from approved"})`] : []),
        ...fr.pins.map(
          (p) =>
            `  - [${p.resolved ? "x" : " "}]${p.forAgents ? " (for-agents)" : ""} (${Math.round(p.x * 100)}%, ${Math.round(p.y * 100)}%) ${p.text}`,
        ),
        "",
      ]),
    ];
    add(`flows/${safeFileSlug(flow.name)}.md`, flowLines);
  }

  for (const art of opts?.artifacts ?? []) {
    add(`reports/${safeFileSlug(art.id)}.md`, [
      `<!-- hillclimb-artifact: ${art.id} · folder: ${art.folder} · v${art.version}${art.locked ? " · locked" : ""} -->`,
      art.body,
    ]);
  }

  for (const climb of opts?.scannedClimbs?.climbs ?? []) {
    const holdoutScore = [...climb.rows].reverse().find((r) => r.kind === "holdout" && typeof r.score === "number")?.score ?? null;
    add(`climbs/${safeFileSlug(climb.name)}.md`, [
      `# Climb: ${climb.name}`,
      "",
      `- Origin: ${climb.workerLabel} (\`${climb.origin}\`) · Status: \`${climb.status}\` · Verdict: \`${climb.verdict}\``,
      `- Baseline: ${climb.baseline ?? "—"} · Best: ${climb.best ?? "—"} · Target: ${climb.target ?? "—"} · Holdout: ${holdoutScore ?? "—"}`,
      `- Steps: ${climb.kept}/${climb.steps} kept`,
      ...(climb.notes ? ["", "## Notes", "", climb.notes] : []),
    ]);
  }

  entries.push(["tree.json", JSON.stringify(tree, null, 2) + "\n"]);
  add("INDEX.md", [
    "# Hill Climb",
    "",
    "Generated from the Antigravity Hill Climb project contract tree.",
    "",
    ...tree.ranked.map((r) => "- [" + r.key + "](outcomes/" + r.key + ".md) · " + r.signal),
  ]);

  const root = join(directory.replace(/\/$/, ""), ".hillclimb");
  for (const [name, content] of entries) {
    const fullPath = join(root, name);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  let pruned = 0;
  for (const subdir of ["outcomes", "plans", "goals", "flows", "reports", "climbs"] as const) {
    const expected = expectedByDir.get(subdir)!;
    const dirPath = join(root, subdir);
    let dirEntries;
    try {
      dirEntries = await readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of dirEntries) {
      if (!expected.has(entry.name)) {
        await rm(join(dirPath, entry.name), { recursive: true, force: true });
        pruned += 1;
      }
    }
  }
  return { root, files: entries.length, pruned };
}
