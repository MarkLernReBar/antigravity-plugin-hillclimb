import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
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
import { InlineDecisionCard, type InlineDecisionPayload } from "./ui/InlineDecisionCard.js";
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
  inboxByProject?: Record<string, number>;
  views?: SavedViewDto[];
  scopes?: FocusScopeDto[];
  settings?: ProjectSettingsDto;
  inlineDecision?: InlineDecisionPayload;
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

const SECONDARY_PAGES: ReadonlyArray<{ id: Page; label: string; desc: string }> = [
  { id: "roadmap", label: "Roadmap", desc: "Releases, timelines & track cutovers" },
  { id: "insights", label: "Insights", desc: "Velocity & climb telemetry" },
  { id: "reports", label: "Reports", desc: "Evidence reports & HTML export" },
];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TOGGLE_AUX_PANE_RESULT = z.object({ isError: z.boolean().optional() }).passthrough();

function resolveLocalFileUri(rawPath: string, baseDir?: string | null): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || /^(?:https?|data|blob):/i.test(trimmed)) return null;
  if (trimmed.startsWith("file://")) return trimmed;
  // Strip trailing :line or :line:col suffix (e.g. src/app.tsx:42:10)
  const clean = trimmed.replace(/:\d+(?::\d+)?$/, "");
  let fullPath: string;
  if (clean.startsWith("/")) {
    fullPath = clean;
  } else if (/^[A-Za-z]:[\\/]/.test(clean)) {
    fullPath = `/${clean.replace(/\\/g, "/")}`;
  } else if (baseDir) {
    const base = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = `${base}/${clean.replace(/\\/g, "/")}`.split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    fullPath = `/${stack.join("/")}`;
  } else {
    return null;
  }
  const encoded = encodeURI(fullPath).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return `file://${encoded}`;
}

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

/** Native <dialog> modal wrapper with showModal(), light dismiss fallback, and native Esc/top-layer handling. */
function NativeModal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const pressedOutsideRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      try {
        el.showModal();
      } catch {
        el.setAttribute("open", "");
      }
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  if (!open) return null;

  const isOutside = (e: React.PointerEvent<HTMLDialogElement>) => {
    const el = ref.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  return (
    <dialog
      ref={ref}
      className="hill-dialog"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (ref.current) ref.current.returnValue = "";
      }}
      onPointerDown={(e) => {
        pressedOutsideRef.current = isOutside(e);
      }}
      onPointerUp={(e) => {
        if (pressedOutsideRef.current && isOutside(e)) onClose();
        pressedOutsideRef.current = false;
      }}
    >
      <div className="hill-dialog-head">
        <h1 id={titleId}>{title}</h1>
        <button type="button" className="hill-icon-trigger" onClick={onClose} aria-label="Close dialog">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="hill-dialog-body">{children}</div>
      {footer ? <div className="hill-dialog-foot">{footer}</div> : null}
    </dialog>
  );
}

/** Position a popover next to its trigger when CSS Anchor Positioning is not supported. */
function positionPopoverFallback(trigger: HTMLElement | null, popover: HTMLElement | null, alignEnd: boolean): void {
  if (!trigger || !popover) return;
  if (typeof CSS !== "undefined" && CSS.supports?.("position-area", "block-end")) return;
  const rect = trigger.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const top = Math.min(window.innerHeight - popRect.height - 8, rect.bottom + 6);
  const left = alignEnd
    ? Math.max(8, rect.right - popRect.width)
    : Math.min(window.innerWidth - popRect.width - 8, rect.left);
  popover.style.position = "fixed";
  popover.style.inset = "auto";
  popover.style.top = `${Math.max(8, top)}px`;
  popover.style.left = `${Math.max(8, left)}px`;
}

