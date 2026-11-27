import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { Action } from "./actions.js";
import type { Outcome, Release, Snapshot } from "./model.js";
import type { Rig } from "./rig.js";
import type {
  BlueprintSummaryDto,
  FocusScopeDto,
  HookRecordDto,
  InsightsDto,
  LiveData,
  ProjectSettingsDto,
  SavedViewDto,
  SavedViewFilterDto,
  SearchHitDto,
} from "./view-props.js";
import { RigEditor } from "./ui/RigEditor.js";
import { TreeView } from "./ui/TreeView.js";
import { OutcomeDrawer } from "./ui/OutcomeDrawer.js";
import { Portfolio, type PromotionPreviewRow } from "./ui/Portfolio.js";
import { RepoClimbsView, type RepoClimbsPayload } from "./ui/RepoClimbsView.js";
import { InsightsView } from "./ui/InsightsView.js";
import { ReportsView } from "./ui/ReportsView.js";
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
  views?: SavedViewDto[];
  scopes?: FocusScopeDto[];
  settings?: ProjectSettingsDto;
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

const PAGES = ["tree", "climbs", "inbox", "roadmap", "flows", "insights", "reports"] as const;
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
  return (
    action.op === "approve_change" ||
    action.op === "reject_change" ||
    action.op === "accept_flow_change" ||
    action.op === "reject_flow_change" ||
    action.op === "promote_track"
  );
}

const DEFAULT_SETTINGS: ProjectSettingsDto = {
  autoSyncMirror: false,
  wakeOnAnswer: true,
  requireApprovalForNewOutcomes: false,
  designKit: null,
};

