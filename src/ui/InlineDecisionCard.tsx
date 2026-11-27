import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { Action } from "../actions.js";
import type { Change, Comment, Flow, FlowProposal, Frame, Outcome, PinKind } from "../model.js";
import { contractDiff, contractOf } from "./OutcomeDrawer.js";
import { FrameAnnotator, type DrawnAnnotation } from "./FrameAnnotator.js";

export type InlineDecisionPayload =
  | {
      kind: "change";
      projectId: string;
      change: Change;
      currentOutcome: Outcome | null;
    }
  | {
      kind: "question";
      projectId: string;
      comment: Comment;
      outcomeTitle: string;
    }
  | {
      kind: "design_kit";
      projectId: string;
      projectDirectory: string | null;
      designKit: string | null;
      tokenCount: number;
      tailwindDetected: boolean;
      componentCount: number;
      components: Array<{ name: string; path: string }>;
    }
  | {
      kind: "flow_proposal";
      projectId: string;
      projectDirectory: string | null;
      proposal: FlowProposal;
      currentFrame: Frame | null;
    }
  | {
      kind: "flow_inspect";
      projectId: string;
      projectDirectory: string | null;
      flow: Flow;
      note?: string;
    };

export interface InlineDecisionCardProps {
  decision: InlineDecisionPayload;
  canNotifyThread: boolean;
  onAct: (projectId: string, action: Action) => Promise<void>;
  onRefreshState: (
    projectId: string,
    kind: "change" | "question" | "flow_proposal" | "flow_inspect",
    id: string,
  ) => Promise<{
    change?: Change | null;
    currentOutcome?: Outcome | null;
    comment?: Comment | null;
    proposal?: FlowProposal | null;
    currentFrame?: Frame | null;
    flow?: Flow | null;
  }>;
  onNotifyThread: (text: string) => Promise<boolean>;
  onOpenFile?: (filePath: string, baseDir?: string | null) => Promise<void>;
  onResolveImage?: (projectId: string, imagePath: string) => Promise<string | null>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ViewportMode = "auto" | "mobile" | "laptop";

function viewportStyleOf(mode: ViewportMode): React.CSSProperties | undefined {
  if (mode === "mobile") return { maxWidth: 360, height: 420, margin: "0 auto" };
  if (mode === "laptop") return { maxWidth: 780, height: 340, margin: "0 auto" };
  return undefined;
}

function formatAnnotationSummary(
  notes: Array<{ kind: PinKind; x: number; y: number; text: string; geometry?: Record<string, number | number[]> }>,
): string {
  return notes
    .map((n, i) => {
      const coords = `${Math.round(n.x * 100)}%,${Math.round(n.y * 100)}%`;
      const shape =
        n.kind === "rect" && n.geometry?.w && n.geometry?.h
          ? `box ${Math.round(Number(n.geometry.w) * 100)}%×${Math.round(Number(n.geometry.h) * 100)}% @ ${coords}`
          : `${n.kind} @ ${coords}`;
      return `${i + 1}) [${shape}] ${n.text}`;
    })
    .join("; ");
}

export function InlineDecisionCard(props: InlineDecisionCardProps): JSX.Element {
  const { decision, canNotifyThread, onAct, onRefreshState, onNotifyThread, onOpenFile, onResolveImage } = props;
  const [changeState, setChangeState] = useState<Change | null>(decision.kind === "change" ? decision.change : null);
  const [currentOutcome, setCurrentOutcome] = useState<Outcome | null>(
    decision.kind === "change" ? decision.currentOutcome : null,
  );
  const [commentState, setCommentState] = useState<Comment | null>(
    decision.kind === "question" ? decision.comment : null,
  );
  const [proposalState, setProposalState] = useState<FlowProposal | null>(
    decision.kind === "flow_proposal" ? decision.proposal : null,
  );
  const [currentFrameState, setCurrentFrameState] = useState<Frame | null>(
    decision.kind === "flow_proposal" ? decision.currentFrame : null,
  );
  const [flowState, setFlowState] = useState<Flow | null>(decision.kind === "flow_inspect" ? decision.flow : null);

  const [customAnswer, setCustomAnswer] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threadNote, setThreadNote] = useState<string | null>(null);

