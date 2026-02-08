import "./ExecuteBranchTree.css";

interface QuestionCounts {
  total: number;
  pending: number;      // Unanswered
  answered: number;     // Answered but not acknowledged
  acknowledged: number; // Answered and acknowledged
}

interface ExecuteBranchTreeProps {
  branches: string[];
  currentBranchIndex: number;
  previewBranch: string | null;
  onPreviewBranch: (branch: string) => void;
  completedBranches: Set<string>;
  branchTodoCounts?: Map<string, { total: number; completed: number }>;
  branchQuestionCounts?: Map<string, QuestionCounts>;
  workingBranch?: string | null;
  showCompletionCount?: boolean;
}

export function ExecuteBranchTree({
  branches,
  currentBranchIndex,
  previewBranch,
  onPreviewBranch,
  completedBranches,
  branchTodoCounts = new Map(),
  branchQuestionCounts = new Map(),
  workingBranch = null,
  showCompletionCount = true,
}: ExecuteBranchTreeProps) {
  // Determine branch status
  const getBranchStatus = (branch: string, index: number): "completed" | "current" | "pending" => {
    if (completedBranches.has(branch)) return "completed";
    if (index === currentBranchIndex) return "current";
    return "pending";
  };

  const getStatusIcon = (status: "completed" | "current" | "pending") => {
    switch (status) {
      case "completed":
        return "✓";
      case "current":
        return "●";
      default:
        return "○";
    }
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
          const status = getBranchStatus(branch, index);
          const isPreview = branch === previewBranch;
          const isWorking = branch === workingBranch;
          const todoCount = branchTodoCounts.get(branch);
          const questionCount = branchQuestionCounts.get(branch);
          const hasTodos = todoCount && todoCount.total > 0;
          const hasQuestions = questionCount && questionCount.total > 0;

          return (
            <div
              key={branch}
              className={`execute-branch-tree__item execute-branch-tree__item--${status} ${isPreview ? "execute-branch-tree__item--preview" : ""} ${isWorking ? "execute-branch-tree__item--working" : ""}`}
              onClick={() => onPreviewBranch(branch)}
            >
              <div className="execute-branch-tree__row">
                <span className={`execute-branch-tree__status execute-branch-tree__status--${status}`}>
                  {getStatusIcon(status)}
                </span>
                <span className="execute-branch-tree__name" title={branch}>
                  {branch}
                </span>
                {isWorking && (
                  <span className="execute-branch-tree__working-indicator" title="Claude is working on this">
                    <span className="execute-branch-tree__robot">🤖</span>
                  </span>
                )}
              </div>
              {(hasTodos || hasQuestions) && (
                <div className="execute-branch-tree__badges">
                  {hasTodos && (
                    <span className="execute-branch-tree__badge execute-branch-tree__badge--todo" title="ToDo">
                      📋 {todoCount.completed}/{todoCount.total}
                    </span>
                  )}
                  {hasQuestions && (
                    <span
                      className={`execute-branch-tree__badge execute-branch-tree__badge--question ${
                        questionCount.pending > 0
                          ? "execute-branch-tree__badge--q-pending"
                          : questionCount.answered > 0
                          ? "execute-branch-tree__badge--q-answered"
                          : "execute-branch-tree__badge--q-done"
                      }`}
                      title={
                        questionCount.pending > 0
                          ? `${questionCount.pending} unanswered`
                          : questionCount.answered > 0
                          ? `${questionCount.answered} awaiting AI`
                          : "All acknowledged"
                      }
                    >
                      {questionCount.pending > 0 ? (
                        <>❓ {questionCount.pending}</>
                      ) : questionCount.answered > 0 ? (
                        <>💬 {questionCount.answered}</>
                      ) : (
                        <>✅ {questionCount.acknowledged}/{questionCount.total}</>
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
