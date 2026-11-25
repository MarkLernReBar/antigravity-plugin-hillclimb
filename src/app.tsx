import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { Action } from "./actions.js";
import type { Outcome, Snapshot } from "./model.js";
import type { Rig } from "./rig.js";
import type { LiveData } from "./view-props.js";
import { RigEditor } from "./ui/RigEditor.js";
import { TreeView } from "./ui/TreeView.js";
import { OutcomeDrawer } from "./ui/OutcomeDrawer.js";
import { Portfolio, type PromotionPreviewRow } from "./ui/Portfolio.js";
import { RepoClimbsView, type RepoClimbsPayload } from "./ui/RepoClimbsView.js";
import "./ui/shell.css";
import "./ui/tree.css";
import "./ui/portfolio.css";
import "./ui/antigravity-theme.css";

interface ProjectItem {
  id: string;
  name: string;
  directory: string | null;
  source: string;
}

interface InitialPayload {
  projects?: ProjectItem[];
  projectId?: string;
  page?: Page;
  outcomeKey?: string | null;
  track?: string;
  tree?: Snapshot;
  repoClimbs?: RepoClimbsPayload;
  inboxCount?: number;
}

interface LintFinding {
  id: string;
  itemKey: string;
  checkCode: string;
  checkTitle: string;
  severity: string;
  issue: string;
  proposed?: string;
}

interface LintReport {
  passed: boolean;
  errorCount: number;
  warningCount: number;
  findings: LintFinding[];
}

const PAGES = ["tree", "climbs", "inbox", "roadmap", "flows"] as const;
type Page = (typeof PAGES)[number];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function unwrapToolResult<T>(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): T {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text")?.text ?? "Tool call failed";
    throw new Error(text);
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text) {
    return JSON.parse(text) as T;
  }
  throw new Error("Empty tool response");
}

function isDecision(action: Action): boolean {
  return action.op === "approve_change" || action.op === "reject_change" || action.op === "promote_track";
}

