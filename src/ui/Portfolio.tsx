// Portfolio — the Inbox, Roadmap and Flows surfaces.
//
// Rendering only. Every mutation goes through `act`; the readiness and
// comparison readings here come from the snapshot and are advisory. Approval,
// promotion and release policy lives on the server, which validates versions
// and evidence at the moment it writes.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { Action } from "../actions.js";
import type {
  Change,
  Comment,
  Contract,
  Criterion,
  Flow,
  FlowProposal,
  Outcome,
  Pin,
  PinKind,
  Release,
  Signal,
  Snapshot,
} from "../model.js";

export interface PromotionPreviewRow {
  key: string;
  ready: boolean;
  from: string;
  to: string;
}

export interface PortfolioProps {
  page: "inbox" | "roadmap" | "flows";
  data: Snapshot;
  act: (a: Action) => Promise<void>;
  select: (key: string | null) => void;
  chooseTrack: (t: string) => void;
  track: string;
  preview: (name: string, keys: string[]) => Promise<PromotionPreviewRow[]>;
  initialFlow?: string | null;
  onFocusScopeFromRelease?: (release: Release) => Promise<void>;
  otherPendingProjects?: Array<{ id: string; name: string; count: number }>;
  onSelectProject?: (projectId: string) => void;
}

type Run = (label: string, action: () => Promise<void>, done?: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Readings over the snapshot
// ---------------------------------------------------------------------------

export interface SignalInfo {
  label: string;
  tone: "ready" | "warn" | "bad" | "info";
  ready: boolean;
  note: string;
}

const SIGNAL_INFO: Record<Signal, SignalInfo> = {
  verified: {
    label: "verified",
    tone: "ready",
    ready: true,
    note: "evidence confirms the current contract version",
  },
  unverified: {
    label: "unverified",
    tone: "warn",
    ready: false,
    note: "no confirming evidence at the current contract version",
  },
  broken: {
    label: "broken",
    tone: "bad",
    ready: false,
    note: "evidence denies the current contract",
  },
  stale: {
    label: "stale",
    tone: "warn",
    ready: false,
    note: "evidence predates the current contract version",
  },
  recheck: {
    label: "recheck",
    tone: "info",
    ready: false,
    note: "verification expired; run the check again",
  },
};

export function signalInfo(signal: Signal | null): SignalInfo {
  return signal === null
    ? { label: "not ranked", tone: "info", ready: false, note: "no ranked entry in this track" }
    : SIGNAL_INFO[signal];
}

export interface ReadinessRow {
  key: string;
  title: string;
  signal: Signal | null;
  ready: boolean;
  reason: string;
}

export function releaseReadiness(data: Snapshot, release: Release): ReadinessRow[] {
  const ranked = new Map(data.ranked.map((row) => [row.key, row]));
  const outcomes = new Map(data.outcomes.map((outcome) => [outcome.key, outcome]));
  return release.keys.map((key) => {
    const outcome = outcomes.get(key);
    const signal = ranked.get(key)?.signal ?? null;
    const info = signalInfo(signal);
    return {
      key,
      title: outcome?.title ?? key,
      signal,
      ready: info.ready,
      reason: outcome === undefined ? "no outcome with this key in the tree" : info.note,
    };
  });
}

export function readinessCounts(rows: ReadinessRow[]): { ready: number; total: number } {
  return { ready: rows.filter((row) => row.ready).length, total: rows.length };
}

export type ScenarioChange = "added" | "removed" | "ready" | "not-ready";

export interface ScenarioDelta {
  key: string;
  title: string;
  a: ReadinessRow | null;
  b: ReadinessRow | null;
  change: ScenarioChange;
}

export interface ScenarioComparison {
  rows: ScenarioDelta[];
  readyA: number;
  readyB: number;
  onlyA: number;
  onlyB: number;
  shared: number;
}

/**
 * Releases in one snapshot share one signal per key, so a comparison can only
 * report scope (what each scenario includes) and whether the shared keys are
 * ready. It deliberately does not claim a per-scenario verification change.
 */
export function compareScenarios(data: Snapshot, a: Release, b: Release): ScenarioComparison {
  const rowsA = new Map(releaseReadiness(data, a).map((row) => [row.key, row]));
  const rowsB = new Map(releaseReadiness(data, b).map((row) => [row.key, row]));
  const keys: string[] = [];
  for (const key of a.keys) if (!keys.includes(key)) keys.push(key);
  for (const key of b.keys) if (!keys.includes(key)) keys.push(key);
  const rows: ScenarioDelta[] = keys.map((key) => {
    const left = rowsA.get(key) ?? null;
    const right = rowsB.get(key) ?? null;
    let change: ScenarioChange;
    if (left === null) change = "added";
    else if (right === null) change = "removed";
    else change = right.ready ? "ready" : "not-ready";
    return { key, title: right?.title ?? left?.title ?? key, a: left, b: right, change };
  });
  return {
    rows,
    readyA: rows.filter((row) => row.a?.ready === true).length,
    readyB: rows.filter((row) => row.b?.ready === true).length,
    onlyA: rows.filter((row) => row.b === null).length,
    onlyB: rows.filter((row) => row.a === null).length,
    shared: rows.filter((row) => row.a !== null && row.b !== null).length,
  };
}

export interface FieldDiff {
  field: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface ContractDiff {
  fields: FieldDiff[];
  added: Criterion[];
  removed: Criterion[];
  changed: Array<{ id: string; fields: FieldDiff[] }>;
  changedAny: boolean;
}

function listText(keys: string[]): string {
  return keys.length === 0 ? "none" : keys.join(", ");
}

export function contractDiff(base: Contract | null, next: Contract): ContractDiff {
  const fields: FieldDiff[] = [];
  const push = (field: string, before: string, after: string): void => {
    fields.push({ field, before, after, changed: before !== after });
  };
  if (base !== null) {
    push("title", base.title, next.title);
    push("story", base.story, next.story);
    push("rank", String(base.rank), String(next.rank));
    push("recheck days", base.recheckDays === null ? "none" : String(base.recheckDays), next.recheckDays === null ? "none" : String(next.recheckDays));
    push("depends on", listText(base.dependsOn), listText(next.dependsOn));
  }

  const before = new Map((base?.criteria ?? []).map((criterion) => [criterion.id, criterion]));
  const after = new Map(next.criteria.map((criterion) => [criterion.id, criterion]));
  const added: Criterion[] = [];
  const changed: Array<{ id: string; fields: FieldDiff[] }> = [];
  for (const criterion of next.criteria) {
    const prior = before.get(criterion.id);
    if (prior === undefined) {
      added.push(criterion);
      continue;
    }
    const criterionFields: FieldDiff[] = [];
    for (const field of ["given", "when", "then"] as const) {
      if (prior[field] !== criterion[field]) {
        criterionFields.push({ field, before: prior[field], after: criterion[field], changed: true });
      }
    }
    if (criterionFields.length > 0) changed.push({ id: criterion.id, fields: criterionFields });
  }
  const removed = (base?.criteria ?? []).filter((criterion) => after.get(criterion.id) === undefined);

  return {
    fields,
    added,
    removed,
    changed,
    changedAny:
      base === null || fields.some((field) => field.changed) || added.length > 0 || removed.length > 0 || changed.length > 0,
  };
}

export interface QuestionThread {
  root: Comment;
  replies: Comment[];
  open: boolean;
  optionCount: number;
}

function byCreated(a: Comment, b: Comment): number {
  return a.created.localeCompare(b.created);
}

export function questionThreads(data: Snapshot, key?: string): QuestionThread[] {
  const relevant = key === undefined ? data.comments : data.comments.filter((comment) => comment.key === key);
  const roots = relevant.filter((comment) => comment.parentId === null);
  const replies = new Map<string, Comment[]>();
  for (const comment of relevant) {
    if (comment.parentId === null) continue;
    const list = replies.get(comment.parentId);
    if (list === undefined) replies.set(comment.parentId, [comment]);
    else list.push(comment);
  }
  const threads = roots.map((root) => {
    const children = (replies.get(root.id) ?? []).slice().sort(byCreated);
    const all = [root, ...children];
    return {
      root,
      replies: children,
      open: all.some((comment) => comment.answer === null),
      optionCount: all.reduce((total, comment) => total + comment.options.length, 0),
    };
  });
  return threads.sort((a, b) => Number(b.open) - Number(a.open) || b.root.created.localeCompare(a.root.created));
}

export function inboxCounts(data: Snapshot): { changes: number; questions: number; flowProposals: number } {
  return {
    changes: data.changes.filter((change) => change.state === "pending").length,
    questions: data.comments.filter((comment) => comment.answer === null).length,
    flowProposals: (data.flowProposals ?? []).filter((proposal) => proposal.state === "pending").length,
  };
}

export function criterionFor(data: Snapshot, key: string, criterionId: string): Criterion | null {
  const outcome = data.outcomes.find((candidate) => candidate.key === key);
  return outcome?.criteria.find((criterion) => criterion.id === criterionId) ?? null;
}

// ---------------------------------------------------------------------------
// Frame isolation and pins
// ---------------------------------------------------------------------------

/** No sandbox tokens: scripts, forms, popups, top navigation and same-origin are all off. */
export const FRAME_SANDBOX = "";

const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * Defence in depth behind the sandbox attribute: drop script elements and the
 * two elements that can navigate or reload the frame, then pin a CSP that
 * forbids scripts and network access. The sandbox is still the guarantee.
 */
export function isolateHtml(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  return `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${stripped}`;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Normalized (0..1) point for a click inside `box`; pins store this, not pixels. */
export function normalizePoint(box: Box, clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: round4(box.width === 0 ? 0 : clamp01((clientX - box.left) / box.width)),
    y: round4(box.height === 0 ? 0 : clamp01((clientY - box.top) / box.height)),
  };
}

export function pinPosition(pin: Pin): { left: string; top: string } {
  return {
    left: `${(clamp01(pin.x) * 100).toFixed(2)}%`,
    top: `${(clamp01(pin.y) * 100).toFixed(2)}%`,
  };
}

/** A stable hue per criterion, so the same criterion reads the same colour on every frame. */
export function criterionHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

export interface PinnedGroup {
  criterionId: string;
  key: string;
  criterion: Criterion | null;
  pins: Array<{ frame: number; frameTitle: string; pin: Pin }>;
}

export function pinsByCriterion(flow: Flow, data: Snapshot): PinnedGroup[] {
  const groups = new Map<string, PinnedGroup>();
  flow.frames.forEach((frame, index) => {
    for (const pin of frame.pins) {
      const group = groups.get(frame.criterionId) ?? {
        criterionId: frame.criterionId,
        key: frame.key,
        criterion: criterionFor(data, frame.key, frame.criterionId),
        pins: [],
      };
      group.pins.push({ frame: index, frameTitle: frame.title, pin });
      groups.set(frame.criterionId, group);
    }
  });
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useAction(act: PortfolioProps["act"]): {
  busy: string | null;
  error: string | null;
  notice: string | null;
  run: Run;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run: Run = async (label, action, done) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done !== undefined) setNotice(done);
      return true;
    } catch (failure) {
      setError(messageOf(failure));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, notice, run };
}

function SignalBadge({ signal }: { signal: Signal | null }): ReactNode {
  const info = signalInfo(signal);
  return (
    <span className={`pf-badge pf-tone-${info.tone}`} title={info.note}>
      {info.label}
    </span>
  );
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }): ReactNode {
  if (error === null && notice === null) return null;
  return (
    <div className="pf-feedback" aria-live="polite">
      {error !== null && (
        <p className="pf-error" role="alert">
          {error}
        </p>
      )}
      {notice !== null && <p className="pf-notice">{notice}</p>}
    </div>
  );
}

