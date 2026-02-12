import { type PlanningSession, type TreeNode, type TreeEdge } from "../lib/api";
import type { TaskSuggestion } from "../lib/task-parser";
import { RefinementSessionView } from "./sessions/RefinementSessionView";
import { ExecuteSessionView } from "./sessions/ExecuteSessionView";
import { PlanningSessionView } from "./sessions/PlanningSessionView";
import "./SessionDetail.css";

export interface SessionDetailProps {
  session: PlanningSession;
  repoId: string;
  isActive: boolean;
  sidebarWidth: number;
  sidebarFullscreen: boolean;
  onSidebarWidthChange: (width: number) => void;
  onSidebarFullscreenChange: (fullscreen: boolean) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  onSessionUpdate: (updates: Partial<PlanningSession>) => void;
  onSessionDelete: () => void;
  onTaskSuggested: (suggestion: TaskSuggestion) => void;
  onClaudeWorkingChange?: (sessionId: string, working: boolean) => void;
  onWorktreeSelect: () => void;
  generatingTitle: boolean;
  onGenerateTitle: () => void;
  // Graph data for branch selector
  graphNodes: TreeNode[];
  graphEdges: TreeEdge[];
  defaultBranch: string;
}

/**
 * SessionDetail - Container for individual session content
 *
 * Each session has its own independent instance of this component.
 * State is preserved across tab switches because components are hidden (display:none)
 * rather than unmounted.
 */
export function SessionDetail({
  session,
  repoId,
  isActive,
  sidebarWidth,
  sidebarFullscreen,
  onSidebarWidthChange,
  onSidebarFullscreenChange,
  onResizeStart,
  onSessionUpdate,
  onSessionDelete,
  onTaskSuggested,
  onClaudeWorkingChange,
  onWorktreeSelect,
  generatingTitle,
  onGenerateTitle,
  graphNodes,
  graphEdges,
  defaultBranch,
}: SessionDetailProps) {
  // Common props for all session views
  const commonProps = {
    session,
    repoId,
    isActive,
    sidebarWidth,
    sidebarFullscreen,
    onSidebarWidthChange,
    onSidebarFullscreenChange,
    onResizeStart,
    onSessionUpdate,
    onSessionDelete,
    onTaskSuggested,
    onClaudeWorkingChange,
    generatingTitle,
    onGenerateTitle,
    graphNodes,
    graphEdges,
    defaultBranch,
  };

  return (
    <div
      className={`session-detail ${isActive ? "session-detail--active" : ""}`}
      style={{ display: isActive ? "flex" : "none" }}
      data-session-id={session.id}
      data-session-type={session.type}
    >
      {session.type === "execute" && (
        <ExecuteSessionView
          {...commonProps}
          onWorktreeSelect={onWorktreeSelect}
        />
      )}
      {session.type === "planning" && (
        <PlanningSessionView {...commonProps} />
      )}
      {session.type === "refinement" && (
        <RefinementSessionView {...commonProps} />
      )}
    </div>
  );
}

export default SessionDetail;
