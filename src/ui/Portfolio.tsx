// Portfolio — the Inbox, Roadmap and Flows surfaces.
//
// Rendering only. Every mutation goes through `act`; the readiness and
// comparison readings here come from the snapshot and are advisory. Approval,
// promotion and release policy lives on the server, which validates versions
// and evidence at the moment it writes.
import { useId, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { Action } from "../actions.js";
import type {
  Change,
  Comment,
  Contract,
  Criterion,
  Flow,
  Outcome,
  Pin,
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

export function inboxCounts(data: Snapshot): { changes: number; questions: number } {
  return {
    changes: data.changes.filter((change) => change.state === "pending").length,
    questions: data.comments.filter((comment) => comment.answer === null).length,
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
  if (data.tracks.length === 0) return null;
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
  const moved = outcome !== undefined && outcome.version !== change.baseVersion;
  const decided = change.state !== "pending";
  return (
    <article className="pf-card">
      <header className="pf-card-head">
        <div>
          <h3 className="pf-card-title">{change.proposed.title}</h3>
          <p className="pf-muted pf-small">
            <button type="button" className="pf-link" onClick={() => select(change.key)}>
              {change.key}
            </button>
            {outcome === undefined ? " · outcome not in this tree" : ` · now v${outcome.version}`} · proposed against v
            {change.baseVersion}
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

      {outcome === undefined ? (
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

function Inbox({
  data,
  act,
  run,
  busy,
  select,
}: {
  data: Snapshot;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  select: (key: string | null) => void;
}): ReactNode {
  const changes = useMemo(
    () => data.changes.filter((change) => change.state === "pending").sort((a, b) => b.created.localeCompare(a.created)),
    [data.changes],
  );
  const decided = useMemo(
    () => data.changes.filter((change) => change.state !== "pending").sort((a, b) => b.created.localeCompare(a.created)),
    [data.changes],
  );
  const threads = useMemo(() => questionThreads(data), [data]);
  const open = threads.filter((thread) => thread.open);
  const answered = threads.filter((thread) => !thread.open);
  const outcomes = useMemo(() => new Map(data.outcomes.map((outcome) => [outcome.key, outcome])), [data.outcomes]);
  const [showDecided, setShowDecided] = useState(false);

  return (
    <>
      {changes.length === 0 && open.length === 0 ? (
        <Empty
          title="Nothing is waiting on you."
          body="Agent-proposed contract edits land here for approval, and open questions stay until you answer them. Both appear the moment an agent acts."
        >
          {data.next[0] !== undefined && (
            <button type="button" className="pf-btn" onClick={() => select(data.next[0] ?? null)}>
              Open next ranked outcome: {data.next[0]}
            </button>
          )}
        </Empty>
      ) : (
        <>
          {changes.length > 0 && (
            <section className="pf-section" aria-labelledby="pf-changes-title">
              <h3 className="pf-section-title" id="pf-changes-title">
                Contract changes <span className="pf-count">{changes.length}</span>
              </h3>
              <p className="pf-muted pf-small">
                Approve applies the proposed contract to the outcome; reject keeps the current version. The server checks the base
                version at the moment of approval.
              </p>
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

function Roadmap({
  data,
  act,
  run,
  busy,
  preview,
  track,
  chooseTrack,
  select,
}: {
  data: Snapshot;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  preview: PortfolioProps["preview"];
  track: string;
  chooseTrack: (t: string) => void;
  select: (key: string | null) => void;
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
      <div className="pf-section-head">
        <div>
          <h3 className="pf-section-title">Release readiness</h3>
          <p className="pf-muted pf-small">
            Ready means verified at the current contract version in track <strong>{track}</strong>. Only verified keys count as
            ready; the server owns what a release may contain.
          </p>
        </div>
        <TrackChips data={data} track={track} chooseTrack={chooseTrack} />
      </div>

      {releases.length === 0 ? (
        <Empty
          title="No releases yet."
          body="Pick the outcomes that belong in a release below, name the scenario, and create the first release. Readiness updates as evidence lands."
        />
      ) : (
        <div className="pf-stack">
          {releases.map(({ release }, index) => {
            const rows = releaseReadiness(data, release);
            const counts = readinessCounts(rows);
            const percent = counts.total === 0 ? 0 : Math.round((counts.ready / counts.total) * 100);
            const key = releaseIds[index] ?? `${index}:${release.name}`;
            const isOpen = expanded[key] === true;
            return (
              <article className="pf-card" key={key}>
                <header className="pf-card-head">
                  <div>
                    <h4 className="pf-card-title">{release.name}</h4>
                    <p className="pf-muted pf-small">
                      {release.date} · scenario <strong>{release.scenario}</strong> · {counts.ready}/{counts.total} ready
                    </p>
                  </div>
                  <button
                    type="button"
                    className="pf-btn pf-btn-ghost"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded((current) => ({ ...current, [key]: !isOpen }))}
                  >
                    {isOpen ? "Hide keys" : "Show keys"}
                  </button>
                </header>
                <div className="pf-bar" role="img" aria-label={`${percent}% ready`}>
                  <span className="pf-bar-fill" style={{ width: `${percent}%` }} />
                </div>
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
      )}

      <section className="pf-section" aria-labelledby="pf-pick-title">
        <div className="pf-section-head">
          <div>
            <h3 className="pf-section-title" id="pf-pick-title">
              Selected keys <span className="pf-count">{picked.length}</span>
            </h3>
            <p className="pf-muted pf-small">Selection drives both track promotion and the new release.</p>
          </div>
          <div className="pf-actions">
            <button type="button" className="pf-btn pf-btn-ghost" onClick={addAllReady} disabled={ranked.length === 0}>
              Add all ready
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
            title="Nothing ranked in this track."
            body="A charter, goal and outcome come first. Once outcomes exist they appear here in rank order, with their verification signal."
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
        <section className="pf-card" aria-labelledby="pf-promote-title">
          <h3 className="pf-card-title" id="pf-promote-title">
            Promote a track
          </h3>
          <p className="pf-muted pf-small">
            Preview what the cutover would do per key, then promote the selection into that track. The server re-checks every key
            and records evidence only where the current version is verified.
          </p>
          <div className="pf-field">
            <label className="pf-label" htmlFor="pf-track-name">
              New track name
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
              Description
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
                {currentPreview.filter((row) => row.ready).length} of {currentPreview.length} ready. Promotion skips keys the
                server cannot verify at their current version.
              </p>
              {data.tracks.some((entry) => entry.name === newTrack.trim()) === false && (
                <p className="pf-hint">This track does not exist yet; promotion creates it.</p>
              )}
            </div>
          )}
        </section>

        <section className="pf-card" aria-labelledby="pf-release-create-title">
          <h3 className="pf-card-title" id="pf-release-create-title">
            Create a release
          </h3>
          <p className="pf-muted pf-small">The selected {picked.length} key{picked.length === 1 ? "" : "s"} become the release scope.</p>
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
                Date
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
          {picked.length === 0 && <p className="pf-hint">Select at least one key above first.</p>}
        </section>
      </div>

      <section className="pf-section" aria-labelledby="pf-compare-title">
        <div className="pf-section-head">
          <div>
            <h3 className="pf-section-title" id="pf-compare-title">
              Compare scenarios
            </h3>
            <p className="pf-muted pf-small">Two releases, side by side, scored against the current snapshot.</p>
          </div>
          {releases.length >= 2 && (
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
          )}
        </div>

        {comparison === null ? (
          <Empty
            title="Two releases are needed to compare."
            body="Create releases with different scenario names — for example a baseline and a candidate — then compare what each one can actually ship."
          />
        ) : (
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
        )}
      </section>
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
  html: string;
}

function FrameCard({
  frame,
  index,
  total,
  data,
  flowName,
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
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  select: (key: string | null) => void;
}): ReactNode {
  const overlay = useRef<HTMLDivElement | null>(null);
  const [pinning, setPinning] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("");
  const [openPin, setOpenPin] = useState<string | null>(null);
  const textId = useId();
  const criterion = criterionFor(data, frame.key, frame.criterionId);
  const group = pinsByCriterion(
    { name: flowName, frames: [frame] },
    data,
  )[0];
  const hue = criterionHue(frame.criterionId);
  const isolatedHtml = useMemo(() => isolateHtml(frame.html), [frame.html]);

  const capture = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!pinning) return;
    const box = overlay.current?.getBoundingClientRect();
    if (box === undefined) return;
    setPoint(normalizePoint(box, event.clientX, event.clientY));
  };

  return (
    <li className="pf-frame">
      <header className="pf-frame-bar">
        <span className="pf-frame-step">
          Frame {index + 1} of {total}
        </span>
        <span className="pf-frame-title">{frame.title}</span>
        <button type="button" className="pf-link pf-small" onClick={() => select(frame.key)}>
          {frame.key}
        </button>
        <code className="pf-criterion-id" style={{ borderColor: `hsl(${hue} 65% 45%)` }}>
          {frame.criterionId}
        </code>
      </header>
      {criterion !== null && (
        <p className="pf-criterion-text">
          Given {criterion.given}, when {criterion.when}, then {criterion.then}.
        </p>
      )}

      <div className="pf-frame-canvas">
        {/* sandbox="" is the isolation: no scripts, no same-origin, no forms, no top navigation. */}
        <iframe
          title={`${frame.title} (${frame.key} / ${frame.criterionId})`}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
          srcDoc={isolatedHtml}
        />
        <div
          ref={overlay}
          className={`pf-pin-layer${pinning ? " is-capturing" : ""}`}
          onClick={capture}
        >
          {frame.pins.map((pin, pinIndex) => {
            const id = `${index}:${pinIndex}`;
            const position = pinPosition(pin);
            return (
              <button
                key={id}
                type="button"
                className="pf-pin"
                style={{ ...position, borderColor: `hsl(${criterionHue(frame.criterionId)} 65% 45%)` }}
                title={pin.text}
                aria-label={`Pin ${pinIndex + 1}: ${pin.text}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenPin((current) => (current === id ? null : id));
                }}
              >
                {pinIndex + 1}
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
          {pinning ? "Click the frame to place a pin" : "Pin a comment"}
        </button>
        <span className="pf-muted pf-small">{frame.pins.length} pin{frame.pins.length === 1 ? "" : "s"}</span>
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
                await act({ op: "pin", name: flowName, frame: index, x: point.x, y: point.y, text: trimmed });
              },
              "Pin added.",
            ).then((ok) => {
              if (ok) {
                setText("");
                setPoint(null);
                setPinning(false);
              }
            });
          }}
        >
          <p className="pf-muted pf-small">
            Pin at {(point.x * 100).toFixed(0)}% × {(point.y * 100).toFixed(0)}% on frame {index + 1}.
          </p>
          <div className="pf-row">
            <label className="pf-sr" htmlFor={textId}>
              Pin comment
            </label>
            <input
              id={textId}
              className="pf-input"
              value={text}
              placeholder="What is wrong or worth noting here?"
              onChange={(event) => setText(event.target.value)}
            />
            <button type="submit" className="pf-btn pf-btn-primary" disabled={busy !== null || text.trim() === ""}>
              Pin
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
              <li key={id} className={openPin === id ? "is-open" : ""}>
                <button type="button" className="pf-link" onClick={() => setOpenPin((current) => (current === id ? null : id))}>
                  Pin {pinIndex + 1}
                </button>{" "}
                <span className="pf-muted pf-small">
                  {(pin.x * 100).toFixed(0)}% × {(pin.y * 100).toFixed(0)}%
                </span>
                {(openPin === id || frame.pins.length === 1) && <p className="pf-pin-text">{pin.text}</p>}
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
}: {
  data: Snapshot;
  act: PortfolioProps["act"];
  run: Run;
  busy: string | null;
  select: (key: string | null) => void;
}): ReactNode {
  const [activeName, setActiveName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [frames, setFrames] = useState<FrameDraft[]>([]);
  const outcomes = useMemo(
    () => data.outcomes.slice().sort((a, b) => a.title.localeCompare(b.title)),
    [data.outcomes],
  );
  const flow = (activeName !== null ? data.flows.find((entry) => entry.name === activeName) : undefined) ?? data.flows[0] ?? null;
  const groups = flow === null ? [] : pinsByCriterion(flow, data);

  const addFrame = (): void => {
    const first = outcomes[0];
    setFrames((current) => [
      ...current,
      {
        title: "",
        key: first?.key ?? "",
        criterionId: first?.criteria[0]?.id ?? "",
        html: "",
      },
    ]);
  };

  const frameValid = (frame: FrameDraft): boolean =>
    frame.title.trim() !== "" &&
    frame.key !== "" &&
    frame.criterionId !== "" &&
    frame.html.trim() !== "";

  const canCreate = name.trim() !== "" && frames.length > 0 && frames.every(frameValid);

  return (
    <div className="pf-flows">
      <aside className="pf-flow-list" aria-label="Flows">
        <h3 className="pf-section-title">Flows</h3>
        {data.flows.length === 0 ? (
          <p className="pf-muted pf-small">No flows yet. Use New flow to create the first one.</p>
        ) : (
          <ul>
            {data.flows.map((entry, index) => (
              <li key={`${entry.name}:${index}`}>
                <button
                  type="button"
                  className={`pf-flow-item${entry === flow ? " is-active" : ""}`}
                  aria-pressed={entry === flow}
                  onClick={() => setActiveName(entry.name)}
                >
                  <span className="pf-flow-name">{entry.name}</span>
                  <span className="pf-muted pf-small">
                    {entry.frames.length} frame{entry.frames.length === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="pf-flow-main" aria-label="Selected flow">
        {flow === null ? (
          <Empty
            title="No flow to show."
            body="A flow is an ordered set of frames — one per criterion — that reviewers walk through with you. Name one and add its first frame below."
          />
        ) : (
          <>
            <header className="pf-section-head">
              <div>
                <h3 className="pf-section-title">{flow.name}</h3>
                <p className="pf-muted pf-small">
                  {flow.frames.length} ordered frame{flow.frames.length === 1 ? "" : "s"} ·{" "}
                  {flow.frames.reduce((total, frame) => total + frame.pins.length, 0)} pinned comments
                </p>
              </div>
            </header>

            <ol className="pf-frames">
              {flow.frames.map((frame, index) => (
                <FrameCard
                  key={`${flow.name}:${index}:${frame.title}`}
                  frame={frame}
                  index={index}
                  total={flow.frames.length}
                  data={data}
                  flowName={flow.name}
                  act={act}
                  run={run}
                  busy={busy}
                  select={select}
                />
              ))}
            </ol>

            <section className="pf-section" aria-labelledby="pf-pins-title">
              <h4 className="pf-section-title" id="pf-pins-title">
                Comments by criterion
              </h4>
              {groups.length === 0 ? (
                <p className="pf-muted pf-small">No pins yet. Use “Pin a comment” on a frame.</p>
              ) : (
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
                          <li key={`${entry.frame}:${index}`}>
                            <span className="pf-muted pf-small">
                              Frame {entry.frame + 1} · {entry.frameTitle} · {(entry.pin.x * 100).toFixed(0)}% ×{" "}
                              {(entry.pin.y * 100).toFixed(0)}%
                            </span>
                            <p className="pf-pin-text">{entry.pin.text}</p>
                          </li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <details className="pf-disclosure pf-editor" open={data.flows.length === 0}>
          <summary>New flow</summary>
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
                    frames: frames.map((frame) => ({
                      title: frame.title.trim(),
                      key: frame.key,
                      criterionId: frame.criterionId,
                      html: frame.html.trim(),
                    })),
                  });
                },
                `Flow ${createdName} created.`,
              ).then((ok) => {
                if (ok) {
                  setName("");
                  setFrames([]);
                  setActiveName(createdName);
                }
              });
            }}
          >
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
                  <p className="pf-hint">Every frame needs a title, an outcome, a criterion and some HTML.</p>
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

export function Portfolio({ page, data, act, select, chooseTrack, track, preview }: PortfolioProps): ReactNode {
  const { busy, error, notice, run } = useAction(act);
  const counts = inboxCounts(data);
  const titles = { inbox: "Inbox", roadmap: "Roadmap", flows: "Flows" } as const;
  const subtitles = {
    inbox: `${counts.changes} pending contract edit${counts.changes === 1 ? "" : "s"} · ${counts.questions} open question${
      counts.questions === 1 ? "" : "s"
    }`,
    roadmap: `${data.releases.length} release${data.releases.length === 1 ? "" : "s"} · ${data.ranked.length} ranked outcome${
      data.ranked.length === 1 ? "" : "s"
    }`,
    flows: `${data.flows.length} flow${data.flows.length === 1 ? "" : "s"} · sandboxed HTML previews`,
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

      {page === "inbox" && <Inbox data={data} act={act} run={run} busy={busy} select={select} />}
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
        />
      )}
      {page === "flows" && <Flows data={data} act={act} run={run} busy={busy} select={select} />}
    </section>
  );
}

export default Portfolio;
