import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { Release } from "../model.js";
import type { ArtifactRecordDto, ArtifactTemplateDto } from "../view-props.js";

export interface ReportsViewProps {
  projectId: string;
  track: string;
  releases: Release[];
  initialArtifactId?: string | null;
  callArtifacts: <T>(mode: "list" | "save" | "generate" | "export" | "delete", payload?: Record<string, unknown>) => Promise<T>;
  onSelectOutcome: (key: string) => void;
  onNotice: (msg: string) => void;
}

function triggerDownload(filename: string, content: string, mime: string): void {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // Fallback handled by caller
  }
}

export function ReportsView(props: ReportsViewProps): JSX.Element {
  const { projectId, track, releases, initialArtifactId, callArtifacts, onSelectOutcome, onNotice } = props;
  const [artifacts, setArtifacts] = useState<ArtifactRecordDto[]>([]);
  const [templates, setTemplates] = useState<ArtifactTemplateDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialArtifactId ?? null);
  const [folderFilter, setFolderFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generator controls
  const [templateId, setTemplateId] = useState<ArtifactTemplateDto["id"]>("weekly-update");
  const [releaseName, setReleaseName] = useState<string>("");

  // Editor state
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("General");
  const [body, setBody] = useState("");
  const [locked, setLocked] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [exportPreview, setExportPreview] = useState<{ filename: string; format: string; content: string } | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await callArtifacts<{ templates: ArtifactTemplateDto[]; artifacts: ArtifactRecordDto[] }>("list");
      setTemplates(res.templates ?? []);
      setArtifacts(res.artifacts ?? []);
      setSelectedId((prev) => {
        if (prev && res.artifacts.some((a) => a.id === prev)) return prev;
        if (initialArtifactId && res.artifacts.some((a) => a.id === initialArtifactId)) return initialArtifactId;
        return res.artifacts[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [callArtifacts, initialArtifactId]);

  useEffect(() => {
    void loadList();
  }, [projectId, loadList]);

  useEffect(() => {
    if (initialArtifactId) setSelectedId(initialArtifactId);
  }, [initialArtifactId]);

  const current = useMemo(
    () => (creatingNew ? null : artifacts.find((a) => a.id === selectedId) ?? null),
    [artifacts, selectedId, creatingNew],
  );

  useEffect(() => {
    if (creatingNew) {
      setTitle("");
      setFolder("General");
      setBody("");
      setLocked(false);
      setShowHistory(false);
      return;
    }
    if (current) {
      setTitle(current.title);
      setFolder(current.folder);
      setBody(current.body);
      setLocked(current.locked);
      setShowHistory(false);
    }
  }, [current, creatingNew]);

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const a of artifacts) set.add(a.folder || "General");
    return [...set].sort();
  }, [artifacts]);

  const filtered = useMemo(
    () => (folderFilter === "all" ? artifacts : artifacts.filter((a) => (a.folder || "General") === folderFilter)),
    [artifacts, folderFilter],
  );

  const handleGenerate = async () => {
    setBusy("generate");
    setError(null);
    try {
      const res = await callArtifacts<{ artifact?: ArtifactRecordDto; artifacts: ArtifactRecordDto[] }>("generate", {
        template: templateId,
        releaseName: releaseName || undefined,
      });
      setArtifacts(res.artifacts ?? []);
      setCreatingNew(false);
      if (res.artifact) {
        setSelectedId(res.artifact.id);
        onNotice(`Generated report "${res.artifact.title}".`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      setError("Report title is required.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const res = await callArtifacts<{ artifact: ArtifactRecordDto; artifacts: ArtifactRecordDto[] }>("save", {
        id: creatingNew ? undefined : current?.id,
        title: title.trim(),
        folder: folder.trim() || "General",
        body,
        locked,
        citations: current?.citations ?? [],
      });
      setArtifacts(res.artifacts ?? []);
      setCreatingNew(false);
      setSelectedId(res.artifact.id);
      onNotice(`Saved "${res.artifact.title}" (v${res.artifact.version}).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleToggleLock = async () => {
    if (!current) return;
    setBusy("lock");
    setError(null);
    try {
      const nextLocked = !current.locked;
      const res = await callArtifacts<{ artifact: ArtifactRecordDto; artifacts: ArtifactRecordDto[] }>("save", {
        id: current.id,
        title: current.title,
        folder: current.folder,
        body: current.body,
        locked: nextLocked,
        citations: current.citations,
      });
      setArtifacts(res.artifacts ?? []);
      onNotice(nextLocked ? `Locked "${current.title}" against agent edits.` : `Unlocked "${current.title}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!current) return;
    setBusy("delete");
    setError(null);
    try {
      const res = await callArtifacts<{ artifacts: ArtifactRecordDto[] }>("delete", { id: current.id });
      setArtifacts(res.artifacts ?? []);
      setSelectedId(res.artifacts[0]?.id ?? null);
      onNotice(`Deleted "${current.title}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async (format: "html" | "markdown") => {
    setBusy(`export:${format}`);
    setError(null);
    try {
      const res = await callArtifacts<{ filename: string; format: string; content: string; outcomesIncluded: number }>(
        "export",
        { format, track, releaseName: releaseName || undefined },
      );
      setExportPreview({ filename: res.filename, format: res.format, content: res.content });
      triggerDownload(res.filename, res.content, format === "html" ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8");
      onNotice(`Exported ${res.filename} (${res.outcomesIncluded} outcomes).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleCitationClick = (cite: string) => {
    const match = /^outcome:([^@]+)/.exec(cite);
    if (match?.[1]) onSelectOutcome(match[1]);
  };

  return (
    <section className="pf hc-reports" aria-label="Reports and Artifacts">
      <header className="pf-head">
        <div>
          <h2 className="pf-title">Reports &amp; Artifacts</h2>
          <p className="pf-sub">
            Evidence-backed Markdown reports with citations, revision history, locks, and shareable HTML snapshots.
          </p>
        </div>
        <div className="pf-actions">
          <button
            type="button"
            className="pf-btn pf-btn-ghost"
            disabled={busy !== null}
            onClick={() => void handleExport("html")}
          >
            {busy === "export:html" ? "Exporting…" : "Export HTML"}
          </button>
          <button
            type="button"
            className="pf-btn pf-btn-ghost"
            disabled={busy !== null}
            onClick={() => void handleExport("markdown")}
          >
            {busy === "export:markdown" ? "Exporting…" : "Export MD"}
          </button>
          <button
            type="button"
            className="pf-btn pf-btn-primary"
            onClick={() => {
              setCreatingNew(true);
              setError(null);
            }}
          >
            + New Report
          </button>
        </div>
      </header>

      {error ? (
        <p className="pf-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="pf-card hc-report-gen">
        <div className="pf-row">
          <label className="pf-label" htmlFor="hc-rep-tpl">
            Generate from live tree
          </label>
          <select
            id="hc-rep-tpl"
            className="pf-select"
            style={{ maxWidth: 260 }}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value as ArtifactTemplateDto["id"])}
          >
            {(templates.length > 0
              ? templates
              : [
                  { id: "weekly-update", title: "Weekly Progress Update", folder: "Updates", description: "" },
                  { id: "release-readiness", title: "Release Readiness Brief", folder: "Releases", description: "" },
                  { id: "climb-experiment-report", title: "Climb & Eval Experiment Report", folder: "Experiments", description: "" },
                  { id: "compliance-audit", title: "Contract & Evidence Audit Pack", folder: "Compliance", description: "" },
                  { id: "postmortem", title: "Regression Postmortem", folder: "Postmortems", description: "" },
                ]
            ).map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          {releases.length > 0 ? (
            <select
              aria-label="Filter by release"
              className="pf-select"
              style={{ maxWidth: 200 }}
              value={releaseName}
              onChange={(e) => setReleaseName(e.target.value)}
            >
              <option value="">All releases</option>
              {releases.map((r) => (
                <option key={`${r.name}:${r.scenario}`} value={r.name}>
                  {r.name} ({r.scenario})
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" className="pf-btn pf-btn-primary" disabled={busy !== null} onClick={() => void handleGenerate()}>
            {busy === "generate" ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>

      {exportPreview ? (
        <div className="pf-card">
          <header className="pf-card-head">
            <div>
              <h3 className="pf-card-title">Exported: {exportPreview.filename}</h3>
              <p className="pf-muted pf-small">
                Self-contained {exportPreview.format.toUpperCase()} snapshot ({exportPreview.content.length.toLocaleString()} chars).
              </p>
            </div>
            <div className="pf-actions">
              <button
                type="button"
                className="pf-btn pf-btn-ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(exportPreview.content);
                  onNotice("Copied exported snapshot to clipboard.");
                }}
              >
                Copy source
              </button>
              <button type="button" className="pf-btn pf-btn-ghost" onClick={() => setExportPreview(null)}>
                Close
              </button>
            </div>
          </header>
        </div>
      ) : null}

      <div className="pf-flows">
        <aside className="pf-flow-list" aria-label="Saved reports">
          <div className="pf-row pf-between">
            <h3 className="pf-section-title">Artifacts ({filtered.length})</h3>
            {folders.length > 1 ? (
              <select
                aria-label="Filter folder"
                className="pf-select"
                style={{ maxWidth: 120 }}
                value={folderFilter}
                onChange={(e) => setFolderFilter(e.target.value)}
              >
                <option value="all">All folders</option>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {loading && artifacts.length === 0 ? (
            <p className="pf-muted pf-small">Loading reports…</p>
          ) : filtered.length === 0 ? (
            <p className="pf-muted pf-small">No reports yet. Generate one above or click + New Report.</p>
          ) : (
            <ul>
              {filtered.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`pf-flow-item${!creatingNew && selectedId === item.id ? " is-active" : ""}`}
                    onClick={() => {
                      setCreatingNew(false);
                      setSelectedId(item.id);
                    }}
                  >
                    <span className="pf-flow-name">
                      {item.locked ? "🔒 " : ""}
                      {item.title}
                    </span>
                    <span className="pf-muted pf-small">
                      {item.folder} · v{item.version} · {item.citations.length} cite{item.citations.length === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="pf-flow-main" aria-label="Report editor">
          {!creatingNew && !current ? (
            <div className="pf-empty">
              <p className="pf-empty-title">No report selected</p>
              <p className="pf-muted">
                Generate a Weekly Progress Update, Release Readiness Brief, or Climb Experiment Report from your live tree, or
                create a custom Markdown report.
              </p>
            </div>
          ) : (
            <div className="pf-card">
              <header className="pf-card-head">
                <div>
                  <h3 className="pf-card-title">{creatingNew ? "New Report" : current?.title}</h3>
                  {current ? (
                    <p className="pf-muted pf-small">
                      <code>{current.id}</code> · v{current.version} · updated {new Date(current.updated).toLocaleString()}
                      {current.actor ? ` · by ${current.actor}` : ""}
                    </p>
                  ) : null}
                </div>
                {current ? (
                  <div className="pf-actions">
                    <button
                      type="button"
                      className="pf-btn pf-btn-ghost"
                      disabled={busy !== null}
                      onClick={() => void handleToggleLock()}
                    >
                      {current.locked ? "Unlock" : "Lock"}
                    </button>
                    {current.history.length > 0 ? (
                      <button
                        type="button"
                        className="pf-btn pf-btn-ghost"
                        onClick={() => setShowHistory((v) => !v)}
                      >
                        History ({current.history.length})
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="pf-btn pf-btn-danger"
                      disabled={busy !== null}
                      onClick={() => void handleDelete()}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </header>

              <div className="pf-grid">
                <div className="pf-field">
                  <label className="pf-label" htmlFor="hc-art-title">
                    Title
                  </label>
                  <input
                    id="hc-art-title"
                    className="pf-input"
                    value={title}
                    disabled={!creatingNew && current?.locked}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Weekly update — Nov 27"
                  />
                </div>
                <div className="pf-field">
                  <label className="pf-label" htmlFor="hc-art-folder">
                    Folder
                  </label>
                  <input
                    id="hc-art-folder"
                    className="pf-input"
                    value={folder}
                    disabled={!creatingNew && current?.locked}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="Updates"
                  />
                </div>
              </div>

              {current && current.citations.length > 0 ? (
                <div>
                  <span className="pf-label">Live citations</span>
                  <div className="pf-actions" style={{ marginTop: 4 }}>
                    {current.citations.slice(0, 20).map((cite) => (
                      <button
                        key={cite}
                        type="button"
                        className="pf-chip"
                        title={cite.startsWith("outcome:") ? "Open outcome" : cite}
                        onClick={() => handleCitationClick(cite)}
                      >
                        {cite}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="pf-field">
                <label className="pf-label" htmlFor="hc-art-body">
                  Markdown body
                </label>
                <textarea
                  id="hc-art-body"
                  className="pf-textarea"
                  rows={16}
                  value={body}
                  disabled={!creatingNew && current?.locked}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="# Summary..."
                />
              </div>

              <div className="pf-actions">
                <button
                  type="button"
                  className="pf-btn pf-btn-primary"
                  disabled={busy !== null || (!creatingNew && current?.locked)}
                  onClick={() => void handleSave()}
                >
                  {busy === "save" ? "Saving…" : creatingNew ? "Create report" : "Save new revision"}
                </button>
                <button
                  type="button"
                  className="pf-btn pf-btn-ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(body);
                    onNotice("Copied report Markdown to clipboard.");
                  }}
                >
                  Copy Markdown
                </button>
                {creatingNew ? (
                  <button type="button" className="pf-btn pf-btn-ghost" onClick={() => setCreatingNew(false)}>
                    Cancel
                  </button>
                ) : null}
              </div>

              {showHistory && current && current.history.length > 0 ? (
                <div className="pf-section" style={{ marginTop: 8 }}>
                  <h4 className="pf-section-title">Previous revisions</h4>
                  <div className="pf-stack">
                    {current.history
                      .slice()
                      .reverse()
                      .map((rev) => (
                        <details key={rev.version} className="pf-disclosure">
                          <summary>
                            v{rev.version} · {rev.title} · {new Date(rev.at).toLocaleString()}
                            {rev.actor ? ` · ${rev.actor}` : ""}
                          </summary>
                          <pre className="cl-pre">{rev.body}</pre>
                          {!current.locked ? (
                            <button
                              type="button"
                              className="pf-btn pf-btn-ghost"
                              style={{ marginTop: 6 }}
                              onClick={() => {
                                setTitle(rev.title);
                                setBody(rev.body);
                                onNotice(`Loaded v${rev.version} into editor — click Save to publish.`);
                              }}
                            >
                              Load v{rev.version} into editor
                            </button>
                          ) : null}
                        </details>
                      ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
