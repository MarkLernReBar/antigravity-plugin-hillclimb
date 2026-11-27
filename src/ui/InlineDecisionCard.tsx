import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { Action } from "../actions.js";
import type { Change, Comment, Outcome } from "../model.js";
import { contractDiff, contractOf } from "./OutcomeDrawer.js";

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
    };

export interface InlineDecisionCardProps {
  decision: InlineDecisionPayload;
  canNotifyThread: boolean;
  onAct: (projectId: string, action: Action) => Promise<void>;
  onRefreshState: (
    projectId: string,
    kind: "change" | "question",
    id: string,
  ) => Promise<{ change?: Change | null; currentOutcome?: Outcome | null; comment?: Comment | null }>;
  onNotifyThread: (text: string) => Promise<boolean>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function InlineDecisionCard(props: InlineDecisionCardProps): JSX.Element {
  const { decision, canNotifyThread, onAct, onRefreshState, onNotifyThread } = props;
  const [changeState, setChangeState] = useState<Change | null>(decision.kind === "change" ? decision.change : null);
  const [currentOutcome, setCurrentOutcome] = useState<Outcome | null>(
    decision.kind === "change" ? decision.currentOutcome : null,
  );
  const [commentState, setCommentState] = useState<Comment | null>(
    decision.kind === "question" ? decision.comment : null,
  );
  const [customAnswer, setCustomAnswer] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threadNote, setThreadNote] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setThreadNote(null);
    if (decision.kind === "change") {
      setChangeState(decision.change);
      setCurrentOutcome(decision.currentOutcome);
      setCommentState(null);
    } else {
      setCommentState(decision.comment);
      setChangeState(null);
      setCurrentOutcome(null);
    }
  }, [decision]);

  // Sync live state once on mount so scrolling back in history reflects decisions made in the Decisions tab.
  useEffect(() => {
    let alive = true;
    const id = decision.kind === "change" ? decision.change.id : decision.comment.id;
    void onRefreshState(decision.projectId, decision.kind, id)
      .then((res) => {
        if (!alive) return;
        if (decision.kind === "change" && res.change) {
          setChangeState(res.change);
          if (res.currentOutcome !== undefined) setCurrentOutcome(res.currentOutcome);
        } else if (decision.kind === "question" && res.comment) {
          setCommentState(res.comment);
        }
      })
      .catch(() => {
        // Keep initial snapshot if offline or stale server
      });
    return () => {
      alive = false;
    };
  }, [decision, onRefreshState]);

  const diffRows = useMemo(() => {
    if (!changeState || changeState.kind === "create" || !currentOutcome) return [];
    return contractDiff(contractOf(currentOutcome), changeState.proposed).filter((row) => row.kind !== "same");
  }, [changeState, currentOutcome]);

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