function HillClimbApp() {
  const appRef = useRef<App | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [project, setProject] = useState<string>("");
  const [page, setPage] = useState<Page>("tree");
  const [track, setTrack] = useState("main");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [tree, setTree] = useState<Snapshot | null>(null);
  const [repoClimbs, setRepoClimbs] = useState<RepoClimbsPayload | null>(null);
  const [climbsLoading, setClimbsLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [views, setViews] = useState<SavedViewDto[]>([]);
  const [scopes, setScopes] = useState<FocusScopeDto[]>([]);
  const [settings, setSettings] = useState<ProjectSettingsDto>(DEFAULT_SETTINGS);
  const [hooks, setHooks] = useState<HookRecordDto[]>([]);

  const [editor, setEditor] = useState<{
    outcome: Outcome;
    existing: Rig | null;
    engine: "repo" | "search";
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const initialLoadedRef = useRef<{ projectId: string; track: string } | null>(null);

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

  // Cmd+K Search Palette state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHitDto[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Import & Blueprints Modal state
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<"blueprints" | "markdown">("blueprints");
  const [blueprints, setBlueprints] = useState<BlueprintSummaryDto[]>([]);
  const [selectedBlueprint, setSelectedBlueprint] = useState<string>("");
  const [importMarkdown, setImportMarkdown] = useState(
    "# Core Reliability\n\n## Checkout completes cleanly\n- As a buyer, I want checkout to succeed under retries, so that I am never double-charged.\n- Given a valid cart, when submitting twice, then only one charge is created.\n",
  );
  const [importAsProposals, setImportAsProposals] = useState(false);
  const [importPreview, setImportPreview] = useState<{ actionCount: number; lint: LintReport } | null>(null);

  // Settings & Hooks Modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [designKitDraft, setDesignKitDraft] = useState("");
  const [hookEvent, setHookEvent] = useState<HookRecordDto["event"]>("outcome.broken");
  const [hookType, setHookType] = useState<HookRecordDto["targetType"]>("notify");
  const [hookTarget, setHookTarget] = useState("");

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
    async (pid: string, trk: string, force = false) => {
      if (!pid) return;
      try {
        setTreeError(null);
        const res = await callTool<{
          tree: Snapshot;
          repoClimbs?: RepoClimbsPayload;
          inboxCount: number;
          views?: SavedViewDto[];
          scopes?: FocusScopeDto[];
          settings?: ProjectSettingsDto;
        }>("app_tree", {
          projectId: pid,
          track: trk,
          ...(force ? { force: true } : {}),
        });
        setTree(res.tree);
        if (res.repoClimbs) setRepoClimbs(res.repoClimbs);
        setInboxCount(res.inboxCount);
        if (res.views) setViews(res.views);
        if (res.scopes) setScopes(res.scopes);
        if (res.settings) {
          setSettings(res.settings);
          setDesignKitDraft(res.settings.designKit ?? "");
        }
      } catch (e) {
        setTreeError(errMsg(e));
      }
    },
    [callTool],
  );

  const pollRepoClimbs = useCallback(
    async (pid: string, force = false) => {
      if (!pid) return;
      try {
        const res = await callTool<RepoClimbsPayload>("app_repo_climbs", { projectId: pid, force });
        setRepoClimbs(res);
      } catch {
        // non-fatal during quiet poll
      }
    },
    [callTool],
  );

  const loadRepoClimbs = useCallback(
    async (pid: string) => {
      if (!pid) return;
      setClimbsLoading(true);
      try {
        await loadTree(pid, track, true);
      } catch {
        // non-fatal
      } finally {
        setClimbsLoading(false);
      }
    },
    [loadTree, track],
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

  const handleOpenFlow = useCallback((flowName: string) => {
    setSelectedFlow(flowName);
    setPage("flows");
  }, []);

  const syncViewsScopes = useCallback(
    async (mode: string, payload?: Record<string, unknown>) => {
      if (!project) return;
      const res = await callTool<{
        views: SavedViewDto[];
        scopes: FocusScopeDto[];
        hooks: HookRecordDto[];
        settings: ProjectSettingsDto;
      }>("app_views_scopes", { projectId: project, mode, payload });
      setViews(res.views);
      setScopes(res.scopes);
      setHooks(res.hooks);
      setSettings(res.settings);
      setDesignKitDraft(res.settings.designKit ?? "");
    },
    [project, callTool],
  );

  const handleSaveView = useCallback(
    async (name: string, filter: SavedViewFilterDto) => {
      await syncViewsScopes("save_view", { name, filter });
      setNotice(`Saved view "${name}".`);
    },
    [syncViewsScopes],
  );

  const handleDeleteView = useCallback(
    async (id: string) => {
      await syncViewsScopes("delete_view", { id });
      setNotice("Deleted saved view.");
    },
    [syncViewsScopes],
  );

  const handleSaveScope = useCallback(
    async (scope: {
      id?: string;
      name: string;
      owner?: string | null;
      releaseName?: string | null;
      goalKeys: string[];
      tags: string[];
      active: boolean;
    }) => {
      await syncViewsScopes("save_scope", scope);
      setNotice(scope.active ? `Active focus scope set to "${scope.name}".` : `Updated focus scope "${scope.name}".`);
    },
    [syncViewsScopes],
  );

  const handleDeleteScope = useCallback(
    async (id: string) => {
      await syncViewsScopes("delete_scope", { id });
      setNotice("Deleted focus scope.");
    },
    [syncViewsScopes],
  );

  const handleFocusScopeFromRelease = useCallback(
    async (release: Release) => {
      await syncViewsScopes("save_scope", {
        name: `Release: ${release.name}`,
        releaseName: release.name,
        goalKeys: [],
        tags: [],
        active: true,
      });
      setNotice(`Focused agents on release "${release.name}".`);
    },
    [syncViewsScopes],
  );

  const loadInsights = useCallback(
    async (days: number): Promise<InsightsDto> => {
      if (!project) throw new Error("Select a project first.");
      return callTool<InsightsDto>("app_insights", { projectId: project, days, track });
    },
    [project, track, callTool],
  );

  const callArtifacts = useCallback(
    async <T,>(mode: "list" | "save" | "generate" | "export" | "delete", payload?: Record<string, unknown>): Promise<T> => {
      if (!project) throw new Error("Select a project first.");
      return callTool<T>("app_artifacts", { projectId: project, mode, payload });
    },
    [project, callTool],
  );

  // Connect once using the MCP Apps SDK, registering handlers BEFORE connect().
  useEffect(() => {
    const app = new App({ name: "Hill Climb", version: "0.5.0" }, {});
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

    app.ontoolinput = () => {};

    app.ontoolresult = (result) => {
      try {
        const data = unwrapToolResult<InitialPayload>(result);
        if (data.projects) setProjects(data.projects);
        if (data.projectId) setProject(data.projectId);
        if (data.page && PAGES.includes(data.page)) setPage(data.page);
        if (data.outcomeKey !== undefined) setSelected(data.outcomeKey);
        if (data.track) setTrack(data.track);
        if (data.tree) {
          setTree(data.tree);
          if (data.projectId) {
            initialLoadedRef.current = { projectId: data.projectId, track: data.track ?? "main" };
          }
        }
        if (data.repoClimbs) setRepoClimbs(data.repoClimbs);
        if (typeof data.inboxCount === "number") setInboxCount(data.inboxCount);
        if (data.views) setViews(data.views);
        if (data.scopes) setScopes(data.scopes);
        if (data.settings) {
          setSettings(data.settings);
          setDesignKitDraft(data.settings.designKit ?? "");
        }
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

  // Load projects if connected without initial tool result
  useEffect(() => {
    if (!connected) return;
    if (projects.length === 0) {
      void loadProjects().catch((e) => setTreeError(errMsg(e)));
    }
  }, [connected, projects.length, loadProjects]);

  // Reload tree whenever project/track changes
  useEffect(() => {
    if (!connected || !project) return;
    const init = initialLoadedRef.current;
    if (init && init.projectId === project && init.track === track && tree !== null) {
      initialLoadedRef.current = null;
      return;
    }
    initialLoadedRef.current = null;
    void loadTree(project, track);
  }, [connected, project, track, loadTree]);

  // Quiet background poll
  useEffect(() => {
    if (!connected || !project) return;
    if (page === "climbs") {
      const timer = setInterval(() => void pollRepoClimbs(project, false), 10_000);
      return () => clearInterval(timer);
    }
    const timer = setInterval(() => void loadTree(project, track), 30_000);
    return () => clearInterval(timer);
  }, [connected, project, track, page, loadTree, pollRepoClimbs]);

  // Global Cmd+K / Ctrl+K shortcut & Escape-key dismissal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((open) => !open);
        return;
      }
      if (e.key !== "Escape") return;
      if (confirmDecision) {
        const pending = confirmDecision;
        setConfirmDecision(null);
        pending.resolve(false);
      } else if (searchOpen) {
        setSearchOpen(false);
      } else if (importOpen) {
        setImportOpen(false);
      } else if (settingsOpen) {
        setSettingsOpen(false);
      } else if (addProjectOpen) {
        setAddProjectOpen(false);
      } else if (lintReport) {
        setLintReport(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDecision, searchOpen, importOpen, settingsOpen, addProjectOpen, lintReport]);

  // Live debounced FTS5 search inside Cmd+K palette
  useEffect(() => {
    if (!searchOpen || !connected) return;
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    let alive = true;
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void callTool<{ hits: SearchHitDto[] }>("app_search", {
        projectId: project || undefined,
        query: trimmed,
        limit: 25,
      })
        .then((res) => {
          if (alive) setSearchHits(res.hits ?? []);
        })
        .catch(() => {
          if (alive) setSearchHits([]);
        })
        .finally(() => {
          if (alive) setSearchLoading(false);
        });
    }, 140);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [searchOpen, searchQuery, project, connected, callTool]);

  const openImportModal = async () => {
    setImportOpen(true);
    setImportPreview(null);
    if (blueprints.length === 0 && project) {
      try {
        const res = await callTool<{ blueprints: BlueprintSummaryDto[] }>("app_import", {
          projectId: project,
          mode: "blueprints",
        });
        setBlueprints(res.blueprints ?? []);
        if (res.blueprints?.[0]) setSelectedBlueprint(res.blueprints[0].id);
      } catch (e) {
        setNotice(`Could not load blueprints: ${errMsg(e)}`);
      }
    }
  };

  const openSettingsModal = async () => {
    setSettingsOpen(true);
    if (project) {
      try {
        await syncViewsScopes("list");
      } catch (e) {
        setNotice(`Could not load settings: ${errMsg(e)}`);
      }
    }
  };

  const handleSearchJump = (hit: SearchHitDto) => {
    setSearchOpen(false);
    if (hit.project && hit.project !== project && projects.some((p) => p.id === hit.project)) {
      setProject(hit.project);
    }
    if (hit.entityType === "outcome" || hit.entityType === "goal") {
      setPage("tree");
      setSelected(hit.entityId);
    } else if (hit.entityType === "plan" || hit.entityType === "evidence" || hit.entityType === "comment") {
      const key = hit.entityId.split("@")[0] ?? hit.entityId;
      setPage("tree");
      setSelected(key);
    } else if (hit.entityType === "flow") {
      setSelectedFlow(hit.entityId);
      setPage("flows");
    } else if (hit.entityType === "artifact") {
      setSelectedArtifact(hit.entityId);
      setPage("reports");
    } else if (hit.entityType === "climb") {
      setPage("climbs");
    }
  };

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
        } else if ("id" in action && (action.op === "accept_flow_change" || action.op === "reject_flow_change")) {
          const proposal = (tree.flowProposals ?? []).find((p) => p.id === action.id);
          details = proposal ?? action;
          if (proposal) {
            const flow = tree.flows.find((f) => f.name === proposal.flowName);
            previous =
              proposal.frameIndex !== null && flow?.frames[proposal.frameIndex]
                ? { flowName: flow.name, frame: flow.frames[proposal.frameIndex] }
                : null;
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
      const res = await callTool<{ ok: true; tree: Snapshot; inboxCount?: number }>("app_act", {
        projectId: project,
        action,
        confirmed,
        track,
      });
      setTree(res.tree);
      if (typeof res.inboxCount === "number") setInboxCount(res.inboxCount);
    },
    [project, track, askConfirmation, callTool],
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
      await new Promise<void>((resolve, reject) => {
        setEditor({ outcome, engine, existing: res.rig, resolve, reject });
      });
    },
    [tree, project, callTool],
  );

  const dispatch = useCallback(
    async (key: string, engine: "repo" | "search") => {
      let rigRes = await callTool<{ rig: Rig | null }>("app_get_rig", {
        projectId: project,
        key,
        engine,
      });
      if (!rigRes.rig) {
        const outcome = tree?.outcomes.find((item) => item.key === key);
        if (!outcome) throw new Error("Refresh the outcome before configuring a verifier.");
        try {
          await new Promise<void>((resolve, reject) => {
            setEditor({ outcome, engine, existing: null, resolve, reject });
          });
        } catch (err) {
          if (errMsg(err) === "cancelled") {
            throw new Error("cancelled");
          }
          throw err;
        }
        rigRes = await callTool<{ rig: Rig | null }>("app_get_rig", {
          projectId: project,
          key,
          engine,
        });
        if (!rigRes.rig) {
          throw new Error("Configure the scoring and holdout checks before starting the first climb.");
        }
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

  const handleImportRun = async (mode: "preview" | "apply") => {
    if (!project) return;
    setBusy(true);
    try {
      const payload =
        importTab === "blueprints"
          ? { blueprintId: selectedBlueprint, asProposals: importAsProposals, track }
          : { markdown: importMarkdown, asProposals: importAsProposals, track };
      const res = await callTool<{
        applied: number;
        actionCount: number;
        lint: LintReport;
        tree?: Snapshot;
        inboxCount?: number;
      }>("app_import", { projectId: project, mode, payload });
      setImportPreview({ actionCount: res.actionCount, lint: res.lint });
      if (mode === "apply") {
        if (res.tree) setTree(res.tree);
        if (typeof res.inboxCount === "number") setInboxCount(res.inboxCount);
        setImportOpen(false);
        setNotice(
          `Imported ${res.applied} action(s)${importAsProposals ? " as pending proposals in Inbox" : " into tree"}.`,
        );
      }
    } catch (e) {
      setNotice(`Import failed: ${errMsg(e)}`);
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
          <div className="hill-header-actions">
            <button
              type="button"
              className="hill-action-btn"
              title="Search everything across outcomes, criteria, plans, evidence, flows, climbs & reports (Cmd+K)"
              onClick={() => setSearchOpen(true)}
            >
              Search ⌘K
            </button>
            <button
              type="button"
              className="hill-action-btn"
              title="Start from a contract blueprint or import Markdown stories"
              disabled={busy || !project}
              onClick={() => void openImportModal()}
            >
              Import
            </button>
            <button
              type="button"
              className="hill-action-btn"
              title="Link a local git repository to Hill Climb"
              onClick={() => setAddProjectOpen(true)}
            >
              + Project
            </button>
            <button
              type="button"
              className="hill-action-btn"
              title="Write the .hillclimb/ markdown mirror into this repository"
              disabled={busy || !project}
              onClick={() => void handleSync()}
            >
              Sync
            </button>
            <button
              type="button"
              className="hill-action-btn"
              title="Lint contract tree against all 22 quality rules"
              disabled={busy || !project}
              onClick={() => void handleLint()}
            >
              Lint
            </button>
            <button
              type="button"
              className="hill-action-btn"
              title="Poll dispatched verifier runs and ingest completed receipts"
              disabled={busy || !project}
              onClick={() => void handleReconcile()}
            >
              Reconcile
            </button>
            <button
              type="button"
              className="hill-action-btn"
              title="Project policy, auto-sync, wake-on-answer, and automation hooks"
              disabled={!project}
              onClick={() => void openSettingsModal()}
            >
              Settings
            </button>
          </div>
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
              onClose={() => {
                const pending = editor;
                setEditor(null);
                pending.reject(new Error("cancelled"));
              }}
              onSave={async (rig) => {
                const pending = editor;
                await callTool("app_save_rig", {
                  projectId: project,
                  key: pending.outcome.key,
                  version: pending.outcome.version,
                  rig,
                });
                setEditor(null);
                pending.resolve();
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
              key={project}
              data={tree}
              track={track}
              selected={selected}
              select={setSelected}
              act={act}
              dispatch={dispatch}
              configure={configure}
              live={live}
              views={views}
              scopes={scopes}
              onSaveView={handleSaveView}
              onDeleteView={handleDeleteView}
              onSaveScope={handleSaveScope}
              onDeleteScope={handleDeleteScope}
              onOpenFlow={handleOpenFlow}
              onOpenInbox={() => setPage("inbox")}
            />
          ) : page === "climbs" ? (
            <RepoClimbsView
              key={project}
              payload={repoClimbs}
              loading={climbsLoading}
              onRefresh={() => void loadRepoClimbs(project)}
              onToggleAutoTrack={handleToggleAutoTrack}
              onTrackClimb={handleTrackClimb}
              onOpenOutcome={handleOpenOutcomeFromClimb}
            />
          ) : page === "insights" ? (
            <InsightsView
              projectId={project}
              track={track}
              loadInsights={loadInsights}
              onSelectOutcome={handleOpenOutcomeFromClimb}
              onOpenClimbs={() => setPage("climbs")}
            />
          ) : page === "reports" ? (
            <ReportsView
              projectId={project}
              track={track}
              releases={tree.releases}
              initialArtifactId={selectedArtifact}
              callArtifacts={callArtifacts}
              onSelectOutcome={handleOpenOutcomeFromClimb}
              onNotice={setNotice}
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
              initialFlow={selectedFlow}
              onFocusScopeFromRelease={handleFocusScopeFromRelease}
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
              onOpenFlow={handleOpenFlow}
            />
          ) : null}
        </div>
      )}

      {searchOpen ? (
        <div
          className="hill-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Search everything"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSearchOpen(false);
          }}
        >
          <div className="hill-modal hill-search-modal">
            <h2>Search Everything (⌘K)</h2>
            <input
              autoFocus
              className="pf-input"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search goals, outcomes, criteria, plans, evidence, flows, climbs, reports…"
              aria-label="Global search query"
            />
            <div className="hill-search-results">
              {searchLoading ? (
                <p className="hc-hint">Searching…</p>
              ) : searchQuery.trim() === "" ? (
                <p className="hc-hint">Type a keyword to query SQLite FTS5 across the entire workspace.</p>
              ) : searchHits.length === 0 ? (
                <p className="hc-hint">No matches for “{searchQuery}”.</p>
              ) : (
                searchHits.map((hit, idx) => (
                  <button
                    key={`${hit.project}:${hit.entityType}:${hit.entityId}:${idx}`}
                    type="button"
                    className="hill-search-hit"
                    onClick={() => handleSearchJump(hit)}
                  >
                    <span className="hill-search-hit-top">
                      <span className="pf-pill">{hit.entityType}</span>
                      <strong>{hit.title}</strong>
                      <code>{hit.entityId}</code>
                    </span>
                    <span className="hc-hint">{hit.snippet}</span>
                  </button>
                ))
              )}
            </div>
            <div className="hill-modal-footer">
              <button type="button" className="hc-btn" onClick={() => setSearchOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {importOpen ? (
        <div
          className="hill-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Import blueprints or Markdown"
          onClick={(e) => {
            if (e.target === e.currentTarget) setImportOpen(false);
          }}
        >
          <div className="hill-modal">
            <h2>Templates &amp; Markdown Import</h2>
            <p className="hc-hint">
              Seed your contract tree from a built-in blueprint or convert Markdown stories/checklists with 22-rule lint preview.
            </p>
            <div className="cl-seg" style={{ margin: "10px 0" }}>
              <button
                type="button"
                className={importTab === "blueprints" ? "is-active" : ""}
                onClick={() => {
                  setImportTab("blueprints");
                  setImportPreview(null);
                }}
              >
                Blueprints ({blueprints.length})
              </button>
              <button
                type="button"
                className={importTab === "markdown" ? "is-active" : ""}
                onClick={() => {
                  setImportTab("markdown");
                  setImportPreview(null);
                }}
              >
                Markdown / Stories
              </button>
            </div>

            {importTab === "blueprints" ? (
              <div className="hill-lint-list">
                {blueprints.map((bp) => (
                  <label key={bp.id} className="hill-lint-item" style={{ cursor: "pointer", display: "block" }}>
                    <input
                      type="radio"
                      name="hc-blueprint"
                      checked={selectedBlueprint === bp.id}
                      onChange={() => {
                        setSelectedBlueprint(bp.id);
                        setImportPreview(null);
                      }}
                    />{" "}
                    <strong>{bp.name}</strong> ({bp.goalCount} goal, {bp.outcomeCount} outcomes)
                    <div className="hc-hint">{bp.description}</div>
                  </label>
                ))}
              </div>
            ) : (
              <div className="hc-field">
                <label htmlFor="hc-import-md">Markdown headings &amp; acceptance bullets</label>
                <textarea
                  id="hc-import-md"
                  className="pf-textarea"
                  rows={8}
                  value={importMarkdown}
                  onChange={(e) => {
                    setImportMarkdown(e.target.value);
                    setImportPreview(null);
                  }}
                />
              </div>
            )}

            <label className="hc-toggle" style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                checked={importAsProposals}
                onChange={(e) => setImportAsProposals(e.target.checked)}
              />
              <span>Import outcomes as pending proposals in Inbox (require human approval)</span>
            </label>

            {importPreview ? (
              <div className="hill-lint-item" style={{ marginTop: 10 }}>
                <strong>Preview:</strong> {importPreview.actionCount} action(s) · 22-rule lint:{" "}
                {importPreview.lint.passed
                  ? "Passed"
                  : `${importPreview.lint.errorCount} error(s), ${importPreview.lint.warningCount} warning(s)`}
              </div>
            ) : null}

            <div className="hill-modal-footer">
              <button type="button" className="hc-btn" onClick={() => setImportOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="hc-btn"
                disabled={busy}
                onClick={() => void handleImportRun("preview")}
              >
                Preview &amp; Lint
              </button>
              <button
                type="button"
                className="hc-btn hc-btn-primary"
                disabled={busy || (importTab === "blueprints" && !selectedBlueprint)}
                onClick={() => void handleImportRun("apply")}
              >
                Import into tree
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div
          className="hill-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Project settings and automation hooks"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <div className="hill-modal">
            <h2>Project Settings &amp; Automation</h2>
            <div className="hill-lint-list">
              <label className="hill-lint-item" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={settings.autoSyncMirror}
                  onChange={(e) =>
                    void syncViewsScopes("set_setting", {
                      key: "autoSyncMirror",
                      value: String(e.target.checked),
                    })
                  }
                />
                <span>
                  <strong>Auto-sync .hillclimb/ mirror</strong> — keep Markdown mirror updated on every tree write.
                </span>
              </label>
              <label className="hill-lint-item" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={settings.wakeOnAnswer}
                  onChange={(e) =>
                    void syncViewsScopes("set_setting", {
                      key: "wakeOnAnswer",
                      value: String(e.target.checked),
                    })
                  }
                />
                <span>
                  <strong>Wake agent on answer / approval</strong> — resume waiting Antigravity conversation when Inbox items are resolved.
                </span>
              </label>
              <label className="hill-lint-item" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={settings.requireApprovalForNewOutcomes}
                  onChange={(e) =>
                    void syncViewsScopes("set_setting", {
                      key: "requireApprovalForNewOutcomes",
                      value: String(e.target.checked),
                    })
                  }
                />
                <span>
                  <strong>Require approval for new agent outcomes</strong> — route MCP <code>create_outcome</code> into Inbox as proposed outcomes.
                </span>
              </label>
              <div className="hill-lint-item">
                <label htmlFor="hc-set-kit" className="pf-label">
                  Default Flows Design Kit
                </label>
                <div className="pf-row" style={{ marginTop: 4 }}>
                  <input
                    id="hc-set-kit"
                    className="pf-input"
                    value={designKitDraft}
                    onChange={(e) => setDesignKitDraft(e.target.value)}
                    placeholder="e.g. Clean SaaS, shadcn/ui, Apple HIG"
                  />
                  <button
                    type="button"
                    className="hc-btn"
                    onClick={() =>
                      void syncViewsScopes("set_setting", { key: "designKit", value: designKitDraft.trim() })
                    }
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>

            <h3 style={{ fontSize: "0.95rem", margin: "14px 0 6px" }}>Event Hooks ({hooks.length})</h3>
            <p className="hc-hint">
              Fire local macOS notifications, shell commands, or HMAC-signed webhooks when outcomes verify, break, or get approved.
            </p>
            <div className="hill-lint-list">
              {hooks.map((h) => (
                <div key={h.id} className="hill-lint-item" style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <div>
                    <strong>{h.event}</strong> · <span className="pf-pill">{h.targetType}</span> <code>{h.target}</code>
                  </div>
                  <button
                    type="button"
                    className="hc-btn"
                    onClick={() => void syncViewsScopes("delete_hook", { id: h.id })}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <form
              className="pf-row"
              style={{ marginTop: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (!hookTarget.trim()) return;
                void syncViewsScopes("save_hook", {
                  event: hookEvent,
                  targetType: hookType,
                  target: hookTarget.trim(),
                  enabled: true,
                }).then(() => setHookTarget(""));
              }}
            >
              <select
                aria-label="Hook event"
                className="pf-select"
                style={{ width: "auto" }}
                value={hookEvent}
                onChange={(e) => setHookEvent(e.target.value as HookRecordDto["event"])}
              >
                <option value="outcome.broken">outcome.broken</option>
                <option value="outcome.verified">outcome.verified</option>
                <option value="question.answered">question.answered</option>
                <option value="change.approved">change.approved</option>
                <option value="flow.accepted">flow.accepted</option>
                <option value="*">* (all events)</option>
              </select>
              <select
                aria-label="Hook target type"
                className="pf-select"
                style={{ width: "auto" }}
                value={hookType}
                onChange={(e) => setHookType(e.target.value as HookRecordDto["targetType"])}
              >
                <option value="notify">Desktop notify</option>
                <option value="shell">Shell command</option>
                <option value="webhook">Webhook URL</option>
              </select>
              <input
                className="pf-input"
                value={hookTarget}
                onChange={(e) => setHookTarget(e.target.value)}
                placeholder={
                  hookType === "notify"
                    ? "Title prefix (e.g. Hill Climb Alert)"
                    : hookType === "webhook"
                      ? "https://hooks.example.com/..."
                      : "./scripts/on-event.sh"
                }
              />
              <button type="submit" className="hc-btn hc-btn-primary">
                Add hook
              </button>
            </form>

            <div className="hill-modal-footer">
              <button type="button" className="hc-btn hc-btn-primary" onClick={() => setSettingsOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDecision ? (
        <div className="hill-modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm contract decision">
          <div className="hill-modal">
            <h2>Confirm {confirmDecision.action.op.replaceAll("_", " ")}</h2>
            <p className="hc-hint">Humans own the contract. Review the exact payload before confirming.</p>
            {confirmDecision.previous ? (
              <details>
                <summary>Current approved state</summary>
                <pre>{JSON.stringify(confirmDecision.previous, null, 2)}</pre>
              </details>
            ) : null}
            <pre>{JSON.stringify(confirmDecision.details, null, 2)}</pre>
            <div className="hill-modal-footer">
              <button
                type="button"
                className="hc-btn"
                autoFocus
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
        <div
          className="hill-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Register project"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAddProjectOpen(false);
          }}
        >
          <form className="hill-modal" onSubmit={(e) => void handleRegisterProject(e)}>
            <h2>Register Hill Climb project</h2>
            <p className="hc-hint">Link a local git repository so Hill Climb can sync `.hillclimb/`, run verifiers, and dispatch climbs.</p>
            <div className="hc-field" style={{ marginTop: 10 }}>
              <label htmlFor="hc-new-proj-name">Project name</label>
              <input
                id="hc-new-proj-name"
                autoFocus
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
        <div
          className="hill-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Contract lint report"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLintReport(null);
          }}
        >
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
              <button type="button" className="hc-btn hc-btn-primary" autoFocus onClick={() => setLintReport(null)}>
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
