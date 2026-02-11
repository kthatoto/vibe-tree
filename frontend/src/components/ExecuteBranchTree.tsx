import type { BranchLink } from "../lib/api";
import "./ExecuteBranchTree.css";

interface QuestionCounts {
  total: number;
  pending: number;      // Unanswered
  answered: number;     // Answered but not acknowledged
  acknowledged: number; // Answered and acknowledged
}

interface ExecuteBranchTreeProps {
  branches: string[];
  selectedBranchIndex: number; // User's selected branch (blue)
  aiBranchIndex?: number | null; // AI's working branch (purple + robot)
  onBranchSelect: (branch: string, index: number) => void;
  completedBranches: Set<string>;
  branchTodoCounts?: Map<string, { total: number; completed: number }>;
  branchQuestionCounts?: Map<string, QuestionCounts>;
  branchLinks?: Map<string, BranchLink[]>;
  showCompletionCount?: boolean;
}

export function ExecuteBranchTree({
  branches,
  selectedBranchIndex,
  aiBranchIndex = null,
  onBranchSelect,
  completedBranches,
  branchTodoCounts = new Map(),
  branchQuestionCounts = new Map(),
  branchLinks = new Map(),
  showCompletionCount = true,
}: ExecuteBranchTreeProps) {
  // Determine branch completion status
  const getCompletionStatus = (branch: string): "completed" | "pending" => {
    if (completedBranches.has(branch)) return "completed";
    return "pending";
  };

  return (
    <div className="execute-branch-tree">
      <div className="execute-branch-tree__header">
        <h4>
          {showCompletionCount
            ? `${completedBranches.size}/${branches.length} Branches`
            : `${branches.length} Branches`}
        </h4>
      </div>
      <div className="execute-branch-tree__list">
        {branches.map((branch, index) => {
          const completionStatus = getCompletionStatus(branch);
          const isSelected = index === selectedBranchIndex;
          const isAiWorking = aiBranchIndex !== null && index === aiBranchIndex;
          const todoCount = branchTodoCounts.get(branch);
          const questionCount = branchQuestionCounts.get(branch);
          const links = branchLinks.get(branch) || [];
          const prLink = links.find(l => l.linkType === "pr");
          const hasTodos = todoCount && todoCount.total > 0;
          const hasQuestions = questionCount && questionCount.total > 0;
          const hasPR = !!prLink;

          return (
            <div
              key={branch}
              className={`execute-branch-tree__item execute-branch-tree__item--${completionStatus} ${isSelected ? "execute-branch-tree__item--selected" : ""} ${isAiWorking ? "execute-branch-tree__item--ai-working" : ""}`}
              onClick={() => onBranchSelect(branch, index)}
            >
              {/* Row 1: Branch name */}
              <div className="execute-branch-tree__row">
                <span className={`execute-branch-tree__status ${isSelected ? "execute-branch-tree__status--selected" : ""} ${isAiWorking ? "execute-branch-tree__status--ai" : ""} execute-branch-tree__status--${completionStatus}`}>
                  {completionStatus === "completed" ? "✓" : isSelected ? "●" : "○"}
                </span>
                <span className="execute-branch-tree__name" title={branch}>
                  {branch}
                </span>
                {isAiWorking && (
                  <span className="execute-branch-tree__ai-indicator" title="Claude is working on this">
                    <span className="execute-branch-tree__robot">🤖</span>
                  </span>
                )}
              </div>
              {/* Row 2: All badges (PR, Issue, ToDo, Question) */}
              {(hasPR || hasTodos || hasQuestions) && (
                <div className="execute-branch-tree__badges-row">
                  {/* PR badge */}
                  {hasPR && (
                    <a
                      href={prLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="execute-branch-tree__pr-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      PR #{prLink.number}
                      {prLink.checksStatus === "success" && <span className="execute-branch-tree__ci execute-branch-tree__ci--success">✔</span>}
                      {prLink.checksStatus === "failure" && <span className="execute-branch-tree__ci execute-branch-tree__ci--failure">✗</span>}
                      {prLink.checksStatus === "pending" && <span className="execute-branch-tree__ci execute-branch-tree__ci--pending">◌</span>}
                    </a>
                  )}
                  {/* Review status */}
                  {hasPR && prLink.reviewDecision === "APPROVED" && (
                    <span className="execute-branch-tree__review execute-branch-tree__review--approved">Approved</span>
                  )}
                  {hasPR && prLink.reviewDecision === "CHANGES_REQUESTED" && (
                    <span className="execute-branch-tree__review execute-branch-tree__review--changes">Changes</span>
                  )}
                  {hasPR && (prLink.reviewDecision === "REVIEW_REQUIRED" || (!prLink.reviewDecision && prLink.reviewers && (() => {
                    const reviewers = JSON.parse(prLink.reviewers) as string[];
                    // Exclude GitHub Copilot from reviewers
                    const humanReviewers = reviewers.filter(r => !r.toLowerCase().includes("copilot") && !r.endsWith("[bot]"));
                    return humanReviewers.length > 0;
                  })())) && (
                    <span className="execute-branch-tree__review execute-branch-tree__review--requested">Review</span>
                  )}
                  {/* ToDo badge */}
                  {hasTodos && (
                    <span className="execute-branch-tree__badge execute-branch-tree__badge--todo">
                      📋 {todoCount.completed}/{todoCount.total}
                    </span>
                  )}
                  {/* Question badge */}
                  {hasQuestions && (
                    <span
                      className={`execute-branch-tree__badge execute-branch-tree__badge--question ${
                        questionCount.pending > 0
                          ? "execute-branch-tree__badge--q-pending"
                          : questionCount.answered > 0
                          ? "execute-branch-tree__badge--q-answered"
                          : "execute-branch-tree__badge--q-done"
                      }`}
                    >
                      {questionCount.pending > 0 ? (
                        <>❓ {questionCount.pending}</>
                      ) : questionCount.answered > 0 ? (
                        <>💬 {questionCount.answered}</>
                      ) : (
                        <>✅ {questionCount.acknowledged}</>
                      )}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ExecuteBranchTree;
