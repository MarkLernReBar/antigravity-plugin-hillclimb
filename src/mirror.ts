import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Snapshot } from "./model.js";

export async function writeMirror(directory: string, tree: Snapshot): Promise<{ root: string; files: number }> {
  const entries: [string, string][] = [];
  const add = (file: string, lines: string[]) => entries.push([file, lines.join("\n") + "\n"]);

  for (const g of tree.goals) {
    add("goals/" + g.key + ".md", [
      "# " + g.title,
      "",
      g.brief,
      "",
      "Parent: " + (g.parentGoalKey ?? "Charter"),
    ]);
  }

  for (const r of tree.ranked) {
    const o = tree.outcomes.find((item) => item.key === r.key)!;
    add("outcomes/" + o.key + ".md", [
      "# " + o.title,
      "",
      o.story,
      "",
      "Version " + o.version + " · " + r.signal,
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
    entries.push([
      "outcomes/" + o.key + ".evidence.jsonl",
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
  return { root, files: entries.length };
}
