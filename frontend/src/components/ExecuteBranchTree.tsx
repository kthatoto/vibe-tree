import type { BranchLink, InstructionConfirmationStatus } from "../lib/api";
import { getResourceIcon } from "../lib/resourceIcons";
import "./ExecuteBranchTree.css";

interface QuestionCounts {
  total: number;
  pending: number;      // Unanswered
  answered: number;     // Answered but not acknowledged
  acknowledged: number; // Answered and acknowledged
}

interface ResourceCounts {
  figma: number;
  githubIssue: number;
  notion: number;
  other: number;  // url, etc.
  files: number;
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
  branchResourceCounts?: Map<string, ResourceCounts>;
  branchInstructionStatus?: Map<string, InstructionConfirmationStatus>;
  showCompletionCount?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  onExpandToggle?: () => void;
  isExpanded?: boolean;
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
  branchResourceCounts = new Map(),
  branchInstructionStatus = new Map(),
  showCompletionCount = true,
  onRefresh,
  isRefreshing = false,
  onExpandToggle,
  isExpanded = false,
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
        <div className="execute-branch-tree__header-buttons">
          {onRefresh && (
            <button
              className="execute-branch-tree__refresh-btn"
              onClick={onRefresh}
              disabled={isRefreshing}
              title="Refresh all PR info from GitHub"
            >
              {isRefreshing ? "..." : "↻"}
            </button>
          )}
          {onExpandToggle && (
            <button
              className="execute-branch-tree__expand-btn"
              onClick={onExpandToggle}
              title={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
            >
              {isExpanded ? "→" : "←"}
            </button>
          )}
        </div>
      </div>
      <div className="execute-branch-tree__list">
        {branches.map((branch, index) => {
          const completionStatus = getCompletionStatus(branch);
          const isSelected = index === selectedBranchIndex;
          const isAiWorking = aiBranchIndex !== null && index === aiBranchIndex;
          const todoCount = branchTodoCounts.get(branch);
          const questionCount = branchQuestionCounts.get(branch);
          const resourceCount = branchResourceCounts.get(branch);
          const instructionStatus = branchInstructionStatus.get(branch);
          const links = branchLinks.get(branch) || [];
          const prLink = links.find(l => l.linkType === "pr");
          const hasTodos = todoCount && todoCount.total > 0;
          const hasQuestions = questionCount && questionCount.total > 0;
          const hasFigma = resourceCount && resourceCount.figma > 0;
          const hasGithubIssue = resourceCount && resourceCount.githubIssue > 0;
          const hasNotion = resourceCount && resourceCount.notion > 0;
          const hasOtherResources = resourceCount && (resourceCount.other > 0 || resourceCount.files > 0);
          const hasPR = !!prLink;

          return (
            <div
              key={branch}
              className={`execute-branch-tree__item execute-branch-tree__item--${completionStatus} ${isSelected ? "execute-branch-tree__item--selected" : ""} ${isAiWorking ? "execute-branch-tree__item--ai-working" : ""}`}
              onClick={() => onBranchSelect(branch, index)}
            >
              {/* Row 1: Branch name */}
              <div className="execute-branch-tree__row">
                <span className={`execute-branch-tree__status ${isSelected ? "execute-branch-tree__status--selected" : ""} ${isAiWorking ? "execute-branch-tree__status--ai" : ""} execute-branch-tree__status--${completionStatus} ${instructionStatus ? `execute-branch-tree__status--instruction-${instructionStatus}` : ""}`}>
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
              {/* Row 2: All badges (PR, Issue, ToDo, Question, Resources) */}
              {(hasPR || hasTodos || hasQuestions || hasFigma || hasGithubIssue || hasNotion || hasOtherResources) && (
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
                  {/* External links group */}
                  {(hasFigma || hasGithubIssue || hasNotion || hasOtherResources) && (
                    <span className="execute-branch-tree__links-group">
                      {hasFigma && (() => {
                        const icon = getResourceIcon("figma");
                        return (
                          <span className="execute-branch-tree__link-item">
                            <img src={icon.src} alt={icon.alt} className={`execute-branch-tree__link-icon execute-branch-tree__link-icon${icon.className}`} />
                            <span className="execute-branch-tree__link-count">{resourceCount!.figma}</span>
                          </span>
                        );
                      })()}
                      {hasGithubIssue && (() => {
                        const icon = getResourceIcon("github_issue");
                        return (
                          <span className="execute-branch-tree__link-item">
                            <img src={icon.src} alt={icon.alt} className={`execute-branch-tree__link-icon execute-branch-tree__link-icon${icon.className}`} />
                            <span className="execute-branch-tree__link-count">{resourceCount!.githubIssue}</span>
                          </span>
                        );
                      })()}
                      {hasNotion && (() => {
                        const icon = getResourceIcon("notion");
                        return (
                          <span className="execute-branch-tree__link-item">
                            <img src={icon.src} alt={icon.alt} className={`execute-branch-tree__link-icon execute-branch-tree__link-icon${icon.className}`} />
                            <span className="execute-branch-tree__link-count">{resourceCount!.notion}</span>
                          </span>
                        );
                      })()}
                      {hasOtherResources && (
                        <span className="execute-branch-tree__link-item">
                          <span className="execute-branch-tree__link-icon execute-branch-tree__link-icon--other">📎</span>
                          <span className="execute-branch-tree__link-count">{(resourceCount?.other || 0) + (resourceCount?.files || 0)}</span>
                        </span>
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