function HillClimbApp() {
  const appRef = useRef<App | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [project, setProject] = useState<string>("");
  const [page, setPage] = useState<Page>("tree");
  const [track, setTrack] = useState("main");
  const [selected, setSelected] = useState<string | null>(null);
  const [tree, setTree] = useState<Snapshot | null>(null);
  const [repoClimbs, setRepoClimbs] = useState<RepoClimbsPayload | null>(null);
  const [climbsLoading, setClimbsLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [editor, setEditor] = useState<{
    outcome: Outcome;
    existing: Rig | null;
    engine: "repo" | "search";
  } | null>(null);

  const [confirmDecision, setConfirmDecision] = useState<{
    action: Action;
    details: unknown;
    previous: unknown;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [newProjDir, setNewProjDir] = useState("");

  const [lintReport, setLintReport] = useState<LintReport | null>(null);

  const callTool = useCallback(async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const client = appRef.current;
    if (!client) throw new Error("Not connected to MCP host yet.");
    const res = await client.callServerTool({ name, arguments: args });
    return unwrapToolResult<T>(res);
  }, []);

  const loadProjects = useCallback(async () => {
    const res = await callTool<{ projects: ProjectItem[]; inboxCount: number }>("app_projects");
    setProjects(res.projects);
    setInboxCount(res.inboxCount);
    setProject((prev) => prev || res.projects[0]?.id || "default");
  }, [callTool]);

  const loadTree = useCallback(
    async (pid: string, trk: string) => {
      if (!pid) return;
      try {
        setTreeError(null);
        const res = await callTool<{ tree: Snapshot; repoClimbs?: RepoClimbsPayload; inboxCount: number }>("app_tree", {
          projectId: pid,
          track: trk,
        });
        setTree(res.tree);
        if (res.repoClimbs) setRepoClimbs(res.repoClimbs);
        setInboxCount(res.inboxCount);
      } catch (e) {
        setTreeError(errMsg(e));
      }
    },
    [callTool],
  );

  const loadRepoClimbs = useCallback(
    async (pid: string) => {
      if (!pid) return;
      setClimbsLoading(true);
      try {
        const res = await callTool<{ tree: Snapshot; repoClimbs: RepoClimbsPayload; inboxCount: number }>("app_tree", {
          projectId: pid,
          track,
        });
        setTree(res.tree);
        setRepoClimbs(res.repoClimbs);
        setInboxCount(res.inboxCount);
      } catch {
        // non-fatal
      } finally {
        setClimbsLoading(false);
      }
    },
    [callTool, track],
  );

  const handleToggleAutoTrack = useCallback(
    async (enabled: boolean) => {
      if (!project) return;
      try {
        const res = await callTool<{
          ok: true;
          autoTrackClimbs: boolean;
          tree: Snapshot;
          repoClimbs: RepoClimbsPayload;
          inboxCount: number;
        }>("app_set_auto_track", { projectId: project, enabled, track });
        setTree(res.tree);
        setRepoClimbs(res.repoClimbs);
        setInboxCount(res.inboxCount);
        setNotice(
          enabled
            ? "Auto-track enabled: current climbs are synced into Outcomes automatically."
            : "Auto-track paused for new climbs. Existing outcomes remain untouched.",
        );
      } catch (e) {
        setNotice(`Could not update auto-track setting: ${errMsg(e)}`);
      }
    },
    [project, track, callTool],
  );

  const handleTrackClimb = useCallback(
    async (climbId: string) => {
      if (!project) return;
      try {
        const res = await callTool<{
          ok: true;
          outcomeKey: string;
          tree: Snapshot;
          repoClimbs: RepoClimbsPayload;
          inboxCount: number;
        }>("app_track_climb", { projectId: project, climbId, track });
        setTree(res.tree);
        setRepoClimbs(res.repoClimbs);
        setInboxCount(res.inboxCount);
        setNotice(`Tracked climb in Outcomes as ${res.outcomeKey}.`);
      } catch (e) {
        setNotice(`Could not track climb: ${errMsg(e)}`);
      }
    },
    [project, track, callTool],
  );

  const handleOpenOutcomeFromClimb = useCallback((outcomeKey: string) => {
    setPage("tree");
    setSelected(outcomeKey);
  }, []);

  // Connect once using the MCP Apps SDK, registering handlers BEFORE connect().
  useEffect(() => {
    const app = new App({ name: "Hill Climb", version: "0.3.0" }, {});
    appRef.current = app;

    const applyThemeFromContext = (ctx: ReturnType<App["getHostContext"]>) => {
      if (!ctx) return;
      if (ctx.theme) {
        applyDocumentTheme(ctx.theme);
        document.documentElement.setAttribute("data-theme", ctx.theme);
      }
      if (ctx.styles?.variables) {
        applyHostStyleVariables(ctx.styles.variables);
      }
    };

    app.ontoolinput = () => {
      // Initial loading state handled naturally
    };

    app.ontoolresult = (result) => {
      try {
        const data = unwrapToolResult<InitialPayload>(result);
        if (data.projects) setProjects(data.projects);
        if (data.projectId) setProject(data.projectId);
        if (data.page && PAGES.includes(data.page)) setPage(data.page);
        if (data.outcomeKey !== undefined) setSelected(data.outcomeKey);
        if (data.track) setTrack(data.track);
        if (data.tree) setTree(data.tree);
        if (data.repoClimbs) setRepoClimbs(data.repoClimbs);
        if (typeof data.inboxCount === "number") setInboxCount(data.inboxCount);
      } catch {
        // Ignore non-structured results
      }
    };

    app.onhostcontextchanged = (ctx) => {
      applyThemeFromContext(ctx);
    };

    void app
      .connect()
      .then(() => {
        applyThemeFromContext(app.getHostContext());
        setConnected(true);
      })
      .catch((error) => {
        setConnectError(errMsg(error));
      });
  }, []);

  // Load projects if we connected without receiving an initial tool result yet
  useEffect(() => {
    if (!connected) return;
    if (projects.length === 0) {
      void loadProjects().catch((e) => setTreeError(errMsg(e)));
    }
  }, [connected, projects.length, loadProjects]);

  // Reload tree whenever project/track changes + quiet background poll (faster on Climbs tab)
  useEffect(() => {
    if (!connected || !project) return;
    void loadTree(project, track);
    const intervalMs = page === "climbs" ? 10_000 : 30_000;
    const timer = setInterval(() => void loadTree(project, track), intervalMs);
    return () => clearInterval(timer);
  }, [connected, project, track, page, loadTree]);

  const askConfirmation = useCallback(
    async (action: Action): Promise<boolean> => {
      let details: unknown = action;
      let previous: unknown = null;
      if (tree) {
        if ("id" in action && (action.op === "approve_change" || action.op === "reject_change")) {
          const change = tree.changes.find((c) => c.id === action.id);
          details = change ?? action;
          if (change) {
            previous = tree.outcomes.find((o) => o.key === change.key) ?? null;
          }
        } else if (action.op === "promote_track") {
          try {
            details = await callTool("app_preview", {
              projectId: project,
              name: action.name,
              keys: action.keys,
            });
          } catch {
            details = action;
          }
        }
      }
      return new Promise<boolean>((resolve) => {
        setConfirmDecision({ action, details, previous, resolve });
      });
    },
    [tree, project, callTool],
  );

  const act = useCallback(
    async (action: Action) => {
      if (!project) throw new Error("Select a project first.");
      let confirmed = false;
      if (isDecision(action)) {
        confirmed = await askConfirmation(action);
        if (!confirmed) throw new Error("Decision cancelled. The contract is unchanged.");
      }
      const res = await callTool<{ ok: true; tree: Snapshot }>("app_act", {
        projectId: project,
        action,
        confirmed,
      });
      setTree(res.tree);
      await loadProjects();
    },
    [project, askConfirmation, callTool, loadProjects],
  );

  const preview = useCallback(
    async (name: string, keys: string[]): Promise<PromotionPreviewRow[]> => {
      const res = await callTool<{ rows: PromotionPreviewRow[] }>("app_preview", {
        projectId: project,
        name,
        keys,
      });
      return res.rows;
    },
    [project, callTool],
  );

  const live = useCallback(
    async (key: string): Promise<LiveData> => {
      return callTool<LiveData>("app_live", { projectId: project, key, track });
    },
    [project, track, callTool],
  );

  const configure = useCallback(
    async (key: string, engine: "repo" | "search") => {
      const outcome = tree?.outcomes.find((item) => item.key === key);
      if (!outcome) throw new Error("Refresh the outcome before configuring a verifier.");
      const res = await callTool<{ rig: Rig | null }>("app_get_rig", {
        projectId: project,
        key,
        engine,
      });
      setEditor({ outcome, engine, existing: res.rig });
    },
    [tree, project, callTool],
  );

  const dispatch = useCallback(
    async (key: string, engine: "repo" | "search") => {
      const rigRes = await callTool<{ rig: Rig | null }>("app_get_rig", {
        projectId: project,
        key,
        engine,
      });
      if (!rigRes.rig) {
        const outcome = tree?.outcomes.find((item) => item.key === key);
        if (!outcome) throw new Error("Refresh the outcome before configuring a verifier.");
        setEditor({ outcome, engine, existing: null });
        throw new Error("Configure the scoring and holdout checks before starting the first climb.");
      }

      const client = appRef.current;
      const canMessage = Boolean(client?.getHostCapabilities()?.message);
      const dispatched = await callTool<{
        runId: string;
        threadId: string | null;
        directory: string;
        brief: string;
        needsClientWorkerLaunch: boolean;
        launchMode: string;
      }>("app_dispatch", {
        projectId: project,
        key,
        engine,
        track,
        deferWorkerLaunch: canMessage,
      });

      let workerId = dispatched.threadId;
      if (dispatched.needsClientWorkerLaunch && client && canMessage) {
        try {
          const msgRes = (await client.sendMessage(
            {
              role: "user",
              content: [{ type: "text", text: dispatched.brief }],
              _meta: { "com.google.antigravity/message": { target: "new" } },
            } as Parameters<App["sendMessage"]>[0],
          )) as { _meta?: { "com.google.antigravity/message"?: { conversationId?: string } } } | undefined;
          const convId = msgRes?._meta?.["com.google.antigravity/message"]?.conversationId;
          workerId = convId ?? `client:${dispatched.runId}`;
        } catch {
          workerId = `local:${dispatched.runId}`;
        }
        await callTool("app_attach_worker", { runId: dispatched.runId, conversationId: workerId });
      }

      setNotice(
        `Run ${dispatched.runId} dispatched for ${key} (${engine})${workerId ? ` · worker ${workerId}` : ""} in ${dispatched.directory}`,
      );
      await loadTree(project, track);
    },
    [project, track, tree, callTool, loadTree],
  );

  const handleSync = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const res = await callTool<{ root: string; files: number }>("app_sync", { projectId: project });
      setNotice(`Synced ${res.files} files to ${res.root}`);
    } catch (e) {
      setNotice(`Sync failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleLint = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const res = await callTool<LintReport>("app_lint", { projectId: project });
      setLintReport(res);
    } catch (e) {
      setNotice(`Lint failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleReconcile = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const res = await callTool<{ scanned: number; applied: number; refused: number; closed: number }>(
        "app_reconcile",
        { projectId: project },
      );
      setNotice(`Reconciled ${res.scanned} run(s): ${res.applied} applied, ${res.refused} refused, ${res.closed} closed.`);
      await loadTree(project, track);
    } catch (e) {
      setNotice(`Reconcile failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRegisterProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjDir.trim() && !newProjName.trim()) return;
    setBusy(true);
    try {
      const res = await callTool<{ project: ProjectItem; projects: ProjectItem[] }>("app_register_project", {
        name: newProjName.trim() || undefined,
        directory: newProjDir.trim() || undefined,
      });
      setProjects(res.projects);
      setProject(res.project.id);
      setNewProjName("");
      setNewProjDir("");
      setAddProjectOpen(false);
      setNotice(`Registered project "${res.project.name}" (${res.project.directory ?? "no directory"})`);
    } catch (err) {
      setNotice(`Could not register project: ${errMsg(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (connectError) {
    return (
      <main className="hill-shell">
        <h1>Hill Climb</h1>
        <p role="alert">Could not connect to Antigravity MCP Apps host: {connectError}</p>
      </main>
    );
  }

  return (
    <main className="hill-shell">
      <header>
        <h1>Hill Climb</h1>
        <div className="hill-header-controls">
          <label>
            Project{" "}
            <select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setSelected(null);
              }}
            >
              {projects.length === 0 ? <option value="default">default</option> : null}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.directory ? ` (${p.directory.split(/[/\\]/).slice(-1)[0]})` : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="hill-action-btn" onClick={() => setAddProjectOpen(true)}>
            + Project
          </button>
          <button type="button" className="hill-action-btn" disabled={busy || !project} onClick={() => void handleSync()}>
            Sync
          </button>
          <button type="button" className="hill-action-btn" disabled={busy || !project} onClick={() => void handleLint()}>
            Lint
          </button>
          <button type="button" className="hill-action-btn" disabled={busy || !project} onClick={() => void handleReconcile()}>
            Reconcile
          </button>
        </div>
      </header>

      <nav aria-label="Hill Climb">
        {PAGES.map((p) => (
          <button
            key={p}
            type="button"
            aria-current={page === p ? "page" : undefined}
            onClick={() => setPage(p)}
          >
            {p === "tree" ? "Outcomes" : p.charAt(0).toUpperCase() + p.slice(1)}
            {p === "climbs" && (repoClimbs?.currentCount ?? 0) > 0 ? (
              <span className="hill-nav-badge hill-nav-badge-climbs">{repoClimbs!.currentCount}</span>
            ) : null}
            {p === "inbox" && inboxCount > 0 ? <span className="hill-nav-badge">{inboxCount}</span> : null}
          </button>
        ))}
      </nav>

      {notice ? (
        <div className="hill-notice-bar" role="status">
          <span>{notice}</span>
          <button type="button" className="hill-action-btn" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </div>
      ) : null}

      {treeError ? (
        <p role="alert">
          {treeError}{" "}
          <button type="button" className="hill-action-btn" onClick={() => void loadTree(project, track)}>
            Retry
          </button>
        </p>
      ) : !tree ? (
        <p role="status">Loading outcomes…</p>
      ) : (
        <div className={"hill-workspace" + (selected ? " hill-inspecting" : "")}>
          {editor ? (
            <RigEditor
              engine={editor.engine}
              existing={editor.existing}
              outcome={editor.outcome}
              onClose={() => setEditor(null)}
              onSave={async (rig) => {
                await callTool("app_save_rig", {
                  projectId: project,
                  key: editor.outcome.key,
                  version: editor.outcome.version,
                  rig,
                });
                setEditor(null);
                setNotice("Verifier saved. Dispatch when ready.");
              }}
            />
          ) : null}

          {tree.tracks.length > 1 ? (
            <label className="hill-track">
              Track{" "}
              <select value={track} onChange={(e) => setTrack(e.target.value)}>
                {tree.tracks.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {page === "tree" && tree.outcomes.length === 0 && (repoClimbs?.climbs.length ?? 0) > 0 ? (
            <div className="hill-notice-bar" role="status">
              <span>
                {repoClimbs!.currentCount > 0 ? (
                  <>
                    <strong>{repoClimbs!.currentCount}</strong> active/current climb
                    {repoClimbs!.currentCount === 1 ? "" : "s"} in this project
                    {repoClimbs!.archivedCount > 0 ? ` (+ ${repoClimbs!.archivedCount} archived)` : ""}.
                  </>
                ) : (
                  <>
                    <strong>{repoClimbs!.climbs.length}</strong> historical climb
                    {repoClimbs!.climbs.length === 1 ? "" : "s"} found in linked worktrees.
                  </>
                )}
              </span>
              <button type="button" className="hill-action-btn" onClick={() => setPage("climbs")}>
                Open Climbs →
              </button>
            </div>
          ) : null}

          {page === "tree" ? (
            <TreeView
              data={tree}
              track={track}
              selected={selected}
              select={setSelected}
              act={act}
              dispatch={dispatch}
              configure={configure}
              live={live}
            />
          ) : page === "climbs" ? (
            <RepoClimbsView
              payload={repoClimbs}
              loading={climbsLoading}
              onRefresh={() => void loadRepoClimbs(project)}
              onToggleAutoTrack={handleToggleAutoTrack}
              onTrackClimb={handleTrackClimb}
              onOpenOutcome={handleOpenOutcomeFromClimb}
            />
          ) : (
            <Portfolio
              page={page}
              data={tree}
              act={act}
              select={setSelected}
              chooseTrack={setTrack}
              track={track}
              preview={preview}
            />
          )}

          {selected ? (
            <OutcomeDrawer
              data={tree}
              track={track}
              selected={selected}
              select={setSelected}
              act={act}
              dispatch={dispatch}
              configure={configure}
              live={live}
            />
          ) : null}
        </div>
      )}

      {confirmDecision ? (
        <div className="hill-modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm contract decision">
          <div className="hill-modal">
            <h2>Confirm {confirmDecision.action.op.replaceAll("_", " ")}</h2>
            <p className="hc-hint">Humans own the contract. Review the exact payload before confirming.</p>
            {confirmDecision.previous ? (
              <details>
                <summary>Current contract</summary>
                <pre>{JSON.stringify(confirmDecision.previous, null, 2)}</pre>
              </details>
            ) : null}
            <pre>{JSON.stringify(confirmDecision.details, null, 2)}</pre>
            <div className="hill-modal-footer">
              <button
                type="button"
                className="hc-btn"
                onClick={() => {
                  const pending = confirmDecision;
                  setConfirmDecision(null);
                  pending.resolve(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hc-btn hc-btn-primary"
                onClick={() => {
                  const pending = confirmDecision;
                  setConfirmDecision(null);
                  pending.resolve(true);
                }}
              >
                Confirm decision
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {addProjectOpen ? (
        <div className="hill-modal-backdrop" role="dialog" aria-modal="true" aria-label="Register project">
          <form className="hill-modal" onSubmit={(e) => void handleRegisterProject(e)}>
            <h2>Register Hill Climb project</h2>
            <p className="hc-hint">Link a local git repository so Hill Climb can sync `.hillclimb/`, run verifiers, and dispatch climbs.</p>
            <div className="hc-field" style={{ marginTop: 10 }}>
              <label htmlFor="hc-new-proj-name">Project name</label>
              <input
                id="hc-new-proj-name"
                value={newProjName}
                onChange={(e) => setNewProjName(e.target.value)}
                placeholder="e.g. my-app"
              />
            </div>
            <div className="hc-field" style={{ marginTop: 10 }}>
              <label htmlFor="hc-new-proj-dir">Repository path</label>
              <input
                id="hc-new-proj-dir"
                value={newProjDir}
                onChange={(e) => setNewProjDir(e.target.value)}
                placeholder="/path/to/my-repo"
              />
            </div>
            <div className="hill-modal-footer">
              <button type="button" className="hc-btn" onClick={() => setAddProjectOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="hc-btn hc-btn-primary" disabled={busy}>
                Save project
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {lintReport ? (
        <div className="hill-modal-backdrop" role="dialog" aria-modal="true" aria-label="Contract lint report">
          <div className="hill-modal">
            <h2>
              Contract Lint — {lintReport.passed ? "Passed" : `${lintReport.errorCount} error(s)`} ·{" "}
              {lintReport.warningCount} warning(s)
            </h2>
            {lintReport.findings.length === 0 ? (
              <p>All 22 rubric rules passed with no findings.</p>
            ) : (
              <div className="hill-lint-list">
                {lintReport.findings.map((f) => (
                  <div key={f.id} className="hill-lint-item">
                    <strong>
                      [{f.severity}] {f.checkCode} ({f.itemKey})
                    </strong>{" "}
                    — {f.checkTitle}
                    <div>{f.issue}</div>
                    {f.proposed ? <div className="hc-hint">Proposed: {f.proposed}</div> : null}
                  </div>
                ))}
              </div>
            )}
            <div className="hill-modal-footer">
              <button type="button" className="hc-btn hc-btn-primary" onClick={() => setLintReport(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<HillClimbApp />);
}