  // Visual design review state
  const [frameCursor, setFrameCursor] = useState(0);
  const [viewportMode, setViewportMode] = useState<ViewportMode>("auto");
  const [drawTool, setDrawTool] = useState<PinKind | null>(null);
  const [pendingDraw, setPendingDraw] = useState<DrawnAnnotation | null>(null);
  const [pinNoteDraft, setPinNoteDraft] = useState("");
  const [draftNotes, setDraftNotes] = useState<
    Array<{ kind: PinKind; x: number; y: number; text: string; geometry?: Record<string, number | number[]> }>
  >([]);
  const [reviewNote, setReviewNote] = useState("");

  useEffect(() => {
    setError(null);
    setThreadNote(null);
    setFrameCursor(0);
    setDrawTool(null);
    setPendingDraw(null);
    setPinNoteDraft("");
    setDraftNotes([]);
    setReviewNote("");
    setChangeState(decision.kind === "change" ? decision.change : null);
    setCurrentOutcome(decision.kind === "change" ? decision.currentOutcome : null);
    setCommentState(decision.kind === "question" ? decision.comment : null);
    setProposalState(decision.kind === "flow_proposal" ? decision.proposal : null);
    setCurrentFrameState(decision.kind === "flow_proposal" ? decision.currentFrame : null);
    setFlowState(decision.kind === "flow_inspect" ? decision.flow : null);
  }, [decision]);

  // Sync live state once on mount so scrolling back in history reflects decisions made in Flows / Decisions tab.
  useEffect(() => {
    if (decision.kind === "design_kit") return;
    let alive = true;
    const id =
      decision.kind === "change"
        ? decision.change.id
        : decision.kind === "question"
          ? decision.comment.id
          : decision.kind === "flow_proposal"
            ? decision.proposal.id
            : decision.flow.name;
    void onRefreshState(decision.projectId, decision.kind, id)
      .then((res) => {
        if (!alive) return;
        if (decision.kind === "change" && res.change) {
          setChangeState(res.change);
          if (res.currentOutcome !== undefined) setCurrentOutcome(res.currentOutcome);
        } else if (decision.kind === "question" && res.comment) {
          setCommentState(res.comment);
        } else if (decision.kind === "flow_proposal" && res.proposal) {
          setProposalState(res.proposal);
          if (res.currentFrame !== undefined) setCurrentFrameState(res.currentFrame);
        } else if (decision.kind === "flow_inspect" && res.flow) {
          setFlowState(res.flow);
        }
      })
      .catch(() => {
        // Keep initial snapshot if offline
      });
    return () => {
      alive = false;
    };
  }, [decision, onRefreshState]);

  const diffRows = useMemo(() => {
    if (!changeState || changeState.kind === "create" || !currentOutcome) return [];
    return contractDiff(contractOf(currentOutcome), changeState.proposed).filter((row) => row.kind !== "same");
  }, [changeState, currentOutcome]);

