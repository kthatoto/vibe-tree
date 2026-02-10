import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type BranchLink, type TaskInstruction } from "../lib/api";
import { wsClient } from "../lib/ws";
import "./ExecuteBranchDetail.css";

interface ExecuteBranchDetailProps {
  repoId: string;
  branchName: string;
  isCurrent: boolean;
  onSwitchToBranch?: () => void;
}

export function ExecuteBranchDetail({
  repoId,
  branchName,
  isCurrent,
  onSwitchToBranch,
}: ExecuteBranchDetailProps) {
  const [links, setLinks] = useState<BranchLink[]>([]);
  const [instruction, setInstruction] = useState<TaskInstruction | null>(null);
  const [loading, setLoading] = useState(true);

  // Load branch links and instruction
  useEffect(() => {
    if (!repoId || !branchName) return;
    setLoading(true);

    Promise.all([
      api.getBranchLinks(repoId, branchName).catch(() => []),
      api.getTaskInstruction(repoId, branchName).catch(() => null),
    ])
      .then(([branchLinks, taskInstruction]) => {
        setLinks(branchLinks);
        setInstruction(taskInstruction);
      })
      .finally(() => setLoading(false));
  }, [repoId, branchName]);

  // Subscribe to real-time PR updates
  useEffect(() => {
    if (!repoId || !branchName) return;

    const unsubLinkUpdated = wsClient.on("branchLink.updated", (msg) => {
      const data = msg.data as { branchName: string; linkType: string; [key: string]: unknown };
      if (data.branchName === branchName) {
        // Refetch links when our branch's link is updated
        api.getBranchLinks(repoId, branchName).then(setLinks).catch(() => {});
      }
    });

    return () => {
      unsubLinkUpdated();
    };
  }, [repoId, branchName]);

  const prLink = links.find((l) => l.linkType === "pr");
  const issueLink = links.find((l) => l.linkType === "issue");

  const getChecksStatusColor = (status: string | null) => {
    switch (status) {
      case "success":
        return "success";
      case "failure":
        return "failure";
      case "pending":
        return "pending";
      default:
        return "unknown";
    }
  };

  const getReviewDecisionColor = (decision: string | null) => {
    switch (decision) {
      case "APPROVED":
        return "approved";
      case "CHANGES_REQUESTED":
        return "changes-requested";
      case "REVIEW_REQUIRED":
        return "review-required";
      default:
        return "none";
    }
  };

  if (loading) {
    return (
      <div className="execute-branch-detail execute-branch-detail--loading">
        <div className="execute-branch-detail__spinner" />
      </div>
    );
  }

  return (
    <div className="execute-branch-detail">
      {/* Branch Name Header */}
      <div className="execute-branch-detail__header">
        <span className="execute-branch-detail__branch-name">{branchName}</span>
        {isCurrent ? (
          <span className="execute-branch-detail__current-badge">Current</span>
        ) : (
          onSwitchToBranch && (
            <button
              className="execute-branch-detail__switch-btn"
              onClick={onSwitchToBranch}
            >
              Switch to this branch
            </button>
          )
        )}
      </div>

      {/* PR/Issue Info */}
      {(prLink || issueLink) && (
        <div className="execute-branch-detail__links">
          {prLink && (
            <div className="execute-branch-detail__pr">
              <a
                href={prLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="execute-branch-detail__pr-link"
              >
                PR #{prLink.number}
              </a>
              {prLink.checksStatus && (
                <span
                  className={`execute-branch-detail__checks execute-branch-detail__checks--${getChecksStatusColor(prLink.checksStatus)}`}
                >
                  {prLink.checksStatus === "success" ? "✓" : prLink.checksStatus === "failure" ? "✕" : "◌"} CI
                </span>
              )}
              {prLink.reviewDecision && (
                <span
                  className={`execute-branch-detail__review execute-branch-detail__review--${getReviewDecisionColor(prLink.reviewDecision)}`}
                >
                  {prLink.reviewDecision === "APPROVED" ? "✓ Approved" :
                    prLink.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" :
                      "Review required"}
                </span>
              )}
              {/* Reviewers */}
              {(() => {
                const reviewers: string[] = prLink.reviewers
                  ? (() => { try { return JSON.parse(prLink.reviewers) } catch { return [] } })()
                  : [];
                return reviewers.length > 0 ? (
                  <span className="execute-branch-detail__reviewers">
                    {reviewers.map((r, i) => (
                      <span key={i} className="execute-branch-detail__reviewer">@{r}</span>
                    ))}
                  </span>
                ) : null;
              })()}
            </div>
          )}
          {issueLink && (
            <div className="execute-branch-detail__issue">
              <a
                href={issueLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="execute-branch-detail__issue-link"
              >
                Issue #{issueLink.number}
              </a>
              {issueLink.title && (
                <span className="execute-branch-detail__issue-title">
                  {issueLink.title}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Instruction */}
      <div className="execute-branch-detail__instruction">
        <div className="execute-branch-detail__instruction-header">
          <h4>Instruction</h4>
        </div>
        <div className="execute-branch-detail__instruction-content">
          {instruction?.instructionMd ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {instruction.instructionMd}
            </ReactMarkdown>
          ) : (
            <span className="execute-branch-detail__no-instruction">
              No instruction set for this branch
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default ExecuteBranchDetail;
