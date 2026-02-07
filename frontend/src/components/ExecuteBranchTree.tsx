import "./ExecuteBranchTree.css";

interface ExecuteBranchTreeProps {
  branches: string[];
  currentBranchIndex: number;
  previewBranch: string | null;
  onPreviewBranch: (branch: string) => void;
  completedBranches: Set<string>;
  branchTodoCounts?: Map<string, { total: number; completed: number }>;
  branchQuestionCounts?: Map<string, { total: number; pending: number }>;
}

export function ExecuteBranchTree({
  branches,
  currentBranchIndex,
  previewBranch,
  onPreviewBranch,
  completedBranches,
  branchTodoCounts = new Map(),
  branchQuestionCounts = new Map(),
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
        <h4>Branches</h4>
        <span className="execute-branch-tree__count">
          {completedBranches.size}/{branches.length}
        </span>
      </div>
      <div className="execute-branch-tree__list">
        {branches.map((branch, index) => {
          const status = getBranchStatus(branch, index);
          const isPreview = branch === previewBranch;
          const todoCount = branchTodoCounts.get(branch);
          const questionCount = branchQuestionCounts.get(branch);
          const hasTodos = todoCount && todoCount.total > 0;
          const hasQuestions = questionCount && questionCount.total > 0;

          return (
            <div
              key={branch}
              className={`execute-branch-tree__item execute-branch-tree__item--${status} ${isPreview ? "execute-branch-tree__item--preview" : ""}`}
              onClick={() => onPreviewBranch(branch)}
            >
              <span className={`execute-branch-tree__status execute-branch-tree__status--${status}`}>
                {getStatusIcon(status)}
              </span>
              <span className="execute-branch-tree__name" title={branch}>
                {branch}
              </span>
              <span className="execute-branch-tree__badges">
                {hasTodos && (
                  <span className="execute-branch-tree__badge execute-branch-tree__badge--todo" title="ToDo">
                    📋 {todoCount.completed}/{todoCount.total}
                  </span>
                )}
                {hasQuestions && (
                  <span className={`execute-branch-tree__badge execute-branch-tree__badge--question ${questionCount.pending > 0 ? "execute-branch-tree__badge--pending" : ""}`} title="Questions">
                    ❓ {questionCount.pending > 0 ? questionCount.pending : "✓"}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ExecuteBranchTree;