function Empty({ title, body, children }: { title: string; body: string; children?: ReactNode }): ReactNode {
  return (
    <div className="pf-empty">
      <p className="pf-empty-title">{title}</p>
      <p className="pf-muted">{body}</p>
      {children !== undefined && <div className="pf-actions">{children}</div>}
    </div>
  );
}

function TrackChips({ data, track, chooseTrack }: { data: Snapshot; track: string; chooseTrack: (t: string) => void }): ReactNode {
  if (data.tracks.length <= 1) return null;
  return (
    <div className="pf-tracks" role="group" aria-label="Track">
      <span className="pf-label">Track</span>
      {data.tracks.map((entry) => (
        <button
          key={entry.name}
          type="button"
          className={`pf-chip${entry.name === track ? " is-active" : ""}`}
          aria-pressed={entry.name === track}
          title={entry.description}
          onClick={() => chooseTrack(entry.name)}
        >
          {entry.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

function AnswerForm({ comment, act, run, busy }: { comment: Comment; act: PortfolioProps["act"]; run: Run; busy: string | null }): ReactNode {
  const [text, setText] = useState("");
  const inputId = useId();
  if (comment.answer !== null) {
    return <p className="pf-answer">Answer: {comment.answer}</p>;
  }
  const answer = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    await run(`answer:${comment.id}`, async () => {
      await act({ op: "answer", id: comment.id, answer: trimmed });
    }, "Answer recorded.");
  };
  return (
    <form
      className="pf-answer-form"
      onSubmit={(event) => {
        event.preventDefault();
        void answer(text);
      }}
    >
      {comment.options.length > 0 && (
        <div className="pf-options">
          {comment.options.map((option) => (
            <button
              key={option}
              type="button"
              className="pf-btn pf-btn-ghost"
              disabled={busy !== null}
              onClick={() => void answer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="pf-row">
        <label className="pf-sr" htmlFor={inputId}>
          Answer
        </label>
        <input
          id={inputId}
          className="pf-input"
          value={text}
          placeholder={comment.options.length > 0 ? "Or write a different answer…" : "Write an answer…"}
          onChange={(event) => setText(event.target.value)}
        />
        <button className="pf-btn" type="submit" disabled={busy !== null || text.trim() === ""}>
          Answer
        </button>
      </div>
    </form>
  );
}

function ChangeCard({
  change,
  outcome,
  act,
  run,
  busy,
  select,
}: {
  change: Change;
  outcome: Outcome | undefined;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  select: (key: string | null) => void;
}): ReactNode {
  const diff = contractDiff(outcome ?? null, change.proposed);
  const isCreate = change.kind === "create";
  const moved = !isCreate && outcome !== undefined && outcome.version !== change.baseVersion;
  const decided = change.state !== "pending";
  return (
    <article className="pf-card">
      <header className="pf-card-head">
        <div>
          <h3 className="pf-card-title">
            {isCreate ? <span className="pf-badge pf-tone-info" style={{ marginRight: 6 }}>New outcome</span> : null}
            {change.proposed.title}
          </h3>
          <p className="pf-muted pf-small">
            {isCreate ? (
              <>
                <code>{change.key}</code>
                {change.goalKey ? ` · under goal ${change.goalKey}` : ""}
              </>
            ) : (
              <>
                <button type="button" className="pf-link" onClick={() => select(change.key)}>
                  {change.key}
                </button>
                {outcome === undefined ? " · outcome not in this tree" : ` · now v${outcome.version}`} · proposed against v
                {change.baseVersion}
              </>
            )}
            {change.actor ? ` · by ${change.actor}` : ""}
          </p>
        </div>
        <span className={`pf-pill${decided ? "" : " is-open"}`}>{decided ? change.state : "pending"}</span>
      </header>

      {moved && (
        <p className="pf-hint">
          The outcome advanced to v{outcome?.version} after this proposal. The diff below is against that current contract. The
          server decides whether this base version still applies; approve only if the change still makes sense on the current
          contract.
        </p>
      )}

      {isCreate ? (
        <>
          <p className="pf-small">{change.proposed.story}</p>
          <ContractDiffView diff={diff} base={null} next={change.proposed} />
        </>
      ) : outcome === undefined ? (
        <>
          <p className="pf-hint">There is no outcome with this key in the current tree. The proposal is shown as written.</p>
          <ContractDiffView diff={diff} base={null} next={change.proposed} />
        </>
      ) : (
        <ContractDiffView diff={diff} base={outcome} next={change.proposed} />
      )}

      {!decided && (
        <div className="pf-actions">
          <button
            type="button"
            className="pf-btn pf-btn-primary"
            disabled={busy !== null}
            onClick={() => {
              void run(`approve:${change.id}`, async () => {
                await act({ op: "approve_change", id: change.id });
              }, `Approved ${change.proposed.title}.`);
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="pf-btn pf-btn-danger"
            disabled={busy !== null}
            onClick={() => {
              void run(`reject:${change.id}`, async () => {
                await act({ op: "reject_change", id: change.id });
              }, `Rejected ${change.proposed.title}.`);
            }}
          >
            Reject
          </button>
        </div>
      )}
    </article>
  );
}

function ContractDiffView({ diff, base, next }: { diff: ContractDiff; base: Contract | null; next: Contract }): ReactNode {
  return (
    <div className="pf-diff">
      {base !== null && (
        <table className="pf-diff-table">
          <caption className="pf-sr">Proposed contract changes</caption>
          <tbody>
            {diff.fields.map((field) => (
              <tr key={field.field} className={field.changed ? "is-changed" : ""}>
                <th scope="row">{field.field}</th>
                <td className="pf-diff-before">{field.changed ? field.before : ""}</td>
                <td className="pf-diff-after">{field.changed ? field.after : field.before}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {diff.added.length > 0 && (
        <div className="pf-criteria">
          <p className="pf-label">Added criteria</p>
          {diff.added.map((criterion) => (
            <p key={criterion.id} className="pf-criterion">
              <span className="pf-criterion-id">{criterion.id}</span> Given {criterion.given}, when {criterion.when}, then{" "}
              {criterion.then}.
            </p>
          ))}
        </div>
      )}

      {diff.changed.length > 0 && (
        <div className="pf-criteria">
          <p className="pf-label">Changed criteria</p>
          {diff.changed.map((entry) => (
            <div key={entry.id} className="pf-criterion">
              <span className="pf-criterion-id">{entry.id}</span>
              {entry.fields.map((field) => (
                <p key={field.field} className="pf-small">
                  <span className="pf-muted">{field.field}:</span> <del>{field.before}</del> <ins>{field.after}</ins>
                </p>
              ))}
            </div>
          ))}
        </div>
      )}

      {diff.removed.length > 0 && (
        <div className="pf-criteria">
          <p className="pf-label">Removed criteria</p>
          {diff.removed.map((criterion) => (
            <p key={criterion.id} className="pf-criterion pf-muted">
              <span className="pf-criterion-id">{criterion.id}</span> Given {criterion.given}, when {criterion.when}, then{" "}
              {criterion.then}.
            </p>
          ))}
        </div>
      )}

      {base === null && (
        <p className="pf-muted pf-small">
          {next.criteria.length} criteria · rank {next.rank} · depends on {listText(next.dependsOn)}
        </p>
      )}
      {!diff.changedAny && <p className="pf-muted pf-small">No semantic change: the proposal matches the current contract.</p>}
    </div>
  );
}

function Message({ comment, act, run, busy }: { comment: Comment; act: PortfolioProps["act"]; run: Run; busy: string | null }): ReactNode {
  return (
    <div className="pf-message">
      <p className="pf-message-text">{comment.text}</p>
      <AnswerForm comment={comment} act={act} run={run} busy={busy} />
      <p className="pf-muted pf-small">{new Date(comment.created).toLocaleString()}</p>
    </div>
  );
}

function ThreadCard({
  thread,
  outcome,
  act,
  run,
  busy,
  select,
}: {
  thread: QuestionThread;
  outcome: Outcome | undefined;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  select: (key: string | null) => void;
}): ReactNode {
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const replyId = useId();
  return (
    <article className="pf-card pf-thread">
      <header className="pf-card-head">
        <div>
          <button type="button" className="pf-link pf-card-title" onClick={() => select(thread.root.key)}>
            {outcome?.title ?? thread.root.key}
          </button>
          <p className="pf-muted pf-small">
            {thread.root.key} · {thread.root.options.length > 0 ? "structured question" : "question"}
          </p>
        </div>
        <span className={`pf-pill${thread.open ? " is-open" : ""}`}>{thread.open ? "open" : "answered"}</span>
      </header>

      <Message comment={thread.root} act={act} run={run} busy={busy} />
      {thread.replies.map((child) => (
        <div key={child.id} className="pf-reply">
          <Message comment={child} act={act} run={run} busy={busy} />
        </div>
      ))}

      {replying ? (
        <form
          className="pf-row"
          onSubmit={(event) => {
            event.preventDefault();
            const text = reply.trim();
            if (text === "") return;
            void run(`reply:${thread.root.id}`, async () => {
              await act({ op: "comment", key: thread.root.key, text, options: [], parentId: thread.root.id });
            }, "Reply added.").then((ok) => {
              if (ok) {
                setReply("");
                setReplying(false);
              }
            });
          }}
        >
          <label className="pf-sr" htmlFor={replyId}>
            Reply
          </label>
          <input
            id={replyId}
            className="pf-input"
            value={reply}
            placeholder="Reply in this thread…"
            onChange={(event) => setReply(event.target.value)}
          />
          <button type="submit" className="pf-btn" disabled={busy !== null || reply.trim() === ""}>
            Send
          </button>
          <button type="button" className="pf-btn pf-btn-ghost" onClick={() => setReplying(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="pf-link pf-small" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
    </article>
  );
}

function FlowProposalCard({
  proposal,
  currentFlow,
  act,
  run,
  busy,
}: {
  proposal: FlowProposal;
  currentFlow: Flow | undefined;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
}): ReactNode {
  const [reviewNote, setReviewNote] = useState("");
  const currentFrame =
    proposal.kind === "change" && proposal.frameIndex !== null
      ? currentFlow?.frames[proposal.frameIndex] ?? null
      : null;
  const proposedFrames = proposal.kind === "new_flow" ? (proposal.frames ?? []) : proposal.frame ? [proposal.frame] : [];
  const decided = proposal.state !== "pending";

  return (
    <article className="pf-card">
      <header className="pf-card-head">
        <div>
          <h3 className="pf-card-title">
            <span className="pf-badge pf-tone-info" style={{ marginRight: 6 }}>
              {proposal.kind === "new_flow" ? "New flow" : proposal.kind === "new_step" ? "New frame" : "Frame update"}
            </span>
            {proposal.flowName}
            {proposal.frameIndex !== null ? ` · frame #${proposal.frameIndex + 1}` : ""}
          </h3>
          <p className="pf-muted pf-small">
            <code>{proposal.id}</code>
            {proposal.basedOnVersion !== null ? ` · based on v${proposal.basedOnVersion}` : ""}
            {proposal.selfGrade ? ` · self-grade: ${proposal.selfGrade}` : ""}
            {proposal.ref ? ` · ref: ${proposal.ref}` : ""}
            {proposal.actor ? ` · by ${proposal.actor}` : ""}
          </p>
        </div>
        <span className={`pf-pill${decided ? "" : " is-open"}`}>{proposal.state}</span>
      </header>

      {proposal.note ? <p className="pf-small">{proposal.note}</p> : null}

      {currentFrame && proposedFrames[0] ? (
        <div className="pf-compare-frames">
          <div>
            <p className="pf-label">Current approved (v{currentFrame.version ?? 1})</p>
            <div className="pf-frame-canvas pf-frame-canvas-sm">
              {currentFrame.kind === "image" && currentFrame.imagePath ? (
                <img src={currentFrame.imagePath} alt={currentFrame.title} className="pf-frame-img" />
              ) : (
                <iframe
                  title={`Current ${currentFrame.title}`}
                  sandbox={FRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  srcDoc={isolateHtml(currentFrame.html)}
                />
              )}
            </div>
          </div>
          <div>
            <p className="pf-label">Proposed update</p>
            <div className="pf-frame-canvas pf-frame-canvas-sm">
              {proposedFrames[0].kind === "image" && proposedFrames[0].imagePath ? (
                <img src={proposedFrames[0].imagePath} alt={proposedFrames[0].title} className="pf-frame-img" />
              ) : (
                <iframe
                  title={`Proposed ${proposedFrames[0].title}`}
                  sandbox={FRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  srcDoc={isolateHtml(proposedFrames[0].html)}
                />
              )}
            </div>
          </div>
        </div>
      ) : proposedFrames[0] ? (
        <div>
          <p className="pf-label">
            Proposed preview ({proposedFrames.length} frame{proposedFrames.length === 1 ? "" : "s"} — {proposedFrames[0].title})
          </p>
          <div className="pf-frame-canvas pf-frame-canvas-sm">
            {proposedFrames[0].kind === "image" && proposedFrames[0].imagePath ? (
              <img src={proposedFrames[0].imagePath} alt={proposedFrames[0].title} className="pf-frame-img" />
            ) : (
              <iframe
                title={`Proposed ${proposedFrames[0].title}`}
                sandbox={FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                loading="lazy"
                srcDoc={isolateHtml(proposedFrames[0].html)}
              />
            )}
          </div>
        </div>
      ) : null}

      {proposal.reviewNote ? <p className="pf-hint">Review note: {proposal.reviewNote}</p> : null}

      {!decided ? (
        <div className="pf-stack">
          <input
            className="pf-input"
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            placeholder="Optional review note (shown if accepted or sent back)…"
            aria-label="Flow proposal review note"
          />
          <div className="pf-actions">
            <button
              type="button"
              className="pf-btn pf-btn-primary"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  `accept-flow:${proposal.id}`,
                  async () => {
                    await act({
                      op: "accept_flow_change",
                      id: proposal.id,
                      ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
                    });
                  },
                  `Accepted flow proposal ${proposal.id}.`,
                )
              }
            >
              Accept
            </button>
            <button
              type="button"
              className="pf-btn pf-btn-danger"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  `reject-flow:${proposal.id}`,
                  async () => {
                    await act({
                      op: "reject_flow_change",
                      id: proposal.id,
                      ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
                    });
                  },
                  `Sent back flow proposal ${proposal.id}.`,
                )
              }
            >
              Send back
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Inbox({
  data,
  act,
  run,
  busy,
  select,
  otherPendingProjects,
  onSelectProject,
}: {
  data: Snapshot;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  select: (key: string | null) => void;
  otherPendingProjects?: Array<{ id: string; name: string; count: number }>;
  onSelectProject?: (projectId: string) => void;
}): ReactNode {
  const changes = useMemo(
    () => data.changes.filter((change) => change.state === "pending").sort((a, b) => b.created.localeCompare(a.created)),
    [data.changes],
  );
  const decided = useMemo(
    () => data.changes.filter((change) => change.state !== "pending").sort((a, b) => b.created.localeCompare(a.created)),
    [data.changes],
  );
  const pendingFlowProposals = useMemo(
    () =>
      (data.flowProposals ?? [])
        .filter((p) => p.state === "pending")
        .sort((a, b) => b.created.localeCompare(a.created)),
    [data.flowProposals],
  );
  const threads = useMemo(() => questionThreads(data), [data]);
  const open = threads.filter((thread) => thread.open);
  const answered = threads.filter((thread) => !thread.open);
  const outcomes = useMemo(() => new Map(data.outcomes.map((outcome) => [outcome.key, outcome])), [data.outcomes]);
  const flowsByName = useMemo(() => new Map(data.flows.map((f) => [f.name, f])), [data.flows]);
  const [showDecided, setShowDecided] = useState(false);

  // Keyboard shortcuts when not focused in a form input:
  // 1-9 answer the first open multiple-choice question; a/r approve/reject top pending change
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || busy !== null) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const idx = Number(event.key) - 1;
        const firstQuestion = open
          .flatMap((t) => [t.root, ...t.replies])
          .find((c) => c.answer === null && c.options.length > idx);
        const choice = firstQuestion?.options[idx];
        if (firstQuestion && choice) {
          event.preventDefault();
          void run(`answer:${firstQuestion.id}`, async () => {
            await act({ op: "answer", id: firstQuestion.id, answer: choice });
          }, `Answered "${choice}".`);
        }
      } else if (event.key === "a" && changes[0]) {
        event.preventDefault();
        const top = changes[0];
        void run(`approve:${top.id}`, async () => {
          await act({ op: "approve_change", id: top.id });
        }, `Approved ${top.proposed.title}.`);
      } else if (event.key === "r" && changes[0]) {
        event.preventDefault();
        const top = changes[0];
        void run(`reject:${top.id}`, async () => {
          await act({ op: "reject_change", id: top.id });
        }, `Rejected ${top.proposed.title}.`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, busy, changes, open, run]);

  return (
    <>
      {changes.length === 0 && open.length === 0 && pendingFlowProposals.length === 0 ? (
        <Empty
          title="Nothing needs your decision in this project."
          body="Proposed contract edits, visual flow updates, and agent questions for this project appear here (and inline in chat) for your approval."
        >
          {otherPendingProjects && otherPendingProjects.length > 0 && onSelectProject ? (
            otherPendingProjects.map((other) => (
              <button
                key={other.id}
                type="button"
                className="pf-btn pf-btn-primary"
                onClick={() => onSelectProject(other.id)}
              >
                Review {other.count} pending in {other.name} →
              </button>
            ))
          ) : null}
          {data.next[0] !== undefined && (
            <button type="button" className="pf-btn" onClick={() => select(data.next[0] ?? null)}>
              Inspect next outcome: {data.next[0]}
            </button>
          )}
        </Empty>
      ) : (
        <>
          <p className="pf-muted pf-small">
            Shortcuts: <code>1</code>–<code>9</code> answer top question · <code>a</code> approve · <code>r</code> reject
          </p>
          {changes.length > 0 && (
            <section className="pf-section" aria-labelledby="pf-changes-title">
              <h3 className="pf-section-title" id="pf-changes-title">
                Proposed edits <span className="pf-count">{changes.length}</span>
              </h3>
              <div className="pf-stack">
                {changes.map((change) => (
                  <ChangeCard
                    key={change.id}
                    change={change}
                    outcome={outcomes.get(change.key)}
                    act={act}
                    run={run}
                    busy={busy}
                    select={select}
                  />
                ))}
              </div>
            </section>
          )}

          {pendingFlowProposals.length > 0 && (
            <section className="pf-section" aria-labelledby="pf-flow-proposals-title">
              <h3 className="pf-section-title" id="pf-flow-proposals-title">
                Visual flow proposals <span className="pf-count">{pendingFlowProposals.length}</span>
              </h3>
              <div className="pf-stack">
                {pendingFlowProposals.map((proposal) => (
                  <FlowProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    currentFlow={flowsByName.get(proposal.flowName)}
                    act={act}
                    run={run}
                    busy={busy}
                  />
                ))}
              </div>
            </section>
          )}

          {open.length > 0 && (
            <section className="pf-section" aria-labelledby="pf-questions-title">
              <h3 className="pf-section-title" id="pf-questions-title">
                Questions <span className="pf-count">{open.length}</span>
              </h3>
              <div className="pf-stack">
                {open.map((thread) => (
                  <ThreadCard
                    key={thread.root.id}
                    thread={thread}
                    outcome={outcomes.get(thread.root.key)}
                    act={act}
                    run={run}
                    busy={busy}
                    select={select}
                  />
                ))}
              </div>
            </section>
          )}

          {answered.length > 0 && (
            <details className="pf-disclosure" open={showDecided} onToggle={(event) => setShowDecided(event.currentTarget.open)}>
              <summary>Answered threads ({answered.length})</summary>
              <div className="pf-stack">
                {answered.map((thread) => (
                  <ThreadCard
                    key={thread.root.id}
                    thread={thread}
                    outcome={outcomes.get(thread.root.key)}
                    act={act}
                    run={run}
                    busy={busy}
                    select={select}
                  />
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {decided.length > 0 && (
        <details className="pf-disclosure">
          <summary>Decided contract changes ({decided.length})</summary>
          <div className="pf-stack">
            {decided.map((change) => (
              <ChangeCard
                key={change.id}
                change={change}
                outcome={outcomes.get(change.key)}
                act={act}
                run={run}
                busy={busy}
                select={select}
              />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

function ProgressRing({ percent }: { percent: number }): ReactNode {
  const r = 16;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.max(0, Math.min(100, percent)) / 100) * c;
  return (
    <svg className="pf-ring" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <circle className="pf-ring-bg" cx="20" cy="20" r={r} />
      <circle
        className="pf-ring-fill"
        cx="20"
        cy="20"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 20 20)"
      />
      <text x="20" y="24" textAnchor="middle" className="pf-ring-text">
        {percent}%
      </text>
    </svg>
  );
}

function Roadmap({
  data,
  act,
  run,
  busy,
  preview,
  track,
  chooseTrack,
  select,
  onFocusScopeFromRelease,
}: {
  data: Snapshot;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  preview: PortfolioProps["preview"];
  track: string;
  chooseTrack: (t: string) => void;
  select: (key: string | null) => void;
  onFocusScopeFromRelease?: (release: Release) => Promise<void>;
}): ReactNode {
  const outcomes = useMemo(() => new Map(data.outcomes.map((outcome) => [outcome.key, outcome])), [data.outcomes]);
  const ranked = data.ranked.filter((row) => outcomes.has(row.key));
  const [picked, setPicked] = useState<string[]>([]);
  const [newTrack, setNewTrack] = useState("");
  const [description, setDescription] = useState("");
  const [previewState, setPreviewState] = useState<{ signature: string; rows: PromotionPreviewRow[] } | null>(null);
  const [releaseName, setReleaseName] = useState("");
  const [releaseDate, setReleaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [releaseScenario, setReleaseScenario] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editingReleaseId, setEditingReleaseId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editKeys, setEditKeys] = useState<string[]>([]);
  const [compareAId, setCompareAId] = useState<string | null>(null);
  const [compareBId, setCompareBId] = useState<string | null>(null);

  const selected = new Set(picked);
  const signature = `${newTrack.trim()}\u0000${picked.join(",")}`;
  const currentPreview = previewState !== null && previewState.signature === signature ? previewState.rows : null;

  const releases = useMemo(
    () => data.releases.map((release) => ({ release })).sort((a, b) => (b.release.date || "").localeCompare(a.release.date || "")),
    [data.releases],
  );
  const releaseIds = releases.map(({ release }) => `${release.name}\u0000${release.scenario}\u0000${release.date}`);
  const resolvedAId = compareAId !== null && releaseIds.includes(compareAId) ? compareAId : (releaseIds[0] ?? "");
  const resolvedBId = compareBId !== null && releaseIds.includes(compareBId) ? compareBId : (releaseIds[1] ?? "");
  const releaseA = releases[releaseIds.indexOf(resolvedAId)]?.release;
  const releaseB = releases[releaseIds.indexOf(resolvedBId)]?.release;
  const comparison = releaseA !== undefined && releaseB !== undefined ? compareScenarios(data, releaseA, releaseB) : null;

  const toggle = (key: string): void => {
    setPicked((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));
  };

  const addAllReady = (): void => {
    const ready = ranked.filter((row) => signalInfo(row.signal).ready).map((row) => row.key);
    setPicked((current) => [...current, ...ready.filter((key) => !current.includes(key))]);
  };

  const selectAll = (): void => setPicked(ranked.map((row) => row.key));

  return (
    <>
      {releases.length === 0 ? (
        <Empty
          title="No releases yet."
          body="Select outcomes below to plan your first release or promote verified work to a new track."
        />
      ) : (
        <>
          <section className="pf-card pf-timeline-card" aria-label="Release timeline">
            <header className="pf-card-head">
              <div>
                <h4 className="pf-card-title">Timeline swimlane</h4>
                <p className="pf-muted pf-small">
                  Ordered by target date · today is <strong>{new Date().toISOString().slice(0, 10)}</strong>
                </p>
              </div>
            </header>
            <div className="pf-swimlane">
              {releases
                .slice()
                .sort((a, b) => (a.release.date || "").localeCompare(b.release.date || ""))
                .map(({ release }, idx) => {
                  const rows = releaseReadiness(data, release);
                  const counts = readinessCounts(rows);
                  const pct = counts.total === 0 ? 0 : Math.round((counts.ready / counts.total) * 100);
                  const today = new Date().toISOString().slice(0, 10);
                  const pastDue = release.date !== "" && release.date < today && pct < 100;
                  const relId = `${release.name}\u0000${release.scenario}\u0000${release.date}`;
                  return (
                    <button
                      key={`${relId}:${idx}`}
                      type="button"
                      className={`pf-swim-item${pastDue ? " is-overdue" : ""}`}
                      onClick={() => setExpanded((cur) => ({ ...cur, [relId]: !cur[relId] }))}
                    >
                      <ProgressRing percent={pct} />
                      <div className="pf-swim-meta">
                        <strong>{release.name}</strong>
                        <span className="pf-muted pf-small">
                          {release.date || "unscheduled"} · {release.scenario}
                        </span>
                        <span className="pf-small">
                          {counts.ready} of {counts.total} proven
                          {pastDue ? " · past target" : ""}
                        </span>
                      </div>
                    </button>
                  );
                })}
            </div>
          </section>

          <div className="pf-stack">
            {releases.map(({ release }, index) => {
              const rows = releaseReadiness(data, release);
              const counts = readinessCounts(rows);
              const percent = counts.total === 0 ? 0 : Math.round((counts.ready / counts.total) * 100);
              const key = releaseIds[index] ?? `${index}:${release.name}`;
              const isOpen = expanded[key] === true;
              const isEditing = editingReleaseId === key;
              return (
                <article className="pf-card" key={key}>
                  <header className="pf-card-head">
                    <div className="pf-row">
                      <ProgressRing percent={percent} />
                      <div>
                        <h4 className="pf-card-title">{release.name}</h4>
                        <p className="pf-muted pf-small">
                          {release.date} · scenario <strong>{release.scenario}</strong> · {counts.ready}/{counts.total} proven
                        </p>
                      </div>
                    </div>
                    <div className="pf-actions">
                      {onFocusScopeFromRelease ? (
                        <button
                          type="button"
                          className="pf-btn pf-btn-ghost"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              `scope:${release.name}`,
                              async () => {
                                await onFocusScopeFromRelease(release);
                              },
                              `Focused agents on release "${release.name}".`,
                            )
                          }
                        >
                          Focus agents
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="pf-btn pf-btn-ghost"
                        onClick={() => {
                          if (isEditing) {
                            setEditingReleaseId(null);
                          } else {
                            setEditingReleaseId(key);
                            setEditDate(release.date);
                            setEditKeys(release.keys.slice());
                          }
                        }}
                      >
                        {isEditing ? "Cancel edit" : "Edit"}
                      </button>
                      <button
                        type="button"
                        className="pf-btn pf-btn-ghost"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded((current) => ({ ...current, [key]: !isOpen }))}
                      >
                        {isOpen ? "Hide keys" : "Show keys"}
                      </button>
                    </div>
                  </header>
                  <div className="pf-bar" role="img" aria-label={`${percent}% ready`}>
                    <span className="pf-bar-fill" style={{ width: `${percent}%` }} />
                  </div>
                  {isEditing ? (
                    <div className="pf-pin-form">
                      <div className="pf-row">
                        <label className="pf-label" htmlFor={`pf-edit-rel-date-${index}`}>
                          Target date
                        </label>
                        <input
                          id={`pf-edit-rel-date-${index}`}
                          type="date"
                          className="pf-input"
                          style={{ maxWidth: 180 }}
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                        />
                        <button
                          type="button"
                          className="pf-btn pf-btn-primary"
                          disabled={busy !== null || editKeys.length === 0 || !editDate}
                          onClick={() =>
                            void run(
                              `revise:${release.name}`,
                              async () => {
                                await act({
                                  op: "revise_release",
                                  name: release.name,
                                  scenario: release.scenario,
                                  date: editDate,
                                  keys: editKeys,
                                });
                              },
                              `Updated release "${release.name}".`,
                            ).then((ok) => {
                              if (ok) setEditingReleaseId(null);
                            })
                          }
                        >
                          Save release
                        </button>
                      </div>
                      <div className="pf-actions">
                        {ranked.map((r) => {
                          const included = editKeys.includes(r.key);
                          return (
                            <label key={r.key} className="pf-chip" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              <input
                                type="checkbox"
                                checked={included}
                                onChange={() =>
                                  setEditKeys((cur) =>
                                    included ? cur.filter((k) => k !== r.key) : [...cur, r.key],
                                  )
                                }
                              />
                              <span>{r.key}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {isOpen && (
                    <table className="pf-table">
                      <thead>
                        <tr>
                          <th scope="col">Outcome</th>
                          <th scope="col">Signal</th>
                          <th scope="col">Why not ready</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.key}>
                            <td>
                              <button type="button" className="pf-link" onClick={() => select(row.key)}>
                                {row.title}
                              </button>
                              <span className="pf-muted pf-small"> {row.key}</span>
                            </td>
                            <td>
                              <SignalBadge signal={row.signal} />
                            </td>
                            <td className="pf-muted pf-small">{row.ready ? "" : row.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}

      <details className="pf-disclosure pf-editor" open={releases.length === 0}>
        <summary>
          + New release or promote track{picked.length > 0 ? ` (${picked.length} selected)` : ""}
        </summary>
        <section className="pf-section" aria-labelledby="pf-pick-title">
          <div className="pf-section-head">
            <div>
              <h3 className="pf-section-title" id="pf-pick-title">
                Pick outcomes <span className="pf-count">{picked.length}</span>
              </h3>
              <p className="pf-muted pf-small">Choose outcomes for a new release or track promotion.</p>
            </div>
            <div className="pf-actions">
              <button type="button" className="pf-btn pf-btn-ghost" onClick={addAllReady} disabled={ranked.length === 0}>
                Add ready
              </button>
              <button type="button" className="pf-btn pf-btn-ghost" onClick={selectAll} disabled={ranked.length === 0}>
                Select all
              </button>
              <button type="button" className="pf-btn pf-btn-ghost" onClick={() => setPicked([])} disabled={picked.length === 0}>
                Clear
              </button>
            </div>
          </div>

          {ranked.length === 0 ? (
            <Empty
              title="No outcomes in this track yet."
              body="Add goals and outcomes in the Goals view first."
            />
          ) : (
            <ul className="pf-keys">
              {ranked.map((row, idx) => {
                const outcome = outcomes.get(row.key);
                const info = signalInfo(row.signal);
                return (
                  <li key={row.key} className={`pf-key${selected.has(row.key) ? " is-selected" : ""}`}>
                    <label className="pf-key-label">
                      <input type="checkbox" checked={selected.has(row.key)} onChange={() => toggle(row.key)} />
                      <span className="pf-key-body">
                        <span className="pf-key-title">{outcome?.title ?? row.key}</span>
                        <span className="pf-muted pf-small pf-key-meta">
                          #{idx + 1} · <code>{row.key}</code>
                          {row.blockedBy.length > 0 ? ` · blocked by ${row.blockedBy.join(", ")}` : ""}
                        </span>
                      </span>
                    </label>
                    <SignalBadge signal={row.signal} />
                    {!info.ready ? <span className="pf-muted pf-small pf-key-note">{info.note}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="pf-cols">
          <section className="pf-card" aria-labelledby="pf-release-create-title">
            <h3 className="pf-card-title" id="pf-release-create-title">
              Create release
            </h3>
            <p className="pf-muted pf-small">{picked.length} outcome{picked.length === 1 ? "" : "s"} selected.</p>
            <div className="pf-field">
              <label className="pf-label" htmlFor="pf-release-name">
                Name
              </label>
              <input
                id="pf-release-name"
                className="pf-input"
                value={releaseName}
                placeholder="November cut"
                onChange={(event) => setReleaseName(event.target.value)}
              />
            </div>
            <div className="pf-grid">
              <div className="pf-field">
                <label className="pf-label" htmlFor="pf-release-date">
                  Target date
                </label>
                <input
                  id="pf-release-date"
                  className="pf-input"
                  type="date"
                  value={releaseDate}
                  onChange={(event) => setReleaseDate(event.target.value)}
                />
              </div>
              <div className="pf-field">
                <label className="pf-label" htmlFor="pf-release-scenario">
                  Scenario
                </label>
                <input
                  id="pf-release-scenario"
                  className="pf-input"
                  value={releaseScenario}
                  placeholder="baseline"
                  onChange={(event) => setReleaseScenario(event.target.value)}
                />
              </div>
            </div>
            {picked.length > 0 && (
              <div className="pf-selected" aria-label="Selected keys">
                {picked.map((key) => (
                  <span className="pf-selected-chip" key={key}>
                    {outcomes.get(key)?.title ?? key}
                  </span>
                ))}
              </div>
            )}
            <div className="pf-actions">
              <button
                type="button"
                className="pf-btn pf-btn-primary"
                disabled={
                  busy !== null ||
                  picked.length === 0 ||
                  releaseName.trim() === "" ||
                  releaseScenario.trim() === "" ||
                  releaseDate === ""
                }
                onClick={() => {
                  const name = releaseName.trim();
                  void run(
                    "create-release",
                    async () => {
                      await act({
                        op: "create_release",
                        name,
                        keys: picked,
                        date: releaseDate,
                        scenario: releaseScenario.trim(),
                      });
                    },
                    `Release ${name} created.`,
                  ).then((ok) => {
                    if (ok) {
                      setReleaseName("");
                      setPicked([]);
                    }
                  });
                }}
              >
                {busy === "create-release" ? "Creating…" : "Create release"}
              </button>
            </div>
            {picked.length === 0 && <p className="pf-hint">Select at least one outcome above first.</p>}
          </section>

          <section className="pf-card" aria-labelledby="pf-promote-title">
            <h3 className="pf-card-title" id="pf-promote-title">
              Promote to track
            </h3>
            <p className="pf-muted pf-small">
              Preview which selected outcomes are verified, then promote them into a track.
            </p>
            <div className="pf-field">
              <label className="pf-label" htmlFor="pf-track-name">
                Target track name
              </label>
              <input
                id="pf-track-name"
                className="pf-input"
                value={newTrack}
                placeholder="release-2026-11"
                onChange={(event) => setNewTrack(event.target.value)}
              />
              {newTrack.trim() !== "" && !KEY_PATTERN.test(newTrack.trim()) && (
                <p className="pf-hint">Letters, digits, dash and underscore; must start with a letter or digit.</p>
              )}
            </div>
            <div className="pf-field">
              <label className="pf-label" htmlFor="pf-track-description">
                Description (optional)
              </label>
              <input
                id="pf-track-description"
                className="pf-input"
                value={description}
                placeholder="What this track verifies"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="pf-actions">
              <button
                type="button"
                className="pf-btn"
                disabled={busy !== null || picked.length === 0 || !KEY_PATTERN.test(newTrack.trim())}
                onClick={() => {
                  const name = newTrack.trim();
                  void run("preview", async () => {
                    const rows = await preview(name, picked);
                    setPreviewState({ signature, rows });
                  });
                }}
              >
                {busy === "preview" ? "Previewing…" : "Preview promotion"}
              </button>
              <button
                type="button"
                className="pf-btn pf-btn-primary"
                disabled={busy !== null || currentPreview === null || picked.length === 0}
                title={currentPreview === null ? "Preview the selection first" : "Promote the previewed selection"}
                onClick={() => {
                  const name = newTrack.trim();
                  void run(
                    "promote",
                    async () => {
                      await act({ op: "promote_track", name, keys: picked });
                    },
                    `Promoted ${picked.length} key${picked.length === 1 ? "" : "s"} into ${name}.`,
                  ).then((ok) => {
                    if (ok) setPreviewState(null);
                  });
                }}
              >
                {busy === "promote" ? "Promoting…" : `Promote ${picked.length} selected`}
              </button>
              {description.trim() !== "" && (
                <button
                  type="button"
                  className="pf-btn pf-btn-ghost"
                  disabled={busy !== null || !KEY_PATTERN.test(newTrack.trim()) || description.trim() === ""}
                  onClick={() => {
                    const name = newTrack.trim();
                    void run(
                      "create-track",
                      async () => {
                        await act({ op: "create_track", name, description: description.trim() });
                      },
                      `Track ${name} created.`,
                    );
                  }}
                >
                  Create empty track
                </button>
              )}
            </div>

            {currentPreview !== null && (
              <div className="pf-preview">
                <p className="pf-label">Preview for {newTrack.trim()}</p>
                <table className="pf-table">
                  <thead>
                    <tr>
                      <th scope="col">Outcome</th>
                      <th scope="col">Ready</th>
                      <th scope="col">From</th>
                      <th scope="col">To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPreview.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <button type="button" className="pf-link" onClick={() => select(row.key)}>
                            {row.key}
                          </button>
                        </td>
                        <td>
                          <span className={`pf-badge pf-tone-${row.ready ? "ready" : "warn"}`}>{row.ready ? "ready" : "not ready"}</span>
                        </td>
                        <td className="pf-muted">{row.from}</td>
                        <td>{row.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="pf-muted pf-small">
                  {currentPreview.filter((row) => row.ready).length} of {currentPreview.length} ready.
                </p>
              </div>
            )}
          </section>
        </div>
      </details>

      {releases.length >= 2 && comparison !== null ? (
        <details className="pf-disclosure">
          <summary>Compare two releases</summary>
          <section className="pf-section" aria-labelledby="pf-compare-title">
            <div className="pf-section-head">
              <h3 className="pf-section-title" id="pf-compare-title">
                Compare scenarios
              </h3>
              <div className="pf-row">
                <label className="pf-sr" htmlFor="pf-compare-a">
                  First release
                </label>
                <select
                  id="pf-compare-a"
                  className="pf-select"
                  value={resolvedAId}
                  onChange={(event) => setCompareAId(event.target.value)}
                >
                  {releases.map(({ release }, index) => (
                    <option key={releaseIds[index]} value={releaseIds[index]}>
                      {release.name} · {release.scenario}
                    </option>
                  ))}
                </select>
                <span className="pf-muted">vs</span>
                <label className="pf-sr" htmlFor="pf-compare-b">
                  Second release
                </label>
                <select
                  id="pf-compare-b"
                  className="pf-select"
                  value={resolvedBId}
                  onChange={(event) => setCompareBId(event.target.value)}
                >
                  {releases.map(({ release }, index) => (
                    <option key={releaseIds[index]} value={releaseIds[index]}>
                      {release.name} · {release.scenario}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="pf-card">
              <p className="pf-muted pf-small">
                {releaseA?.name}: {comparison.readyA} ready · {releaseB?.name}: {comparison.readyB} ready · {comparison.shared}{" "}
                shared, {comparison.onlyB} only in {releaseB?.scenario ?? "B"}, {comparison.onlyA} only in{" "}
                {releaseA?.scenario ?? "A"}
              </p>
              <table className="pf-table">
                <thead>
                  <tr>
                    <th scope="col">Outcome</th>
                    <th scope="col">{releaseA?.scenario ?? "A"}</th>
                    <th scope="col">{releaseB?.scenario ?? "B"}</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <button type="button" className="pf-link" onClick={() => select(row.key)}>
                          {row.title}
                        </button>
                        <span className="pf-muted pf-small"> {row.key}</span>
                      </td>
                      <td>{row.a === null ? <span className="pf-muted">absent</span> : <SignalBadge signal={row.a.signal} />}</td>
                      <td>{row.b === null ? <span className="pf-muted">absent</span> : <SignalBadge signal={row.b.signal} />}</td>
                      <td>
                        <span className={`pf-change pf-change-${row.change}`}>{row.change}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </details>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

interface FrameDraft {
  title: string;
  key: string;
  criterionId: string;
  kind: "html" | "image";
  html: string;
  imagePath: string;
  notes: string;
}

type ViewportPreset = "auto" | "mobile" | "laptop" | "desktop";

function FrameCard({
  frame,
  index,
  total,
  data,
  flowName,
  viewportPreset,
  act,
  run,
  busy,
  select,
}: {
  frame: Flow["frames"][number];
  index: number;
  total: number;
  data: Snapshot;
  flowName: string;
  viewportPreset: ViewportPreset;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  select: (key: string | null) => void;
}): ReactNode {
  const overlay = useRef<HTMLDivElement | null>(null);
  const [pinning, setPinning] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("");
  const [pinKind, setPinKind] = useState<PinKind>("point");
  const [forAgents, setForAgents] = useState(true);
  const [selector, setSelector] = useState("");
  const [openPin, setOpenPin] = useState<string | null>(null);
  const textId = useId();
  const criterion = criterionFor(data, frame.key, frame.criterionId);
  const group = pinsByCriterion(
    { name: flowName, frames: [frame] },
    data,
  )[0];
  const hue = criterionHue(frame.criterionId);
  const isolatedHtml = useMemo(() => isolateHtml(frame.html), [frame.html]);
  const canvasStyle =
    viewportPreset === "mobile"
      ? { maxWidth: 390, height: 480, margin: "0 auto" }
      : viewportPreset === "laptop"
        ? { maxWidth: 960, height: 420, margin: "0 auto" }
        : viewportPreset === "desktop"
          ? { maxWidth: 1200, height: 460, margin: "0 auto" }
          : undefined;

  const capture = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!pinning) return;
    const box = overlay.current?.getBoundingClientRect();
    if (box === undefined) return;
    setPoint(normalizePoint(box, event.clientX, event.clientY));
  };

  const openPinsCount = frame.pins.filter((p) => !p.resolved).length;
  const agentPinsCount = frame.pins.filter((p) => !p.resolved && p.forAgents).length;

  return (
    <li className="pf-frame">
      <header className="pf-frame-bar">
        <span className="pf-frame-step">
          Frame {index + 1} of {total}
        </span>
        <span className="pf-frame-title">{frame.title}</span>
        <span className="pf-pill">v{frame.version ?? 1}</span>
        {frame.kind === "image" ? <span className="pf-pill">image</span> : null}
        <button type="button" className="pf-link pf-small" onClick={() => select(frame.key)}>
          {frame.key}
        </button>
        <code className="pf-criterion-id" style={{ borderColor: `hsl(${hue} 65% 45%)` }}>
          {frame.criterionId}
        </code>
        {frame.history && frame.history.length > 0 ? (
          <select
            aria-label={`Restore previous version of ${frame.title}`}
            className="pf-select"
            style={{ width: "auto", minHeight: 24, fontSize: 11.5, padding: "1px 6px" }}
            value=""
            disabled={busy !== null}
            onChange={(e) => {
              const ver = Number(e.target.value);
              if (!Number.isInteger(ver) || ver < 1) return;
              void run(
                `restore:${flowName}:${index}:${ver}`,
                async () => {
                  await act({ op: "restore_frame_version", flowName, frameIndex: index, version: ver });
                },
                `Restored frame ${index + 1} from v${ver}.`,
              );
            }}
          >
            <option value="">History ({frame.history.length})…</option>
            {frame.history
              .slice()
              .reverse()
              .map((rev) => (
                <option key={rev.version} value={rev.version}>
                  Restore v{rev.version} ({rev.title})
                </option>
              ))}
          </select>
        ) : null}
      </header>
      {criterion !== null && (
        <p className="pf-criterion-text">
          Given {criterion.given}, when {criterion.when}, then {criterion.then}.
        </p>
      )}
      {frame.notes ? <p className="pf-muted pf-small">Notes: {frame.notes}</p> : null}
      {frame.driftDetected ? (
        <div className="pf-drift-banner" role="status">
          <span>
            <strong>Visual drift detected:</strong> {frame.driftNote ?? "Live screen differs from approved reference."}
          </span>
          <button
            type="button"
            className="pf-btn pf-btn-ghost"
            disabled={busy !== null}
            onClick={() =>
              void run(
                `drift:${flowName}:${index}`,
                async () => {
                  await act({ op: "set_frame_drift", flowName, frameIndex: index, driftDetected: false, driftNote: null });
                },
                "Cleared drift flag.",
              )
            }
          >
            Mark synced
          </button>
        </div>
      ) : null}

      <div className="pf-frame-canvas" style={canvasStyle}>
        {frame.kind === "image" && frame.imagePath ? (
          <img src={frame.imagePath} alt={`${frame.title} (${frame.key})`} className="pf-frame-img" />
        ) : (
          /* sandbox="" is the isolation: no scripts, no same-origin, no forms, no top navigation. */
          <iframe
            title={`${frame.title} (${frame.key} / ${frame.criterionId})`}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            loading="lazy"
            srcDoc={isolatedHtml}
          />
        )}
        <div
          ref={overlay}
          className={`pf-pin-layer${pinning ? " is-capturing" : ""}`}
          onClick={capture}
        >
          <svg className="pf-pin-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {frame.pins.map((pin, pinIndex) => {
              if (pin.resolved) return null;
              const cx = Math.min(1, Math.max(0, pin.x)) * 100;
              const cy = Math.min(1, Math.max(0, pin.y)) * 100;
              if (pin.kind === "rect") {
                const w = Number(pin.geometry?.w ?? 0.16) * 100;
                const h = Number(pin.geometry?.h ?? 0.12) * 100;
                return (
                  <rect
                    key={`svg:${index}:${pinIndex}`}
                    x={Math.max(0, cx - w / 2)}
                    y={Math.max(0, cy - h / 2)}
                    width={w}
                    height={h}
                    rx={1.5}
                    className={pin.forAgents ? "pf-ann-shape is-agent" : "pf-ann-shape"}
                  />
                );
              }
              if (pin.kind === "arrow") {
                const x2 = Number(pin.geometry?.x2 ?? Math.min(1, pin.x + 0.1)) * 100;
                const y2 = Number(pin.geometry?.y2 ?? Math.max(0, pin.y - 0.08)) * 100;
                return (
                  <line
                    key={`svg:${index}:${pinIndex}`}
                    x1={x2}
                    y1={y2}
                    x2={cx}
                    y2={cy}
                    className={pin.forAgents ? "pf-ann-arrow is-agent" : "pf-ann-arrow"}
                  />
                );
              }
              return null;
            })}
          </svg>
          {frame.pins.map((pin, pinIndex) => {
            const id = `${index}:${pinIndex}`;
            const position = pinPosition(pin);
            return (
              <button
                key={id}
                type="button"
                className={`pf-pin${pin.resolved ? " is-resolved" : ""}${pin.forAgents ? " is-agent" : ""}`}
                style={{ ...position, borderColor: pin.resolved ? undefined : `hsl(${criterionHue(frame.criterionId)} 65% 45%)` }}
                title={`${pin.forAgents ? "[for agents] " : ""}${pin.resolved ? "[resolved] " : ""}${pin.text}`}
                aria-label={`Pin ${pinIndex + 1}: ${pin.text}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenPin((current) => (current === id ? null : id));
                }}
              >
                {pin.kind === "step" ? `S${pinIndex + 1}` : pinIndex + 1}
              </button>
            );
          })}
          {point !== null && (
            <span
              className="pf-pin pf-pin-new"
              style={{ left: `${(point.x * 100).toFixed(2)}%`, top: `${(point.y * 100).toFixed(2)}%` }}
              aria-hidden="true"
            >
              +
            </span>
          )}
        </div>
      </div>

      <div className="pf-frame-tools">
        <button
          type="button"
          className={`pf-btn pf-btn-ghost${pinning ? " is-active" : ""}`}
          aria-pressed={pinning}
          onClick={() => {
            setPinning((current) => !current);
            setPoint(null);
          }}
        >
          {pinning ? "Click the frame to place an annotation" : "Annotate / Pin"}
        </button>
        <span className="pf-muted pf-small">
          {openPinsCount} open ({frame.pins.length} total)
          {agentPinsCount > 0 ? ` · ${agentPinsCount} for agents` : ""}
        </span>
      </div>

      {point !== null && (
        <form
          className="pf-pin-form"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = text.trim();
            if (trimmed === "" || point === null) return;
            void run(
              `pin:${index}`,
              async () => {
                await act({
                  op: "pin",
                  name: flowName,
                  frame: index,
                  x: point.x,
                  y: point.y,
                  text: trimmed,
                  kind: pinKind,
                  forAgents,
                  ...(selector.trim() ? { selector: selector.trim() } : {}),
                  ...(pinKind === "rect" ? { geometry: { w: 0.16, h: 0.12 } } : {}),
                });
              },
              "Annotation added.",
            ).then((ok) => {
              if (ok) {
                setText("");
                setSelector("");
                setPoint(null);
                setPinning(false);
              }
            });
          }}
        >
          <p className="pf-muted pf-small">
            Annotation at {(point.x * 100).toFixed(0)}% × {(point.y * 100).toFixed(0)}% on frame {index + 1}.
          </p>
          <div className="pf-row">
            <select
              aria-label="Annotation kind"
              className="pf-select"
              style={{ width: "auto" }}
              value={pinKind}
              onChange={(e) => setPinKind(e.target.value as PinKind)}
            >
              <option value="point">Pin</option>
              <option value="rect">Highlight box</option>
              <option value="arrow">Callout arrow</option>
              <option value="step">Step badge</option>
            </select>
            <label className="pf-small" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={forAgents} onChange={(e) => setForAgents(e.target.checked)} />
              <span>For agents</span>
            </label>
            <input
              className="pf-input"
              style={{ maxWidth: 190 }}
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              placeholder="Optional CSS selector"
              aria-label="Optional CSS selector"
            />
          </div>
          <div className="pf-row">
            <label className="pf-sr" htmlFor={textId}>
              Pin comment
            </label>
            <input
              id={textId}
              className="pf-input"
              value={text}
              placeholder="What should change or be noted here?"
              onChange={(event) => setText(event.target.value)}
            />
            <button type="submit" className="pf-btn pf-btn-primary" disabled={busy !== null || text.trim() === ""}>
              Save pin
            </button>
            <button type="button" className="pf-btn pf-btn-ghost" onClick={() => setPoint(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {frame.pins.length > 0 && (
        <ol className="pf-pin-list">
          {frame.pins.map((pin, pinIndex) => {
            const id = `${index}:${pinIndex}`;
            return (
              <li key={id} className={`${openPin === id ? "is-open" : ""}${pin.resolved ? " is-resolved" : ""}`}>
                <div className="pf-row pf-between">
                  <div>
                    <button type="button" className="pf-link" onClick={() => setOpenPin((current) => (current === id ? null : id))}>
                      {pin.kind && pin.kind !== "point" ? `${pin.kind} ` : "Pin "}
                      {pinIndex + 1}
                    </button>{" "}
                    <span className="pf-muted pf-small">
                      {(pin.x * 100).toFixed(0)}% × {(pin.y * 100).toFixed(0)}%
                    </span>
                    {pin.forAgents ? (
                      <span className="pf-badge pf-tone-info" style={{ marginLeft: 6 }}>
                        for agents
                      </span>
                    ) : null}
                    {pin.resolved ? (
                      <span className="pf-badge pf-tone-ready" style={{ marginLeft: 6 }}>
                        resolved
                      </span>
                    ) : null}
                    {pin.selector ? (
                      <code className="pf-small" style={{ marginLeft: 6 }}>
                        {pin.selector}
                      </code>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="pf-link pf-small"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        `resolve-pin:${index}:${pinIndex}`,
                        async () => {
                          await act({
                            op: "resolve_pin",
                            name: flowName,
                            frame: index,
                            pinIndex,
                            resolved: !pin.resolved,
                          });
                        },
                        pin.resolved ? "Reopened pin." : "Resolved pin.",
                      )
                    }
                  >
                    {pin.resolved ? "Reopen" : "Resolve"}
                  </button>
                </div>
                {(openPin === id || frame.pins.length === 1 || !pin.resolved) && <p className="pf-pin-text">{pin.text}</p>}
              </li>
            );
          })}
        </ol>
      )}

      {group !== undefined && group.criterion !== null && (
        <p className="pf-muted pf-small">Keyed to {group.criterionId}: {group.criterion.then}</p>
      )}
    </li>
  );
}

function FrameEditor({
  draft,
  index,
  total,
  outcomes,
  onChange,
  onRemove,
  onMove,
}: {
  draft: FrameDraft;
  index: number;
  total: number;
  outcomes: Outcome[];
  onChange: (next: FrameDraft) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}): ReactNode {
  const base = useId();
  const outcome = outcomes.find((candidate) => candidate.key === draft.key);
  return (
    <fieldset className="pf-editor-frame">
      <legend>
        Frame {index + 1} of {total}
      </legend>
      <div className="pf-grid">
        <div className="pf-field">
          <label className="pf-label" htmlFor={`${base}-title`}>
            Title
          </label>
          <input
            id={`${base}-title`}
            className="pf-input"
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor={`${base}-kind`}>
            Frame type
          </label>
          <select
            id={`${base}-kind`}
            className="pf-select"
            value={draft.kind}
            onChange={(event) => onChange({ ...draft, kind: event.target.value as "html" | "image" })}
          >
            <option value="html">Sandboxed HTML mockup</option>
            <option value="image">Screenshot / Image</option>
          </select>
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor={`${base}-outcome`}>
            Outcome
          </label>
          <select
            id={`${base}-outcome`}
            className="pf-select"
            value={draft.key}
            onChange={(event) => {
              const next = outcomes.find((candidate) => candidate.key === event.target.value);
              onChange({
                ...draft,
                key: event.target.value,
                criterionId: next?.criteria[0]?.id ?? draft.criterionId,
              });
            }}
          >
            {outcomes.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.key} — {candidate.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="pf-field">
        <label className="pf-label" htmlFor={`${base}-criterion`}>
          Criterion
        </label>
        <select
          id={`${base}-criterion`}
          className="pf-select"
          value={draft.criterionId}
          onChange={(event) => onChange({ ...draft, criterionId: event.target.value })}
        >
          {(outcome?.criteria ?? []).map((criterion) => (
            <option key={criterion.id} value={criterion.id}>
              {criterion.id}: {criterion.then}
            </option>
          ))}
        </select>
      </div>
      {draft.kind === "image" ? (
        <div className="pf-field">
          <label className="pf-label" htmlFor={`${base}-img`}>
            Image path or data URI
          </label>
          <input
            id={`${base}-img`}
            className="pf-input"
            value={draft.imagePath}
            placeholder="data:image/png;base64,… or screenshots/checkout.png"
            onChange={(event) => onChange({ ...draft, imagePath: event.target.value })}
          />
        </div>
      ) : (
        <div className="pf-field">
          <label className="pf-label" htmlFor={`${base}-html`}>
            HTML
          </label>
          <textarea
            id={`${base}-html`}
            className="pf-textarea"
            rows={5}
            value={draft.html}
            placeholder="<main style='font:16px system-ui;padding:24px'>…</main>"
            onChange={(event) => onChange({ ...draft, html: event.target.value })}
          />
          <p className="pf-hint">Rendered without scripts, forms or network access. Scripts are stripped before display.</p>
        </div>
      )}
      <div className="pf-field">
        <label className="pf-label" htmlFor={`${base}-notes`}>
          Interaction notes (optional)
        </label>
        <input
          id={`${base}-notes`}
          className="pf-input"
          value={draft.notes}
          placeholder="Click primary CTA to advance to confirmation screen…"
          onChange={(event) => onChange({ ...draft, notes: event.target.value })}
        />
      </div>
      <div className="pf-actions">
        <button type="button" className="pf-btn pf-btn-ghost" disabled={index === 0} onClick={() => onMove(-1)}>
          Move up
        </button>
        <button type="button" className="pf-btn pf-btn-ghost" disabled={index === total - 1} onClick={() => onMove(1)}>
          Move down
        </button>
        <button type="button" className="pf-btn pf-btn-danger" onClick={onRemove}>
          Remove
        </button>
      </div>
    </fieldset>
  );
}

function Flows({
  data,
  act,
  run,
  busy,
  select,
  initialFlow,
}: {
  data: Snapshot;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  select: (key: string | null) => void;
  initialFlow?: string | null;
}): ReactNode {
  const [activeName, setActiveName] = useState<string | null>(initialFlow ?? null);
  const [folderFilter, setFolderFilter] = useState<string>("all");
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);
  const [playerMode, setPlayerMode] = useState(false);
  const [playerStep, setPlayerStep] = useState(0);
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>("auto");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [designKit, setDesignKit] = useState("");
  const [frames, setFrames] = useState<FrameDraft[]>([]);

  useEffect(() => {
    if (initialFlow) setActiveName(initialFlow);
  }, [initialFlow]);

  const outcomes = useMemo(
    () => data.outcomes.slice().sort((a, b) => a.title.localeCompare(b.title)),
    [data.outcomes],
  );
  const pendingProposals = useMemo(
    () => (data.flowProposals ?? []).filter((p) => p.state === "pending"),
    [data.flowProposals],
  );

  const flowNeedsAttention = (entry: Flow): boolean =>
    pendingProposals.some((p) => p.flowName === entry.name) ||
    entry.frames.some((fr) => fr.driftDetected || fr.pins.some((p) => !p.resolved && p.forAgents));

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const f of data.flows) if (f.folder) set.add(f.folder);
    return [...set].sort();
  }, [data.flows]);

  const visibleFlows = useMemo(
    () =>
      data.flows.filter((f) => {
        if (folderFilter !== "all" && (f.folder ?? "") !== folderFilter) return false;
        if (needsAttentionOnly && !flowNeedsAttention(f)) return false;
        return true;
      }),
    [data.flows, folderFilter, needsAttentionOnly, pendingProposals],
  );

  const flow =
    (activeName !== null ? visibleFlows.find((entry) => entry.name === activeName) ?? data.flows.find((entry) => entry.name === activeName) : undefined) ??
    visibleFlows[0] ??
    null;

  useEffect(() => {
    setPlayerStep(0);
  }, [flow?.name]);

  const flowProposalsForActive = useMemo(
    () => (flow ? pendingProposals.filter((p) => p.flowName === flow.name) : pendingProposals),
    [flow, pendingProposals],
  );
  const groups = flow === null ? [] : pinsByCriterion(flow, data);

  const addFrame = (): void => {
    const first = outcomes[0];
    setFrames((current) => [
      ...current,
      {
        title: "",
        key: first?.key ?? "",
        criterionId: first?.criteria[0]?.id ?? "",
        kind: "html",
        html: "",
        imagePath: "",
        notes: "",
      },
    ]);
  };

  const frameValid = (frame: FrameDraft): boolean =>
    frame.title.trim() !== "" &&
    frame.key !== "" &&
    frame.criterionId !== "" &&
    (frame.kind === "image" ? frame.imagePath.trim() !== "" : frame.html.trim() !== "");

  const canCreate = name.trim() !== "" && frames.length > 0 && frames.every(frameValid);

  return (
    <div className="pf-flows">
      <aside className="pf-flow-list" aria-label="Flows">
        <div className="pf-row pf-between">
          <h3 className="pf-section-title">Flows</h3>
          <button
            type="button"
            className={`pf-chip${needsAttentionOnly ? " is-active" : ""}`}
            aria-pressed={needsAttentionOnly}
            onClick={() => setNeedsAttentionOnly((v) => !v)}
          >
            Needs attention
          </button>
        </div>
        {folders.length > 0 ? (
          <select
            aria-label="Filter flows by folder"
            className="pf-select"
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
        {visibleFlows.length === 0 ? (
          <p className="pf-muted pf-small">
            {data.flows.length === 0
              ? "No flows yet. Use New flow to create the first one."
              : "No flows match this filter."}
          </p>
        ) : (
          <ul>
            {visibleFlows.map((entry, index) => {
              const attention = flowNeedsAttention(entry);
              return (
                <li key={`${entry.name}:${index}`}>
                  <button
                    type="button"
                    className={`pf-flow-item${entry === flow ? " is-active" : ""}`}
                    aria-pressed={entry === flow}
                    onClick={() => setActiveName(entry.name)}
                  >
                    <span className="pf-flow-name">
                      {entry.name}
                      {attention ? <span className="pf-badge pf-tone-warn" style={{ marginLeft: 6 }}>!</span> : null}
                    </span>
                    <span className="pf-muted pf-small">
                      {entry.folder ? `${entry.folder} · ` : ""}
                      {entry.frames.length} frame{entry.frames.length === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="pf-flow-main" aria-label="Selected flow">
        {flowProposalsForActive.length > 0 ? (
          <section className="pf-section" aria-label="Pending proposals for this flow">
            <h4 className="pf-section-title">
              Pending review <span className="pf-count">{flowProposalsForActive.length}</span>
            </h4>
            <div className="pf-stack">
              {flowProposalsForActive.map((proposal) => (
                <FlowProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  currentFlow={data.flows.find((f) => f.name === proposal.flowName)}
                  act={act}
                  run={run}
                  busy={busy}
                />
              ))}
            </div>
          </section>
        ) : null}

        {flow === null ? (
          <Empty
            title="No flow to show."
            body="A flow is an ordered set of frames — one per criterion — that reviewers walk through with you. Name one and add its first frame below."
          />
        ) : (
          <>
            <header className="pf-section-head">
              <div>
                <h3 className="pf-section-title">
                  {flow.folder ? <span className="pf-muted">{flow.folder} / </span> : null}
                  {flow.name}
                  {flow.designKit ? <span className="pf-pill">{flow.designKit}</span> : null}
                </h3>
                <p className="pf-muted pf-small">
                  {flow.frames.length} ordered frame{flow.frames.length === 1 ? "" : "s"} ·{" "}
                  {flow.frames.reduce((total, frame) => total + frame.pins.filter((p) => !p.resolved).length, 0)} open
                  annotations
                </p>
              </div>
              <div className="pf-actions">
                <div className="cl-seg" role="group" aria-label="Flow display mode">
                  <button
                    type="button"
                    className={!playerMode ? "is-active" : ""}
                    onClick={() => setPlayerMode(false)}
                  >
                    All frames
                  </button>
                  <button
                    type="button"
                    className={playerMode ? "is-active" : ""}
                    onClick={() => setPlayerMode(true)}
                  >
                    Player
                  </button>
                </div>
                <select
                  aria-label="Viewport preset"
                  className="pf-select"
                  style={{ width: "auto" }}
                  value={viewportPreset}
                  onChange={(e) => setViewportPreset(e.target.value as ViewportPreset)}
                >
                  <option value="auto">Viewport: auto</option>
                  <option value="mobile">Mobile 390×844</option>
                  <option value="laptop">Laptop 1280×720</option>
                  <option value="desktop">Desktop 1440×900</option>
                </select>
              </div>
            </header>

            {playerMode && flow.frames.length > 0 ? (
              <div className="pf-stack">
                <div className="pf-row pf-between">
                  <button
                    type="button"
                    className="pf-btn"
                    disabled={playerStep <= 0}
                    onClick={() => setPlayerStep((s) => Math.max(0, s - 1))}
                  >
                    ← Prev
                  </button>
                  <div className="pf-actions">
                    {flow.frames.map((fr, idx) => (
                      <button
                        key={`${flow.name}:dot:${idx}`}
                        type="button"
                        className={`pf-chip${idx === playerStep ? " is-active" : ""}`}
                        onClick={() => setPlayerStep(idx)}
                      >
                        {idx + 1}. {fr.title.slice(0, 14)}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="pf-btn"
                    disabled={playerStep >= flow.frames.length - 1}
                    onClick={() => setPlayerStep((s) => Math.min(flow.frames.length - 1, s + 1))}
                  >
                    Next →
                  </button>
                </div>
                <ol className="pf-frames">
                  {flow.frames[playerStep] ? (
                    <FrameCard
                      key={`${flow.name}:${playerStep}:${flow.frames[playerStep]!.title}`}
                      frame={flow.frames[playerStep]!}
                      index={playerStep}
                      total={flow.frames.length}
                      data={data}
                      flowName={flow.name}
                      viewportPreset={viewportPreset}
                      act={act}
                      run={run}
                      busy={busy}
                      select={select}
                    />
                  ) : null}
                </ol>
              </div>
            ) : (
              <ol className="pf-frames">
                {flow.frames.map((frame, index) => (
                  <FrameCard
                    key={`${flow.name}:${index}:${frame.title}`}
                    frame={frame}
                    index={index}
                    total={flow.frames.length}
                    data={data}
                    flowName={flow.name}
                    viewportPreset={viewportPreset}
                    act={act}
                    run={run}
                    busy={busy}
                    select={select}
                  />
                ))}
              </ol>
            )}

            {groups.length > 0 ? (
              <section className="pf-section" aria-labelledby="pf-pins-title">
                <h4 className="pf-section-title" id="pf-pins-title">
                  Annotations by check
                </h4>
                <div className="pf-stack">
                  {groups.map((group) => (
                    <article key={group.criterionId} className="pf-card">
                      <header className="pf-card-head">
                        <div>
                          <h5 className="pf-card-title">
                            <code className="pf-criterion-id" style={{ borderColor: `hsl(${criterionHue(group.criterionId)} 65% 45%)` }}>
                              {group.criterionId}
                            </code>{" "}
                            {group.criterion?.then ?? group.key}
                          </h5>
                          {group.criterion !== null && (
                            <p className="pf-muted pf-small">
                              Given {group.criterion.given}, when {group.criterion.when}, then {group.criterion.then}.
                            </p>
                          )}
                        </div>
                        <span className="pf-count">{group.pins.length}</span>
                      </header>
                      <ul className="pf-pin-list">
                        {group.pins.map((entry, index) => (
                          <li key={`${entry.frame}:${index}`} className={entry.pin.resolved ? "is-resolved" : ""}>
                            <span className="pf-muted pf-small">
                              Frame {entry.frame + 1} · {entry.frameTitle} · {(entry.pin.x * 100).toFixed(0)}% ×{" "}
                              {(entry.pin.y * 100).toFixed(0)}%
                              {entry.pin.forAgents ? " · for agents" : ""}
                              {entry.pin.resolved ? " · resolved" : ""}
                            </span>
                            <p className="pf-pin-text">{entry.pin.text}</p>
                          </li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}

        <details className="pf-disclosure pf-editor" open={data.flows.length === 0}>
          <summary>+ New flow</summary>
          <form
            className="pf-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canCreate) return;
              const createdName = name.trim();
              void run(
                "create-flow",
                async () => {
                  await act({
                    op: "create_flow",
                    name: createdName,
                    ...(folder.trim() ? { folder: folder.trim() } : {}),
                    ...(designKit.trim() ? { designKit: designKit.trim() } : {}),
                    frames: frames.map((frame) => ({
                      title: frame.title.trim(),
                      key: frame.key,
                      criterionId: frame.criterionId,
                      kind: frame.kind,
                      html: frame.kind === "html" ? frame.html.trim() : "",
                      ...(frame.kind === "image" ? { imagePath: frame.imagePath.trim() } : {}),
                      ...(frame.notes.trim() ? { notes: frame.notes.trim() } : {}),
                    })),
                  });
                },
                `Flow ${createdName} created.`,
              ).then((ok) => {
                if (ok) {
                  setName("");
                  setFolder("");
                  setDesignKit("");
                  setFrames([]);
                  setActiveName(createdName);
                }
              });
            }}
          >
            <div className="pf-grid">
              <div className="pf-field">
                <label className="pf-label" htmlFor="pf-flow-name">
                  Flow name
                </label>
                <input
                  id="pf-flow-name"
                  className="pf-input"
                  value={name}
                  placeholder="Checkout walkthrough"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="pf-field">
                <label className="pf-label" htmlFor="pf-flow-folder">
                  Folder (optional)
                </label>
                <input
                  id="pf-flow-folder"
                  className="pf-input"
                  value={folder}
                  placeholder="Onboarding"
                  onChange={(event) => setFolder(event.target.value)}
                />
              </div>
              <div className="pf-field">
                <label className="pf-label" htmlFor="pf-flow-kit">
                  Design kit (optional)
                </label>
                <input
                  id="pf-flow-kit"
                  className="pf-input"
                  value={designKit}
                  placeholder="Linear / Minimal / Brand"
                  onChange={(event) => setDesignKit(event.target.value)}
                />
              </div>
            </div>

            {outcomes.length === 0 ? (
              <p className="pf-hint">A frame binds to an outcome criterion, so create an outcome first.</p>
            ) : (
              <>
                {frames.map((frame, index) => (
                  <FrameEditor
                    key={index}
                    draft={frame}
                    index={index}
                    total={frames.length}
                    outcomes={outcomes}
                    onChange={(next) =>
                      setFrames((current) => current.map((entry, position) => (position === index ? next : entry)))
                    }
                    onRemove={() => setFrames((current) => current.filter((_, position) => position !== index))}
                    onMove={(direction) =>
                      setFrames((current) => {
                        const target = index + direction;
                        if (target < 0 || target >= current.length) return current;
                        const copy = current.slice();
                        const moved = copy[index];
                        const replaced = copy[target];
                        if (moved === undefined || replaced === undefined) return current;
                        copy[index] = replaced;
                        copy[target] = moved;
                        return copy;
                      })
                    }
                  />
                ))}
                <div className="pf-actions">
                  <button type="button" className="pf-btn" onClick={addFrame}>
                    {frames.length === 0 ? "Add first frame" : "Add frame"}
                  </button>
                  <button type="submit" className="pf-btn pf-btn-primary" disabled={busy !== null || !canCreate}>
                    {busy === "create-flow" ? "Creating…" : "Create flow"}
                  </button>
                </div>
                {!canCreate && frames.length > 0 && (
                  <p className="pf-hint">Every frame needs a title, an outcome, a criterion, and HTML or an image path.</p>
                )}
              </>
            )}
          </form>
        </details>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function Portfolio({
  page,
  data,
  act,
  select,
  chooseTrack,
  track,
  preview,
  initialFlow,
  onFocusScopeFromRelease,
  otherPendingProjects,
  onSelectProject,
}: PortfolioProps): ReactNode {
  const { busy, error, notice, run } = useAction(act);
  const counts = inboxCounts(data);
  const totalDecisions = counts.changes + counts.flowProposals + counts.questions;
  const titles = { inbox: "Decisions", roadmap: "Roadmap", flows: "Flows" } as const;
  const subtitles = {
    inbox:
      totalDecisions === 0
        ? "All caught up"
        : [
            counts.changes > 0 ? `${counts.changes} proposed edit${counts.changes === 1 ? "" : "s"}` : null,
            counts.flowProposals > 0 ? `${counts.flowProposals} flow update${counts.flowProposals === 1 ? "" : "s"}` : null,
            counts.questions > 0 ? `${counts.questions} open question${counts.questions === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
    roadmap: `${data.releases.length} release${data.releases.length === 1 ? "" : "s"} · track ${track}`,
    flows: `${data.flows.length} visual walkthrough${data.flows.length === 1 ? "" : "s"} tied to acceptance checks`,
  } as const;

  return (
    <section className="pf" aria-labelledby="pf-page-title">
      <header className="pf-head">
        <div>
          <h2 className="pf-title" id="pf-page-title">
            {titles[page]}
          </h2>
          <p className="pf-sub">{subtitles[page]}</p>
        </div>
        <TrackChips data={data} track={track} chooseTrack={chooseTrack} />
      </header>

      <Feedback error={error} notice={notice} />

      {page === "inbox" && (
        <Inbox
          data={data}
          act={act}
          run={run}
          busy={busy}
          select={select}
          otherPendingProjects={otherPendingProjects}
          onSelectProject={onSelectProject}
        />
      )}
      {page === "roadmap" && (
        <Roadmap
          data={data}
          act={act}
          run={run}
          busy={busy}
          preview={preview}
          track={track}
          chooseTrack={chooseTrack}
          select={select}
          onFocusScopeFromRelease={onFocusScopeFromRelease}
        />
      )}
      {page === "flows" && (
        <Flows data={data} act={act} run={run} busy={busy} select={select} initialFlow={initialFlow} />
      )}
    </section>
  );
}

export default Portfolio;