  // -------------------------------------------------------------------------
  // 1. Design Kit Discovery Pill
  // -------------------------------------------------------------------------
  if (decision.kind === "design_kit") {
    return (
      <section className="hill-inline-card" aria-label="Design kit scanned">
        <header className="hill-inline-head">
          <div className="hill-inline-title-wrap">
            <span className="hill-inline-pill is-approved">UI kit ready</span>
            <strong className="hill-inline-title">
              {decision.componentCount} component{decision.componentCount === 1 ? "" : "s"} · {decision.tokenCount} CSS token
              {decision.tokenCount === 1 ? "" : "s"}
              {decision.tailwindDetected ? " · Tailwind" : ""}
            </strong>
          </div>
          {decision.designKit ? <code className="hill-inline-key">{decision.designKit}</code> : null}
        </header>
        {decision.components.length > 0 ? (
          <div className="hill-inline-options">
            {decision.components.map((c) =>
              onOpenFile && decision.projectDirectory ? (
                <button
                  key={c.path}
                  type="button"
                  className="hc-chip hc-file-chip"
                  title={c.path}
                  onClick={() => void onOpenFile(c.path, decision.projectDirectory)}
                >
                  {c.name} ↗
                </button>
              ) : (
                <span key={c.path} className="hc-chip" title={c.path}>
                  {c.name}
                </span>
              ),
            )}
          </div>
        ) : null}
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // 2. Visual Flow Proposal Review Card (Before/After + Drag-to-Draw + Accept/Send back)
  // -------------------------------------------------------------------------
  if (decision.kind === "flow_proposal" && proposalState) {
    const proposedFrames =
      proposalState.kind === "new_flow"
        ? (proposalState.frames ?? (proposalState.frame ? [proposalState.frame] : []))
        : proposalState.frame
          ? [proposalState.frame]
          : [];
    const activeIdx = Math.min(frameCursor, Math.max(0, proposedFrames.length - 1));
    const activeFrame = proposedFrames[activeIdx] ?? null;
    const pending = proposalState.state === "pending";
    const componentsUsed = [
      ...new Set([...(proposalState.componentRefs ?? []), ...(activeFrame?.componentRefs ?? [])]),
    ];

    const handleFlowDecision = async (op: "accept_flow_change" | "reject_flow_change") => {
      setBusy(op);
      setError(null);
      const pinSummary = draftNotes.length > 0 ? formatAnnotationSummary(draftNotes) : "";
      const combinedNote = [reviewNote.trim(), pinSummary ? `Visual annotations: ${pinSummary}` : ""]
        .filter(Boolean)
        .join("\n");
      try {
        await onAct(decision.projectId, {
          op,
          id: proposalState.id,
          ...(combinedNote ? { reviewNote: combinedNote } : {}),
        });
        // If accepting and user also drew pins on the accepted screen, persist them cleanly on the flow!
        if (op === "accept_flow_change" && draftNotes.length > 0) {
          const targetIdx = proposalState.frameIndex ?? activeIdx;
          for (const note of draftNotes) {
            try {
              await onAct(decision.projectId, {
                op: "pin",
                name: proposalState.flowName,
                frame: targetIdx,
                x: note.x,
                y: note.y,
                text: note.text,
                kind: note.kind,
                ...(note.geometry ? { geometry: note.geometry } : {}),
                forAgents: true,
              });
            } catch {
              // best-effort pin save
            }
          }
        }
        const nextState = op === "accept_flow_change" ? "accepted" : "rejected";
        setProposalState({ ...proposalState, state: nextState, reviewNote: combinedNote || null });
        setDrawTool(null);
        setPendingDraw(null);
        if (canNotifyThread) {
          const msg =
            op === "accept_flow_change"
              ? `Accepted visual design "${proposalState.flowName}" (${proposalState.id})${combinedNote ? ` with note: ${combinedNote}` : ""}. Proceed to implement it.`
              : `Sent back visual design "${proposalState.flowName}" (${proposalState.id})${combinedNote ? ` — please revise based on: ${combinedNote}` : " — please revise and propose an updated mockup."}`;
          const sent = await onNotifyThread(msg);
          if (sent) setThreadNote("Sent decision to this thread");
        }
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(null);
      }
    };

    const resolveImg = onResolveImage ? (path: string) => onResolveImage(decision.projectId, path) : undefined;

    return (
      <section className="hill-inline-card hill-inline-design" aria-label={`Visual design review: ${proposalState.flowName}`}>
        <header className="hill-inline-head">
          <div className="hill-inline-title-wrap">
            <span
              className={`hill-inline-pill ${
                pending ? "is-pending" : proposalState.state === "accepted" ? "is-approved" : "is-rejected"
              }`}
            >
              {pending
                ? proposalState.kind === "new_flow"
                  ? "Design review"
                  : proposalState.kind === "new_step"
                    ? "New step"
                    : "Visual update"
                : proposalState.state === "accepted"
                  ? "Accepted"
                  : "Sent back"}
            </span>
            <strong className="hill-inline-title">
              {proposalState.flowName}
              {activeFrame ? ` · ${activeFrame.title}` : ""}
            </strong>
          </div>
          {activeFrame ? (
            <code className="hill-inline-key">
              {activeFrame.key} / {activeFrame.criterionId}
            </code>
          ) : null}
        </header>

        {proposalState.note ? <p className="hill-inline-story">{proposalState.note}</p> : null}

        {componentsUsed.length > 0 ? (
          <div className="hill-inline-options" aria-label="Components used">
            <span className="hill-inline-hint">Components:</span>
            {componentsUsed.map((comp) =>
              onOpenFile && decision.projectDirectory ? (
                <button
                  key={comp}
                  type="button"
                  className="hc-chip hc-file-chip"
                  onClick={() => void onOpenFile(comp, decision.projectDirectory)}
                >
                  <code>{comp.split("/").pop()}</code> ↗
                </button>
              ) : (
                <code key={comp} className="hc-chip">
                  {comp.split("/").pop()}
                </code>
              ),
            )}
          </div>
        ) : null}

        {error ? (
          <p className="hill-inline-error" role="alert">
            {error}
          </p>
        ) : null}

        {pending && activeFrame ? (
          <>
            <div className="hill-inline-toolbar">
              <div className="cl-seg" role="group" aria-label="Annotation drawing tool">
                <button
                  type="button"
                  className={drawTool === null ? "is-active" : ""}
                  onClick={() => {
                    setDrawTool(null);
                    setPendingDraw(null);
                  }}
                >
                  View
                </button>
                <button
                  type="button"
                  className={drawTool === "point" ? "is-active" : ""}
                  onClick={() => setDrawTool("point")}
                >
                  Pin
                </button>
                <button
                  type="button"
                  className={drawTool === "rect" ? "is-active" : ""}
                  onClick={() => setDrawTool("rect")}
                >
                  Box
                </button>
                <button
                  type="button"
                  className={drawTool === "arrow" ? "is-active" : ""}
                  onClick={() => setDrawTool("arrow")}
                >
                  Arrow
                </button>
                <button
                  type="button"
                  className={drawTool === "path" ? "is-active" : ""}
                  onClick={() => setDrawTool("path")}
                >
                  Draw
                </button>
              </div>
              <div className="hill-inline-options">
                {proposedFrames.length > 1 ? (
                  <span className="hill-inline-options">
                    <button
                      type="button"
                      className="hc-btn"
                      disabled={activeIdx <= 0}
                      onClick={() => setFrameCursor((i) => Math.max(0, i - 1))}
                    >
                      ←
                    </button>
                    <span className="hill-inline-hint">
                      {activeIdx + 1}/{proposedFrames.length}
                    </span>
                    <button
                      type="button"
                      className="hc-btn"
                      disabled={activeIdx >= proposedFrames.length - 1}
                      onClick={() => setFrameCursor((i) => Math.min(proposedFrames.length - 1, i + 1))}
                    >
                      →
                    </button>
                  </span>
                ) : null}
                <select
                  aria-label="Preview viewport"
                  className="hc-mini-select"
                  value={viewportMode}
                  onChange={(e) => setViewportMode(e.target.value as ViewportMode)}
                >
                  <option value="auto">Auto</option>
                  <option value="mobile">Mobile</option>
                  <option value="laptop">Laptop</option>
                </select>
              </div>
            </div>

            {drawTool ? (
              <p className="hill-inline-hint">
                {drawTool === "point"
                  ? "Click anywhere on the mockup to drop a pin."
                  : drawTool === "rect"
                    ? "Click and drag on the mockup to draw a highlight box."
                    : drawTool === "arrow"
                      ? "Drag from label start to target to draw a callout arrow."
                      : "Click and drag to sketch freehand feedback on the mockup."}
              </p>
            ) : null}

            {currentFrameState && proposalState.kind === "change" ? (
              <div className="pf-compare-frames">
                <div>
                  <span className="hill-inline-hint">Current approved (v{currentFrameState.version ?? 1})</span>
                  <FrameAnnotator
                    title={`Current ${currentFrameState.title}`}
                    kind={currentFrameState.kind}
                    html={currentFrameState.html}
                    imagePath={currentFrameState.imagePath}
                    pins={currentFrameState.pins}
                    drawTool={null}
                    compact
                    resolveImage={resolveImg}
                  />
                </div>
                <div>
                  <span className="hill-inline-hint">Proposed update</span>
                  <FrameAnnotator
                    title={`Proposed ${activeFrame.title}`}
                    kind={activeFrame.kind}
                    html={activeFrame.html}
                    imagePath={activeFrame.imagePath}
                    pins={[]}
                    draftPins={draftNotes}
                    drawTool={drawTool}
                    compact
                    onDrawComplete={(drawn) => setPendingDraw(drawn)}
                    resolveImage={resolveImg}
                  />
                </div>
              </div>
            ) : (
              <FrameAnnotator
                title={activeFrame.title}
                kind={activeFrame.kind}
                html={activeFrame.html}
                imagePath={activeFrame.imagePath}
                pins={[]}
                draftPins={draftNotes}
                drawTool={drawTool}
                compact
                canvasStyle={viewportStyleOf(viewportMode)}
                onDrawComplete={(drawn) => setPendingDraw(drawn)}
                resolveImage={resolveImg}
              />
            )}

            {pendingDraw ? (
              <form
                className="hill-inline-custom"
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = pinNoteDraft.trim();
                  if (!trimmed) return;
                  setDraftNotes((cur) => [
                    ...cur,
                    { kind: pendingDraw.kind, x: pendingDraw.x, y: pendingDraw.y, geometry: pendingDraw.geometry, text: trimmed },
                  ]);
                  setPinNoteDraft("");
                  setPendingDraw(null);
                  setDrawTool(null);
                }}
              >
                <input
                  className="hc-mini-input"
                  value={pinNoteDraft}
                  onChange={(e) => setPinNoteDraft(e.target.value)}
                  placeholder={`Note for ${pendingDraw.kind} at ${Math.round(pendingDraw.x * 100)}%×${Math.round(pendingDraw.y * 100)}%…`}
                  aria-label="Visual annotation note"
                  autoFocus
                />
                <button type="submit" className="hc-btn hc-btn-primary" disabled={!pinNoteDraft.trim()}>
                  Add note
                </button>
                <button type="button" className="hc-btn" onClick={() => setPendingDraw(null)}>
                  Cancel
                </button>
              </form>
            ) : null}

            {draftNotes.length > 0 ? (
              <ul className="hill-inline-note-list">
                {draftNotes.map((n, idx) => (
                  <li key={idx}>
                    <span>
                      <strong>
                        #{idx + 1} ({n.kind} @ {Math.round(n.x * 100)}%,{Math.round(n.y * 100)}%):
                      </strong>{" "}
                      {n.text}
                    </span>
                    <button
                      type="button"
                      className="hc-link"
                      onClick={() => setDraftNotes((cur) => cur.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <input
              className="hc-mini-input"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder="Optional feedback note (included if you Accept or Send back)…"
              aria-label="Design review feedback"
            />

            <div className="hill-inline-actions">
              <button
                type="button"
                className="hc-btn hc-btn-primary"
                disabled={busy !== null}
                onClick={() => void handleFlowDecision("accept_flow_change")}
              >
                {busy === "accept_flow_change" ? "Accepting…" : "Accept design"}
              </button>
              <button
                type="button"
                className="hc-btn"
                disabled={busy !== null}
                onClick={() => void handleFlowDecision("reject_flow_change")}
              >
                {busy === "reject_flow_change"
                  ? "Sending back…"
                  : draftNotes.length > 0
                    ? `Send back (${draftNotes.length} note${draftNotes.length === 1 ? "" : "s"})`
                    : "Send back"}
              </button>
              <span className="hill-inline-hint">
                {canNotifyThread
                  ? "Saves to Flows and replies here so the agent continues."
                  : "Saves directly to Flows."}
              </span>
            </div>
          </>
        ) : (
          <div className="hill-inline-receipt">
            <span>
              {proposalState.state === "accepted"
                ? `Saved "${proposalState.flowName}" as the approved design.`
                : `Sent "${proposalState.flowName}" back for revision.`}
              {proposalState.reviewNote ? ` Note: ${proposalState.reviewNote}` : ""}
              {threadNote ? ` · ${threadNote}` : ""}
            </span>
            {activeFrame ? (
              <details className="hill-inline-details">
                <summary>Preview screen</summary>
                <FrameAnnotator
                  title={activeFrame.title}
                  kind={activeFrame.kind}
                  html={activeFrame.html}
                  imagePath={activeFrame.imagePath}
                  pins={[]}
                  drawTool={null}
                  compact
                  resolveImage={resolveImg}
                />
              </details>
            ) : null}
          </div>
        )}
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // 3. Approved Flow Inspection & Live In-Chat Pinning Card
  // -------------------------------------------------------------------------
  if (decision.kind === "flow_inspect" && flowState) {
    const activeIdx = Math.min(frameCursor, Math.max(0, flowState.frames.length - 1));
    const activeFrame = flowState.frames[activeIdx] ?? null;
    const resolveImg = onResolveImage ? (path: string) => onResolveImage(decision.projectId, path) : undefined;
    const openPins = activeFrame ? activeFrame.pins.filter((p) => !p.resolved) : [];

    const saveNewPin = async () => {
      if (!pendingDraw || !pinNoteDraft.trim() || !activeFrame) return;
      setBusy("pin");
      setError(null);
      try {
        await onAct(decision.projectId, {
          op: "pin",
          name: flowState.name,
          frame: activeIdx,
          x: pendingDraw.x,
          y: pendingDraw.y,
          text: pinNoteDraft.trim(),
          kind: pendingDraw.kind,
          ...(pendingDraw.geometry ? { geometry: pendingDraw.geometry } : {}),
          forAgents: true,
        });
        const refreshed = await onRefreshState(decision.projectId, "flow_inspect", flowState.name);
        if (refreshed.flow) setFlowState(refreshed.flow);
        setPinNoteDraft("");
        setPendingDraw(null);
        setDrawTool(null);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(null);
      }
    };

    return (
      <section className="hill-inline-card hill-inline-design" aria-label={`Visual flow: ${flowState.name}`}>
        <header className="hill-inline-head">
          <div className="hill-inline-title-wrap">
            <span className="hill-inline-pill is-approved">Approved flow</span>
            <strong className="hill-inline-title">
              {flowState.name}
              {activeFrame ? ` · ${activeFrame.title}` : ""}
            </strong>
          </div>
          {activeFrame ? <code className="hill-inline-key">v{activeFrame.version ?? 1} · {activeFrame.key}</code> : null}
        </header>

        {decision.note ? <p className="hill-inline-hint">{decision.note}</p> : null}
        {error ? <p className="hill-inline-error" role="alert">{error}</p> : null}

        {activeFrame ? (
          <>
            <div className="hill-inline-toolbar">
              <div className="cl-seg" role="group" aria-label="Annotation tool">
                <button type="button" className={drawTool === null ? "is-active" : ""} onClick={() => setDrawTool(null)}>
                  View
                </button>
                <button type="button" className={drawTool === "point" ? "is-active" : ""} onClick={() => setDrawTool("point")}>
                  Pin
                </button>
                <button type="button" className={drawTool === "rect" ? "is-active" : ""} onClick={() => setDrawTool("rect")}>
                  Box
                </button>
                <button type="button" className={drawTool === "arrow" ? "is-active" : ""} onClick={() => setDrawTool("arrow")}>
                  Arrow
                </button>
                <button type="button" className={drawTool === "path" ? "is-active" : ""} onClick={() => setDrawTool("path")}>
                  Draw
                </button>
              </div>
              {flowState.frames.length > 1 ? (
                <span className="hill-inline-options">
                  <button
                    type="button"
                    className="hc-btn"
                    disabled={activeIdx <= 0}
                    onClick={() => setFrameCursor((i) => Math.max(0, i - 1))}
                  >
                    ←
                  </button>
                  <span className="hill-inline-hint">
                    {activeIdx + 1}/{flowState.frames.length}
                  </span>
                  <button
                    type="button"
                    className="hc-btn"
                    disabled={activeIdx >= flowState.frames.length - 1}
                    onClick={() => setFrameCursor((i) => Math.min(flowState.frames.length - 1, i + 1))}
                  >
                    →
                  </button>
                </span>
              ) : null}
            </div>

            <FrameAnnotator
              title={activeFrame.title}
              kind={activeFrame.kind}
              html={activeFrame.html}
              imagePath={activeFrame.imagePath}
              pins={activeFrame.pins}
              drawTool={drawTool}
              compact
              onDrawComplete={(drawn) => setPendingDraw(drawn)}
              resolveImage={resolveImg}
            />

            {pendingDraw ? (
              <form
                className="hill-inline-custom"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveNewPin();
                }}
              >
                <input
                  className="hc-mini-input"
                  value={pinNoteDraft}
                  onChange={(e) => setPinNoteDraft(e.target.value)}
                  placeholder="Describe the visual change for the agent…"
                  aria-label="Pin comment"
                  autoFocus
                />
                <button type="submit" className="hc-btn hc-btn-primary" disabled={busy !== null || !pinNoteDraft.trim()}>
                  {busy === "pin" ? "Saving…" : "Save pin"}
                </button>
                <button type="button" className="hc-btn" onClick={() => setPendingDraw(null)}>
                  Cancel
                </button>
              </form>
            ) : null}

            {openPins.length > 0 ? (
              <ul className="hill-inline-note-list">
                {openPins.map((p, idx) => (
                  <li key={p.id ?? idx}>
                    <span>
                      <strong>
                        #{idx + 1} ({p.kind ?? "pin"} @ {Math.round(p.x * 100)}%,{Math.round(p.y * 100)}%):
                      </strong>{" "}
                      {p.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {openPins.length > 0 && canNotifyThread ? (
              <div className="hill-inline-actions">
                <button
                  type="button"
                  className="hc-btn hc-btn-primary"
                  onClick={() => {
                    const summary = formatAnnotationSummary(
                      openPins.map((p) => ({ kind: p.kind ?? "point", x: p.x, y: p.y, text: p.text, geometry: p.geometry })),
                    );
                    void onNotifyThread(
                      `Please update flow "${flowState.name}" (frame "${activeFrame.title}") to address these visual annotations: ${summary}`,
                    ).then((ok) => {
                      if (ok) setThreadNote("Sent annotations to this thread");
                    });
                  }}
                >
                  Send {openPins.length} open pin{openPins.length === 1 ? "" : "s"} to agent
                </button>
                {threadNote ? <span className="hill-inline-hint">{threadNote}</span> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // 4. Contract Change / New Outcome Proposal Card
  // -------------------------------------------------------------------------
  if (decision.kind === "change" && changeState) {
    const isCreate = changeState.kind === "create";
    const pending = changeState.state === "pending";
    const handleDecision = async (op: "approve_change" | "reject_change") => {
      setBusy(op);
      setError(null);
      try {
        await onAct(decision.projectId, { op, id: changeState.id });
        const nextState = op === "approve_change" ? "approved" : "rejected";
        setChangeState({ ...changeState, state: nextState });
        if (canNotifyThread) {
          const msg =
            op === "approve_change"
              ? isCreate
                ? `Approved new Hill Climb outcome "${changeState.proposed.title}" (${changeState.key}). Please continue.`
                : `Approved Hill Climb contract change (${changeState.id}) on "${changeState.key}". Please continue.`
              : isCreate
                ? `Rejected proposed Hill Climb outcome "${changeState.proposed.title}" (${changeState.key}).`
                : `Rejected Hill Climb contract change (${changeState.id}) on "${changeState.key}" — keep the current contract.`;
          const sent = await onNotifyThread(msg);
          if (sent) setThreadNote("Sent decision to this thread");
        }
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(null);
      }
    };

    return (
      <section className="hill-inline-card" aria-label="Hill Climb decision">
        <header className="hill-inline-head">
          <div className="hill-inline-title-wrap">
            <span
              className={`hill-inline-pill ${
                pending
                  ? "is-pending"
                  : changeState.state === "approved"
                    ? "is-approved"
                    : "is-rejected"
              }`}
            >
              {pending
                ? isCreate
                  ? "New outcome proposal"
                  : "Approval needed"
                : changeState.state === "approved"
                  ? "Approved"
                  : "Rejected"}
            </span>
            <strong className="hill-inline-title">{changeState.proposed.title}</strong>
          </div>
          <code className="hill-inline-key">{changeState.key}</code>
        </header>

        {error ? (
          <p className="hill-inline-error" role="alert">
            {error}
          </p>
        ) : null}

        {pending ? (
          <>
            {isCreate ? (
              <div className="hill-inline-body">
                <p className="hill-inline-story">{changeState.proposed.story}</p>
                <ol className="hill-inline-criteria">
                  {changeState.proposed.criteria.map((c) => (
                    <li key={c.id}>
                      <code>{c.id}</code> Given {c.given}, when {c.when}, then {c.then}.
                    </li>
                  ))}
                </ol>
              </div>
            ) : diffRows.length > 0 ? (
              <div className="hill-inline-body">
                <table className="hill-inline-diff">
                  <tbody>
                    {diffRows.map((row) => (
                      <tr key={row.label}>
                        <th>{row.label}</th>
                        <td>
                          {row.before !== null ? <del>{row.before}</del> : null}
                          {row.after !== null ? <ins>{row.after}</ins> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="hill-inline-muted">No semantic difference from the current contract.</p>
            )}

            <div className="hill-inline-actions">
              <button
                type="button"
                className="hc-btn hc-btn-primary"
                disabled={busy !== null}
                onClick={() => void handleDecision("approve_change")}
              >
                {busy === "approve_change" ? "Approving…" : "Approve"}
              </button>
              <button
                type="button"
                className="hc-btn"
                disabled={busy !== null}
                onClick={() => void handleDecision("reject_change")}
              >
                {busy === "reject_change" ? "Rejecting…" : "Reject"}
              </button>
              <span className="hill-inline-hint">
                {canNotifyThread
                  ? "Your choice saves to Hill Climb and replies here automatically."
                  : "Saves directly to Hill Climb."}
              </span>
            </div>
          </>
        ) : (
          <div className="hill-inline-receipt">
            <span>
              {changeState.state === "approved"
                ? isCreate
                  ? `Added "${changeState.proposed.title}" to Goals.`
                  : `Applied proposed edit to ${changeState.key}.`
                : `Kept the previous version of ${changeState.key}.`}
              {threadNote ? ` · ${threadNote}` : ""}
            </span>
            {diffRows.length > 0 ? (
              <details className="hill-inline-details">
                <summary>View diff</summary>
                <table className="hill-inline-diff">
                  <tbody>
                    {diffRows.map((row) => (
                      <tr key={row.label}>
                        <th>{row.label}</th>
                        <td>
                          {row.before !== null ? <del>{row.before}</del> : null}
                          {row.after !== null ? <ins>{row.after}</ins> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}
          </div>
        )}
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // 5. Multiple-Choice Question / Note Card
  // -------------------------------------------------------------------------
  if (decision.kind === "question" && commentState) {
    const answered = commentState.answer !== null;
    const isQuestion = commentState.options.length > 0;

    const submitAnswer = async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setBusy("answer");
      setError(null);
      try {
        await onAct(decision.projectId, { op: "answer", id: commentState.id, answer: trimmed });
        setCommentState({ ...commentState, answer: trimmed });
        setCustomAnswer("");
        if (canNotifyThread) {
          const sent = await onNotifyThread(
            `Answered Hill Climb question on "${commentState.key}": "${trimmed}". Please continue.`,
          );
          if (sent) setThreadNote("Sent answer to this thread");
        }
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(null);
      }
    };

    const submitReply = async () => {
      const trimmed = replyText.trim();
      if (!trimmed) return;
      setBusy("reply");
      setError(null);
      try {
        await onAct(decision.projectId, {
          op: "comment",
          key: commentState.key,
          text: trimmed,
          options: [],
          parentId: commentState.id,
        });
        setReplyText("");
        setReplyOpen(false);
        setThreadNote("Reply saved to Hill Climb");
        if (canNotifyThread) {
          await onNotifyThread(`Replied on Hill Climb outcome "${commentState.key}": "${trimmed}".`);
        }
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(null);
      }
    };

    return (
      <section className="hill-inline-card" aria-label="Hill Climb question">
        <header className="hill-inline-head">
          <div className="hill-inline-title-wrap">
            <span className={`hill-inline-pill ${answered ? "is-approved" : isQuestion ? "is-pending" : "is-neutral"}`}>
              {answered ? "Answered" : isQuestion ? "Decision needed" : "Note"}
            </span>
            <strong className="hill-inline-title">{decision.outcomeTitle}</strong>
          </div>
          <code className="hill-inline-key">{commentState.key}</code>
        </header>

        <p className="hill-inline-question">{commentState.text}</p>

        {error ? (
          <p className="hill-inline-error" role="alert">
            {error}
          </p>
        ) : null}

        {answered ? (
          <div className="hill-inline-receipt">
            <span>
              <strong>Answer:</strong> {commentState.answer}
              {threadNote ? ` · ${threadNote}` : ""}
            </span>
          </div>
        ) : isQuestion ? (
          <div className="hill-inline-body">
            <div className="hill-inline-options" role="group" aria-label="Choose an answer">
              {commentState.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className="hc-btn"
                  disabled={busy !== null}
                  onClick={() => void submitAnswer(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
            <form
              className="hill-inline-custom"
              onSubmit={(e) => {
                e.preventDefault();
                void submitAnswer(customAnswer);
              }}
            >
              <input
                className="hc-mini-input"
                value={customAnswer}
                onChange={(e) => setCustomAnswer(e.target.value)}
                placeholder="Or answer in your own words…"
                aria-label="Custom answer"
              />
              <button type="submit" className="hc-btn hc-btn-primary" disabled={busy !== null || !customAnswer.trim()}>
                {busy === "answer" ? "Saving…" : "Send"}
              </button>
            </form>
          </div>
        ) : (
          <div className="hill-inline-actions">
            {replyOpen ? (
              <form
                className="hill-inline-custom"
                style={{ width: "100%" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitReply();
                }}
              >
                <input
                  className="hc-mini-input"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Write a reply…"
                  aria-label="Reply"
                  autoFocus
                />
                <button type="submit" className="hc-btn hc-btn-primary" disabled={busy !== null || !replyText.trim()}>
                  {busy === "reply" ? "Sending…" : "Reply"}
                </button>
                <button type="button" className="hc-btn" onClick={() => setReplyOpen(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <button type="button" className="hc-btn" onClick={() => setReplyOpen(true)}>
                  Reply
                </button>
                {threadNote ? <span className="hill-inline-hint">{threadNote}</span> : null}
              </>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="hill-inline-card">
      <p className="hill-inline-muted">Decision state unavailable.</p>
    </section>
  );
}