function HillClimbApp() {
  const appRef = useRef<App | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [inlineDecision, setInlineDecision] = useState<InlineDecisionPayload | null>(null);
  const [expectInline, setExpectInline] = useState(false);
  const inlineModeRef = useRef(false);
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
  const [inboxByProject, setInboxByProject] = useState<Record<string, number>>({});
  const [attachedContext, setAttachedContext] = useState<{ id: string; label: string } | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [views, setViews] = useState<SavedViewDto[]>([]);
  const [scopes, setScopes] = useState<FocusScopeDto[]>([]);
  const [settings, setSettings] = useState<ProjectSettingsDto>(DEFAULT_SETTINGS);
  const [hooks, setHooks] = useState<HookRecordDto[]>([]);

  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const morePopRef = useRef<HTMLDivElement | null>(null);
  const actionsBtnRef = useRef<HTMLButtonElement | null>(null);
  const actionsPopRef = useRef<HTMLDivElement | null>(null);

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

  // Cmd+K Command & Search Palette
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHitDto[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Import & Blueprints Modal
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<"blueprints" | "markdown">("blueprints");
  const [blueprints, setBlueprints] = useState<BlueprintSummaryDto[]>([]);
  const [selectedBlueprint, setSelectedBlueprint] = useState<string>("");
  const [importMarkdown, setImportMarkdown] = useState(
    "# Core Reliability\n\n## Checkout completes cleanly\n- As a buyer, I want checkout to succeed under retries, so that I am never double-charged.\n- Given a valid cart, when submitting twice, then only one charge is created.\n",
  );
  const [importAsProposals, setImportAsProposals] = useState(false);
  const [importPreview, setImportPreview] = useState<{ actionCount: number; lint: LintReport } | null>(null);

  // Settings & Hooks Modal
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [designKitDraft, setDesignKitDraft] = useState("");
  const [hookEvent, setHookEvent] = useState<HookRecordDto["event"]>("outcome.broken");
  const [hookType, setHookType] = useState<HookRecordDto["targetType"]>("notify");
  const [hookTarget, setHookTarget] = useState("");

  const closePopovers = () => {
    try {
      morePopRef.current?.hidePopover?.();
      actionsPopRef.current?.hidePopover?.();
    } catch {
      // ignore if closed or unsupported
    }
  };

  const callTool = useCallback(async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const client = appRef.current;
    if (!client) throw new Error("Not connected to MCP host yet.");
    try {
      const res = await client.callServerTool({ name, arguments: args });
      return unwrapToolResult<T>(res);
    } catch (e) {
      const msg = errMsg(e);
      if (/tool\s+"app_[^"]+"\s+not\s+found/i.test(msg)) {
        throw new Error(
          `Hill Climb was updated on disk, but Antigravity is still running the older MCP server process (missing "${name}"). Reload the "hillclimb" MCP server in Customizations → Installed → MCP Servers to pick up the new tools.`,
        );
      }
      throw e;
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const res = await callTool<{
      projects: ProjectItem[];
      inboxCount: number;
      inboxByProject?: Record<string, number>;
    }>("app_projects");
    setProjects(res.projects);
    if (res.inboxByProject) setInboxByProject(res.inboxByProject);
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
          inboxByProject?: Record<string, number>;
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
        if (res.inboxByProject) setInboxByProject(res.inboxByProject);
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
        // quiet poll
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
        setNotice(
          enabled
            ? "Auto-track enabled: active climbs sync into Goals automatically."
            : "Auto-track paused for new climbs.",
        );
      } catch (e) {
        setNotice(`Could not update auto-track: ${errMsg(e)}`);
      }
    },
    [project, track, callTool],
  );

  const handleUpgradeEngine = useCallback(async () => {
    if (!project) return;
    try {
      const res = await callTool<RepoClimbsPayload>("app_repo_climbs", {
        projectId: project,
        force: true,
        upgradeEngine: true,
      });
      setRepoClimbs(res);
      setNotice("Upgraded .hill-climb/engine/ to the bundled Hill Climb plugin engine.");
    } catch (e) {
      setNotice(`Could not upgrade engine: ${errMsg(e)}`);
    }
  }, [project, callTool]);

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
        setNotice(`Tracked climb as ${res.outcomeKey}.`);
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
      setNotice(scope.active ? `Focus set to "${scope.name}".` : `Updated focus "${scope.name}".`);
    },
    [syncViewsScopes],
  );

  const handleDeleteScope = useCallback(
    async (id: string) => {
      await syncViewsScopes("delete_scope", { id });
      setNotice("Removed focus scope.");
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

  // Connect once using the MCP Apps SDK
  useEffect(() => {
    const app = new App({ name: "Hill Climb", version: "0.10.1" }, {});
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

    app.ontoolinput = ({ arguments: args }) => {
      if (
        args &&
        typeof args === "object" &&
        ("contract" in args ||
          "options" in args ||
          "answer" in args ||
          "text" in args ||
          "flowName" in args ||
          "componentQuery" in args ||
          "readComponent" in args ||
          "mode" in args)
      ) {
        inlineModeRef.current = true;
        setExpectInline(true);
      }
    };

    app.ontoolresult = (result) => {
      try {
        const data = unwrapToolResult<InitialPayload>(result);
        if (data.inlineDecision) {
          inlineModeRef.current = true;
          setInlineDecision(data.inlineDecision);
          setExpectInline(false);
          return;
        }
        inlineModeRef.current = false;
        setInlineDecision(null);
        setExpectInline(false);
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
        if (data.inboxByProject) setInboxByProject(data.inboxByProject);
        if (data.views) setViews(data.views);
        if (data.scopes) setScopes(data.scopes);
        if (data.settings) {
          setSettings(data.settings);
          setDesignKitDraft(data.settings.designKit ?? "");
        }
      } catch {
        // ignore non-structured results
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

  useEffect(() => {
    const isInline = inlineDecision !== null || expectInline;
    document.documentElement.classList.toggle("hill-inline-mode", isInline);
    return () => {
      document.documentElement.classList.remove("hill-inline-mode");
    };
  }, [inlineDecision, expectInline]);

  useEffect(() => {
    if (!connected || inlineDecision !== null || expectInline || inlineModeRef.current) return;
    if (projects.length === 0) {
      void loadProjects().catch((e) => setTreeError(errMsg(e)));
    }
  }, [connected, inlineDecision, expectInline, projects.length, loadProjects]);

  useEffect(() => {
    if (!connected || !project || inlineDecision !== null || expectInline || inlineModeRef.current) return;
    const init = initialLoadedRef.current;
    if (init && init.projectId === project && init.track === track && tree !== null) {
      initialLoadedRef.current = null;
      return;
    }
    initialLoadedRef.current = null;
    void loadTree(project, track);
  }, [connected, project, track, inlineDecision, expectInline, loadTree]);

  useEffect(() => {
    if (!connected || !project || inlineDecision !== null || expectInline || inlineModeRef.current) return;
    let lastFocusRefresh = 0;
    const refreshOnFocus = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastFocusRefresh < 2_000) return;
      lastFocusRefresh = now;
      void loadTree(project, track);
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    if (page === "inbox" || page === "flows") {
      void loadTree(project, track);
    }
    if (page === "climbs") {
      const timer = setInterval(() => void pollRepoClimbs(project, false), 10_000);
      return () => {
        clearInterval(timer);
        window.removeEventListener("focus", refreshOnFocus);
        document.removeEventListener("visibilitychange", refreshOnFocus);
      };
    }
    const timer = setInterval(() => void loadTree(project, track), 30_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [connected, project, track, page, inlineDecision, expectInline, loadTree, pollRepoClimbs]);

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        closePopovers();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounced FTS5 search
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
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [searchOpen, searchQuery, project, connected, callTool]);

  const openImportModal = useCallback(async () => {
    closePopovers();
    setSearchOpen(false);
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
        setNotice(`Could not load templates: ${errMsg(e)}`);
      }
    }
  }, [blueprints.length, project, callTool]);

  const openSettingsModal = useCallback(async () => {
    closePopovers();
    setSearchOpen(false);
    setSettingsOpen(true);
    if (project) {
      try {
        await syncViewsScopes("list");
      } catch (e) {
        setNotice(`Could not load settings: ${errMsg(e)}`);
      }
    }
  }, [project, syncViewsScopes]);

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
          if (change) previous = tree.outcomes.find((o) => o.key === change.key) ?? null;
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
        if (!confirmed) throw new Error("Decision cancelled.");
      }
      const res = await callTool<{
        ok: true;
        tree: Snapshot;
        inboxCount?: number;
        inboxByProject?: Record<string, number>;
      }>("app_act", {
        projectId: project,
        action,
        confirmed,
        track,
      });
      setTree(res.tree);
      if (res.inboxByProject) setInboxByProject(res.inboxByProject);
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
      const res = await callTool<{ rig: Rig | null }>("app_get_rig", { projectId: project, key, engine });
      await new Promise<void>((resolve, reject) => {
        setEditor({ outcome, engine, existing: res.rig, resolve, reject });
      });
    },
    [tree, project, callTool],
  );

  const dispatch = useCallback(
    async (key: string, engine: "repo" | "search") => {
      let rigRes = await callTool<{ rig: Rig | null }>("app_get_rig", { projectId: project, key, engine });
      if (!rigRes.rig) {
        const outcome = tree?.outcomes.find((item) => item.key === key);
        if (!outcome) throw new Error("Refresh the outcome before configuring a verifier.");
        try {
          await new Promise<void>((resolve, reject) => {
            setEditor({ outcome, engine, existing: null, resolve, reject });
          });
        } catch (err) {
          if (errMsg(err) === "cancelled") throw new Error("cancelled");
          throw err;
        }
        rigRes = await callTool<{ rig: Rig | null }>("app_get_rig", { projectId: project, key, engine });
        if (!rigRes.rig) throw new Error("Configure a verifier before starting the climb.");
      }

      const client = appRef.current;
      const canMessage = Boolean(client?.getHostCapabilities()?.message);
      const dispatched = await callTool<{
        runId: string;
        threadId: string | null;
        directory: string;
        brief: string;
        needsClientWorkerLaunch: boolean;
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
          workerId = msgRes?._meta?.["com.google.antigravity/message"]?.conversationId ?? `client:${dispatched.runId}`;
        } catch {
          workerId = `local:${dispatched.runId}`;
        }
        await callTool("app_attach_worker", { runId: dispatched.runId, conversationId: workerId });
      }

      setNotice(`Started climb for ${key} (${engine}).`);
      await loadTree(project, track);
    },
    [project, track, tree, callTool, loadTree],
  );

  const handleSync = async () => {
    if (!project) return;
    closePopovers();
    setSearchOpen(false);
    setBusy(true);
    try {
      const res = await callTool<{ root: string; files: number }>("app_sync", { projectId: project });
      setNotice(`Synced ${res.files} files to .hillclimb/.`);
    } catch (e) {
      setNotice(`Sync failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleLint = async () => {
    if (!project) return;
    closePopovers();
    setSearchOpen(false);
    setBusy(true);
    try {
      const res = await callTool<LintReport>("app_lint", { projectId: project });
      setLintReport(res);
    } catch (e) {
      setNotice(`Quality check failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleReconcile = async () => {
    if (!project) return;
    closePopovers();
    setSearchOpen(false);
    setBusy(true);
    try {
      const res = await callTool<{ scanned: number; applied: number; refused: number; closed: number }>(
        "app_reconcile",
        { projectId: project },
      );
      setNotice(`Checked ${res.scanned} run(s): ${res.applied} verified, ${res.closed} finished.`);
      await loadTree(project, track);
    } catch (e) {
      setNotice(`Check failed: ${errMsg(e)}`);
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
      setNotice(`Linked repository "${res.project.name}".`);
    } catch (err) {
      setNotice(`Could not link repository: ${errMsg(err)}`);
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
        inboxByProject?: Record<string, number>;
      }>("app_import", { projectId: project, mode, payload });
      setImportPreview({ actionCount: res.actionCount, lint: res.lint });
      if (mode === "apply") {
        if (res.tree) setTree(res.tree);
        if (res.inboxByProject) setInboxByProject(res.inboxByProject);
        setImportOpen(false);
        setNotice(
          importAsProposals
            ? `Added ${res.applied} draft item(s) to Decisions for review.`
            : `Imported ${res.applied} item(s) into Goals.`,
        );
      }
    } catch (e) {
      setNotice(`Import failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleInlineAct = useCallback(
    async (projectId: string, action: Action) => {
      await callTool("app_act", { projectId, action, confirmed: true, track: "main" });
    },
    [callTool],
  );

  const handleInlineRefresh = useCallback(
    async (projectId: string, kind: "change" | "question" | "flow_proposal" | "flow_inspect", id: string) => {
      return callTool<{
        change?: import("./model.js").Change | null;
        currentOutcome?: Outcome | null;
        comment?: import("./model.js").Comment | null;
        proposal?: import("./model.js").FlowProposal | null;
        currentFrame?: import("./model.js").Frame | null;
        flow?: import("./model.js").Flow | null;
      }>("app_decision_state", { projectId, kind, id });
    },
    [callTool],
  );

  const handleResolveImage = useCallback(
    async (projectId: string, path: string): Promise<string | null> => {
      const res = await callTool<{ dataUri: string | null }>("app_read_image", { projectId, path });
      return res.dataUri ?? null;
    },
    [callTool],
  );

  const handleResolveActiveImage = useCallback(
    (path: string): Promise<string | null> => handleResolveImage(project, path),
    [handleResolveImage, project],
  );

  const handleNotifyThread = useCallback(async (text: string): Promise<boolean> => {
    const client = appRef.current;
    if (!client || !client.getHostCapabilities()?.message) return false;
    try {
      await client.sendMessage({ role: "user", content: [{ type: "text", text }] });
      return true;
    } catch {
      return false;
    }
  }, []);

  const currentProjectDirectory = projects.find((p) => p.id === project)?.directory ?? repoClimbs?.projectDirectory ?? null;
  const canAttachContext = Boolean(connected && appRef.current?.getHostCapabilities()?.updateModelContext);
  const canSendToChat = Boolean(connected && appRef.current?.getHostCapabilities()?.message);

  const handleAttachContext = useCallback(
    async (id: string, label: string, markdown: string) => {
      const client = appRef.current;
      if (!client || !client.getHostCapabilities()?.updateModelContext) {
        setNotice("Attaching context to chat is only available when Hill Climb is open beside a conversation.");
        return;
      }
      try {
        if (attachedContext?.id === id) {
          await client.updateModelContext({ content: [] });
          setAttachedContext(null);
          setNotice("Cleared attached chat context.");
          return;
        }
        await client.updateModelContext({ content: [{ type: "text", text: markdown }] });
        setAttachedContext({ id, label });
        setNotice(`Attached ${label} to your next chat message.`);
      } catch (e) {
        setNotice(`Could not update chat context: ${errMsg(e)}`);
      }
    },
    [attachedContext],
  );

  const handleOpenFile = useCallback(
    async (filePath: string, baseDir?: string | null) => {
      const client = appRef.current;
      if (!client) return;
      const trimmed = filePath.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        if (client.getHostCapabilities()?.openLinks) {
          try {
            await client.openLink({ url: trimmed });
            return;
          } catch {
            // fall through to copy
          }
        }
        void navigator.clipboard?.writeText(trimmed).catch(() => {});
        setNotice(`Copied link: ${trimmed}`);
        return;
      }
      const uri = resolveLocalFileUri(trimmed, baseDir ?? currentProjectDirectory);
      if (!uri) {
        setNotice(`Link a local repository to open "${trimmed}".`);
        return;
      }
      try {
        const result = await client.request(
          {
            method: "com.google.antigravity/toggle-aux-pane",
            params: { tabType: "fileView", uri },
          } as unknown as Parameters<App["request"]>[0],
          TOGGLE_AUX_PANE_RESULT,
        );
        if (result.isError) {
          void navigator.clipboard?.writeText(trimmed).catch(() => {});
          setNotice(`Could not open "${trimmed}" in side pane (available in workspace side-pane view). Path copied.`);
        }
      } catch {
        void navigator.clipboard?.writeText(trimmed).catch(() => {});
        setNotice(`Path copied: ${trimmed} (direct file open requires Antigravity side-pane host).`);
      }
    },
    [currentProjectDirectory],
  );

  const activeSecondary = SECONDARY_PAGES.find((p) => p.id === page) ?? null;
  const currentInboxCount = tree?.inbox ?? 0;
  const otherPendingProjects = projects
    .filter((p) => p.id !== project && (inboxByProject[p.id] ?? 0) > 0)
    .map((p) => ({ id: p.id, name: p.name, count: inboxByProject[p.id]! }));

  if (connectError) {
    return (
      <main className="hill-shell" style={{ padding: 20 }}>
        <h1 style={{ fontSize: 16, margin: "0 0 8px" }}>Hill Climb</h1>
        <p role="alert">Could not connect to Antigravity MCP Apps host: {connectError}</p>
      </main>
    );
  }

  if (inlineDecision !== null) {
    return (
      <InlineDecisionCard
        decision={inlineDecision}
        canNotifyThread={Boolean(appRef.current?.getHostCapabilities()?.message)}
        onAct={handleInlineAct}
        onRefreshState={handleInlineRefresh}
        onNotifyThread={handleNotifyThread}
        onOpenFile={handleOpenFile}
        onResolveImage={handleResolveImage}
      />
    );
  }

  if (expectInline) {
    return (
      <section className="hill-inline-card">
        <p className="hill-inline-muted" role="status">Preparing decision…</p>
      </section>
    );
  }

  return (
    <main className="hill-shell">
      <header className="hill-topbar">
        <div className="hill-topbar-left">
          <h1 className="hill-brand">
            <span className="hill-brand-mark" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1.5 9.5L4.8 4.5L7.4 7L10.5 2.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Hill Climb
          </h1>
          <span className="hill-sep" aria-hidden="true">/</span>
          <select
            aria-label="Project"
            className="hill-project-select"
            value={project}
            onChange={(e) => {
              if (e.target.value === "__add__") {
                setAddProjectOpen(true);
                return;
              }
              setProject(e.target.value);
              setSelected(null);
            }}
          >
            {projects.length === 0 ? <option value="default">default</option> : null}
            {projects.map((p) => {
              const pending = inboxByProject[p.id] ?? 0;
              return (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {pending > 0 ? ` (${pending} pending)` : ""}
                </option>
              );
            })}
            <option value="__add__">+ Link repository…</option>
          </select>
        </div>

        <div className="hill-topbar-right">
          <button
            type="button"
            className="hill-cmd-trigger"
            title="Search or run a command (⌘K)"
            onClick={() => {
              closePopovers();
              setSearchOpen(true);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.8" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.8 10.8L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="hill-cmd-text">Search</span>
            <kbd className="hill-kbd">⌘K</kbd>
          </button>

          <button
            ref={actionsBtnRef}
            type="button"
            className="hill-icon-trigger hill-anchor-actions"
            aria-label="Project actions and settings"
            aria-haspopup="menu"
            popoverTarget="hc-actions-popover"
            onClick={() => {
              requestAnimationFrame(() => positionPopoverFallback(actionsBtnRef.current, actionsPopRef.current, true));
            }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.3" />
              <circle cx="8" cy="8" r="1.3" />
              <circle cx="12.5" cy="8" r="1.3" />
            </svg>
          </button>
          <div ref={actionsPopRef} id="hc-actions-popover" className="hill-popover" {...({ popover: "auto" } as Record<string, string>)}>
            <div className="hill-menu-list" role="menu" aria-label="Project actions">
              <button type="button" className="hill-menu-item" role="menuitem" disabled={!project} onClick={() => void openImportModal()}>
                <span>
                  Import template or Markdown…
                  <span className="hill-menu-desc">Seed goals from 5 blueprints or notes</span>
                </span>
              </button>
              <button type="button" className="hill-menu-item" role="menuitem" disabled={busy || !project} onClick={() => void handleLint()}>
                <span>
                  Check contract quality
                  <span className="hill-menu-desc">Run the 22-rule writing linter</span>
                </span>
              </button>
              <button type="button" className="hill-menu-item" role="menuitem" disabled={busy || !project} onClick={() => void handleSync()}>
                <span>
                  Sync .hillclimb/ folder
                  <span className="hill-menu-desc">Write readable Markdown mirror</span>
                </span>
              </button>
              <button type="button" className="hill-menu-item" role="menuitem" disabled={busy || !project} onClick={() => void handleReconcile()}>
                <span>
                  Check for finished runs
                  <span className="hill-menu-desc">Collect receipts from active workers</span>
                </span>
              </button>
              <hr className="hill-menu-sep" />
              <button
                type="button"
                className="hill-menu-item"
                role="menuitem"
                onClick={() => {
                  closePopovers();
                  setAddProjectOpen(true);
                }}
              >
                Link another repository…
              </button>
              <button type="button" className="hill-menu-item" role="menuitem" disabled={!project} onClick={() => void openSettingsModal()}>
                Settings &amp; hooks…
              </button>
            </div>
          </div>
        </div>
      </header>

      <nav className="hill-nav" aria-label="Primary navigation">
        <div className="hill-nav-items">
          <button
            type="button"
            className="hill-nav-btn"
            aria-current={page === "tree" ? "page" : undefined}
            onClick={() => setPage("tree")}
          >
            Goals
          </button>
          <button
            type="button"
            className="hill-nav-btn"
            aria-current={page === "climbs" ? "page" : undefined}
            onClick={() => setPage("climbs")}
          >
            Climbs
            {(repoClimbs?.currentCount ?? 0) > 0 ? (
              <span className="hill-nav-badge hill-nav-badge-climbs">{repoClimbs!.currentCount}</span>
            ) : null}
          </button>
          <button
            type="button"
            className="hill-nav-btn"
            aria-current={page === "inbox" ? "page" : undefined}
            onClick={() => setPage("inbox")}
          >
            Decisions
            {currentInboxCount > 0 ? <span className="hill-nav-badge">{currentInboxCount}</span> : null}
          </button>
          <button
            type="button"
            className="hill-nav-btn"
            aria-current={page === "flows" ? "page" : undefined}
            onClick={() => setPage("flows")}
          >
            Flows
          </button>

          <button
            ref={moreBtnRef}
            type="button"
            className={`hill-nav-btn hill-anchor-more${activeSecondary ? " is-current" : ""}`}
            aria-haspopup="menu"
            popoverTarget="hc-more-views"
            onClick={() => {
              requestAnimationFrame(() => positionPopoverFallback(moreBtnRef.current, morePopRef.current, false));
            }}
          >
            {activeSecondary ? activeSecondary.label : "More"}
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div ref={morePopRef} id="hc-more-views" className="hill-popover hill-popover-start" {...({ popover: "auto" } as Record<string, string>)}>
            <div className="hill-menu-list" role="menu" aria-label="More views">
              {SECONDARY_PAGES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className={`hill-menu-item${page === item.id ? " is-active" : ""}`}
                  onClick={() => {
                    closePopovers();
                    setPage(item.id);
                  }}
                >
                  <span>
                    {item.label}
                    <span className="hill-menu-desc">{item.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {tree && tree.tracks.length > 1 ? (
          <label className="hill-track-pill">
            <span>Track</span>
            <select value={track} onChange={(e) => setTrack(e.target.value)}>
              {tree.tracks.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </nav>

      <div className={"hill-workspace" + (selected ? " hill-inspecting" : "")}>
        {notice ? (
          <div className="hill-notice-bar" role="status">
            <span>{notice}</span>
            <button type="button" className="hill-action-btn" onClick={() => setNotice("")}>
              Dismiss
            </button>
          </div>
        ) : null}

        {treeError ? (
          <div className="hill-notice-bar" role="alert">
            <span>Could not load project: {treeError}</span>
            <button type="button" className="hill-action-btn" onClick={() => void loadTree(project, track)}>
              Retry
            </button>
          </div>
        ) : !tree ? (
          <p className="hc-hint" role="status">Loading project…</p>
        ) : (
          <>
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
                  setNotice("Verifier saved.");
                }}
              />
            ) : null}

            {page === "tree" && tree.outcomes.length === 0 && (repoClimbs?.climbs.length ?? 0) > 0 ? (
              <div className="hill-notice-bar" role="status">
                <span>
                  {repoClimbs!.currentCount > 0 ? (
                    <>
                      <strong>{repoClimbs!.currentCount}</strong> active climb
                      {repoClimbs!.currentCount === 1 ? "" : "s"} detected in this repository.
                    </>
                  ) : (
                    <>
                      <strong>{repoClimbs!.climbs.length}</strong> saved climb
                      {repoClimbs!.climbs.length === 1 ? "" : "s"} found in linked worktrees.
                    </>
                  )}
                </span>
                <button type="button" className="hill-action-btn" onClick={() => setPage("climbs")}>
                  View Climbs →
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
                onOpenImport={() => void openImportModal()}
              />
            ) : page === "climbs" ? (
              <RepoClimbsView
                key={project}
                payload={repoClimbs}
                loading={climbsLoading}
                onRefresh={() => void loadRepoClimbs(project)}
                onUpgradeEngine={handleUpgradeEngine}
                onToggleAutoTrack={handleToggleAutoTrack}
                onTrackClimb={handleTrackClimb}
                onOpenOutcome={handleOpenOutcomeFromClimb}
                attachedContextId={attachedContext?.id ?? null}
                onAttachContext={canAttachContext ? handleAttachContext : undefined}
                onOpenFile={handleOpenFile}
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
                otherPendingProjects={otherPendingProjects}
                onSelectProject={(id) => {
                  setProject(id);
                  setSelected(null);
                }}
                projectDirectory={currentProjectDirectory}
                attachedContextId={attachedContext?.id ?? null}
                onAttachContext={canAttachContext ? handleAttachContext : undefined}
                onOpenFile={handleOpenFile}
                onResolveImage={handleResolveActiveImage}
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
                projectDirectory={currentProjectDirectory}
                attachedContextId={attachedContext?.id ?? null}
                onAttachContext={canAttachContext ? handleAttachContext : undefined}
                onOpenFile={handleOpenFile}
                onSendToChat={canSendToChat ? handleNotifyThread : undefined}
              />
            ) : null}
          </>
        )}
      </div>

      <NativeModal
        open={searchOpen}
        title="Search & quick actions"
        onClose={() => setSearchOpen(false)}
      >
        <input
          autoFocus
          className="pf-input"
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setSearchOpen(false);
            }
          }}
          placeholder="Search goals, outcomes, climbs, flows, reports…"
          aria-label="Global search"
        />
        {searchQuery.trim() === "" ? (
          <div className="hill-menu-list">
            <p className="hc-hint" style={{ margin: "2px 4px 6px" }}>Quick jumps &amp; actions</p>
            {SECONDARY_PAGES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="hill-menu-item"
                onClick={() => {
                  setSearchOpen(false);
                  setPage(item.id);
                }}
              >
                <span>
                  Open {item.label}
                  <span className="hill-menu-desc">{item.desc}</span>
                </span>
              </button>
            ))}
            <hr className="hill-menu-sep" />
            <button type="button" className="hill-menu-item" onClick={() => void openImportModal()}>
              Import from template or Markdown…
            </button>
            <button type="button" className="hill-menu-item" onClick={() => void handleLint()}>
              Check contract quality (22 rules)
            </button>
            <button type="button" className="hill-menu-item" onClick={() => void handleSync()}>
              Sync .hillclimb/ folder
            </button>
            <button type="button" className="hill-menu-item" onClick={() => void openSettingsModal()}>
              Project settings &amp; hooks…
            </button>
          </div>
        ) : (
          <div className="hill-search-results">
            {searchLoading ? (
              <p className="hc-hint">Searching…</p>
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
        )}
      </NativeModal>

      <NativeModal
        open={importOpen}
        title="Start from a template or Markdown"
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <button type="button" className="hc-btn" onClick={() => setImportOpen(false)}>
              Cancel
            </button>
            <button type="button" className="hc-btn" disabled={busy} onClick={() => void handleImportRun("preview")}>
              Preview
            </button>
            <button
              type="button"
              className="hc-btn hc-btn-primary"
              disabled={busy || (importTab === "blueprints" && !selectedBlueprint)}
              onClick={() => void handleImportRun("apply")}
            >
              Add to Goals
            </button>
          </>
        }
      >
        <div className="cl-seg">
          <button
            type="button"
            className={importTab === "blueprints" ? "is-active" : ""}
            onClick={() => {
              setImportTab("blueprints");
              setImportPreview(null);
            }}
          >
            Templates ({blueprints.length})
          </button>
          <button
            type="button"
            className={importTab === "markdown" ? "is-active" : ""}
            onClick={() => {
              setImportTab("markdown");
              setImportPreview(null);
            }}
          >
            Paste Markdown
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
                <strong>{bp.name}</strong> · {bp.outcomeCount} outcomes
                <div className="hc-hint">{bp.description}</div>
              </label>
            ))}
          </div>
        ) : (
          <div className="hc-field">
            <label htmlFor="hc-import-md">Paste headings and acceptance bullets</label>
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

        <label className="hc-toggle">
          <input
            type="checkbox"
            checked={importAsProposals}
            onChange={(e) => setImportAsProposals(e.target.checked)}
          />
          <span>Queue as drafts in Decisions for review first</span>
        </label>

        {importPreview ? (
          <div className="hill-lint-item">
            <strong>Preview:</strong> {importPreview.actionCount} item(s) · Quality check:{" "}
            {importPreview.lint.passed
              ? "Passed"
              : `${importPreview.lint.errorCount} error(s), ${importPreview.lint.warningCount} warning(s)`}
          </div>
        ) : null}
      </NativeModal>

      <NativeModal
        open={settingsOpen}
        title="Project settings & automation"
        onClose={() => setSettingsOpen(false)}
        footer={
          <button type="button" className="hc-btn hc-btn-primary" onClick={() => setSettingsOpen(false)}>
            Done
          </button>
        }
      >
        <div className="hill-lint-list">
          <label className="hill-lint-item" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={settings.autoSyncMirror}
              onChange={(e) =>
                void syncViewsScopes("set_setting", { key: "autoSyncMirror", value: String(e.target.checked) })
              }
            />
            <span>
              <strong>Keep .hillclimb/ mirror synced automatically</strong>
              <span className="hill-menu-desc">Writes readable Markdown files whenever goals or evidence change.</span>
            </span>
          </label>
          <label className="hill-lint-item" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={settings.wakeOnAnswer}
              onChange={(e) =>
                void syncViewsScopes("set_setting", { key: "wakeOnAnswer", value: String(e.target.checked) })
              }
            />
            <span>
              <strong>Notify waiting agent when I answer or approve</strong>
              <span className="hill-menu-desc">Resumes the agent thread once a Decision is resolved.</span>
            </span>
          </label>
          <label className="hill-lint-item" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
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
              <strong>Require my approval before agents add new outcomes</strong>
              <span className="hill-menu-desc">Routes new agent outcomes to Decisions instead of adding directly.</span>
            </span>
          </label>
          <div className="hill-lint-item">
            <label htmlFor="hc-set-kit" className="pf-label">
              Default design kit (Flows)
            </label>
            <div className="pf-row" style={{ marginTop: 4 }}>
              <input
                id="hc-set-kit"
                className="pf-input"
                value={designKitDraft}
                onChange={(e) => setDesignKitDraft(e.target.value)}
                placeholder="e.g. Clean SaaS, shadcn/ui"
              />
              <button
                type="button"
                className="hc-btn"
                onClick={() => void syncViewsScopes("set_setting", { key: "designKit", value: designKitDraft.trim() })}
              >
                Save
              </button>
            </div>
          </div>
        </div>

        <details className="pf-disclosure">
          <summary>Event hooks ({hooks.length})</summary>
          <p className="hc-hint" style={{ marginBottom: 8 }}>
            Trigger macOS notifications, shell commands, or HMAC webhooks on key events.
          </p>
          <div className="hill-lint-list">
            {hooks.map((h) => (
              <div key={h.id} className="hill-lint-item" style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <div>
                  <strong>{h.event}</strong> · <span className="pf-pill">{h.targetType}</span> <code>{h.target}</code>
                </div>
                <button type="button" className="hc-btn" onClick={() => void syncViewsScopes("delete_hook", { id: h.id })}>
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
              <option value="*">* (all)</option>
            </select>
            <select
              aria-label="Hook target type"
              className="pf-select"
              style={{ width: "auto" }}
              value={hookType}
              onChange={(e) => setHookType(e.target.value as HookRecordDto["targetType"])}
            >
              <option value="notify">Desktop notify</option>
              <option value="shell">Shell</option>
              <option value="webhook">Webhook</option>
            </select>
            <input
              className="pf-input"
              value={hookTarget}
              onChange={(e) => setHookTarget(e.target.value)}
              placeholder={hookType === "notify" ? "Notification title" : hookType === "webhook" ? "https://..." : "./script.sh"}
            />
            <button type="submit" className="hc-btn hc-btn-primary">
              Add
            </button>
          </form>
        </details>
      </NativeModal>

      <NativeModal
        open={confirmDecision !== null}
        title={confirmDecision ? `Confirm ${confirmDecision.action.op.replaceAll("_", " ")}` : "Confirm"}
        onClose={() => {
          const pending = confirmDecision;
          setConfirmDecision(null);
          pending?.resolve(false);
        }}
        footer={
          <>
            <button
              type="button"
              className="hc-btn"
              autoFocus
              onClick={() => {
                const pending = confirmDecision;
                setConfirmDecision(null);
                pending?.resolve(false);
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
                pending?.resolve(true);
              }}
            >
              Confirm
            </button>
          </>
        }
      >
        {confirmDecision ? (
          <>
            <p className="hc-hint">Review the change below before applying it to your project.</p>
            {confirmDecision.previous ? (
              <details>
                <summary>Current approved version</summary>
                <pre>{JSON.stringify(confirmDecision.previous, null, 2)}</pre>
              </details>
            ) : null}
            <pre>{JSON.stringify(confirmDecision.details, null, 2)}</pre>
          </>
        ) : null}
      </NativeModal>

      <NativeModal
        open={addProjectOpen}
        title="Link a local repository"
        onClose={() => setAddProjectOpen(false)}
        footer={
          <>
            <button type="button" className="hc-btn" onClick={() => setAddProjectOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="hc-add-project-form" className="hc-btn hc-btn-primary" disabled={busy}>
              Link repository
            </button>
          </>
        }
      >
        <form id="hc-add-project-form" onSubmit={(e) => void handleRegisterProject(e)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="hc-hint">Link a git checkout so Hill Climb can track climbs, sync `.hillclimb/`, and run verifiers.</p>
          <div className="hc-field">
            <label htmlFor="hc-new-proj-name">Display name</label>
            <input
              id="hc-new-proj-name"
              autoFocus
              value={newProjName}
              onChange={(e) => setNewProjName(e.target.value)}
              placeholder="e.g. Checkout App"
            />
          </div>
          <div className="hc-field">
            <label htmlFor="hc-new-proj-dir">Repository path</label>
            <input
              id="hc-new-proj-dir"
              value={newProjDir}
              onChange={(e) => setNewProjDir(e.target.value)}
              placeholder="/path/to/my-repo"
            />
          </div>
        </form>
      </NativeModal>

      <NativeModal
        open={lintReport !== null}
        title={
          lintReport
            ? lintReport.passed
              ? "Contract quality — All clear"
              : `Contract quality — ${lintReport.errorCount} error(s), ${lintReport.warningCount} warning(s)`
            : "Contract quality"
        }
        onClose={() => setLintReport(null)}
        footer={
          <button type="button" className="hc-btn hc-btn-primary" autoFocus onClick={() => setLintReport(null)}>
            Close
          </button>
        }
      >
        {lintReport ? (
          lintReport.findings.length === 0 ? (
            <p>All 22 rubric rules passed with zero findings.</p>
          ) : (
            <div className="hill-lint-list">
              {lintReport.findings.map((f) => (
                <div key={f.id} className="hill-lint-item">
                  <strong>
                    [{f.severity}] {f.checkCode} ({f.itemKey})
                  </strong>{" "}
                  — {f.checkTitle}
                  <div>{f.issue}</div>
                  {f.proposed ? <div className="hc-hint">Suggestion: {f.proposed}</div> : null}
                </div>
              ))}
            </div>
          )
        ) : null}
      </NativeModal>
    </main>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<HillClimbApp />);
}
