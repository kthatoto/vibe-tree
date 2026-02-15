import { useState, useEffect, useCallback } from "react";
import {
  api,
  type PlanningSession,
  type TaskInstruction,
  type TreeNode,
  type TreeEdge,
} from "../../lib/api";
import { useIsStreaming } from "../../lib/useStreamingState";
import { ChatPanel } from "../ChatPanel";
import ExecuteBranchSelector from "../ExecuteBranchSelector";
import ExecuteSidebar from "../ExecuteSidebar";
import type { TaskSuggestion } from "../../lib/task-parser";

interface ExecuteSessionViewProps {
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
  onWorktreeSelect: (branches?: string[]) => void;
  generatingTitle: boolean;
  onGenerateTitle: () => void;
  // Graph data for branch selector (passed from parent)
  graphNodes: TreeNode[];
  graphEdges: TreeEdge[];
  defaultBranch: string;
}

export function ExecuteSessionView({
  session,
  repoId,
  isActive: _isActive,
  sidebarWidth,
  sidebarFullscreen,
  onSidebarFullscreenChange,
  onResizeStart,
  onSessionUpdate: _onSessionUpdate,
  onSessionDelete,
  onTaskSuggested,
  onClaudeWorkingChange,
  onWorktreeSelect,
  generatingTitle,
  onGenerateTitle,
  graphNodes,
  graphEdges,
  defaultBranch,
}: ExecuteSessionViewProps) {
  // Session-specific state
  // Use global streaming state as single source of truth
  const claudeWorking = useIsStreaming(session.chatSessionId);
  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeEditMode, setExecuteEditMode] = useState(false);
  const [executeEditBranches, setExecuteEditBranches] = useState<string[]>([]);
  const [executeSelectedBranches, setExecuteSelectedBranches] = useState<string[]>([]);
  const [currentTaskInstruction, setCurrentTaskInstruction] = useState<TaskInstruction | null>(null);
  const [allTasksInstructions, setAllTasksInstructions] = useState<Array<{ branchName: string; instruction: string | null }>>([]);

  // Notify parent of claude working state
  useEffect(() => {
    onClaudeWorkingChange?.(session.id, claudeWorking);
  }, [session.id, claudeWorking, onClaudeWorkingChange]);

  // Initialize selected branches from session
  useEffect(() => {
    if (session.executeBranches && session.executeBranches.length > 0) {
      setExecuteSelectedBranches(session.executeBranches);
    } else {
      setExecuteSelectedBranches([]);
    }
  }, [session.id, session.executeBranches]);

  // Load current task instruction
  useEffect(() => {
    if (!session.executeBranches || session.executeBranches.length === 0) {
      setCurrentTaskInstruction(null);
      return;
    }

    const currentBranch = session.executeBranches[session.currentExecuteIndex ?? 0];
    if (!currentBranch) return;

    let cancelled = false;
    api.getTaskInstruction(repoId, currentBranch)
      .then((instruction) => {
        if (!cancelled) {
          setCurrentTaskInstruction(instruction);
        }
      })
      .catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [session.id, session.executeBranches, session.currentExecuteIndex, repoId]);

  // Load all task instructions
  useEffect(() => {
    if (!session.executeBranches || session.executeBranches.length === 0) {
      setAllTasksInstructions([]);
      return;
    }

    let cancelled = false;
    const loadAll = async () => {
      const instructions = await Promise.all(
        session.executeBranches!.map(async (branch) => {
          try {
            const inst = await api.getTaskInstruction(repoId, branch);
            return { branchName: branch, instruction: inst?.instructionMd || null };
          } catch {
            return { branchName: branch, instruction: null };
          }
        })
      );
      if (!cancelled) {
        setAllTasksInstructions(instructions);
      }
    };
    loadAll();

    return () => {
      cancelled = true;
    };
  }, [session.id, session.executeBranches, repoId]);

  // Handlers
  const handleTaskSuggestedInternal = useCallback((suggestion: TaskSuggestion) => {
    onTaskSuggested(suggestion);
  }, [onTaskSuggested]);

  const handleStartExecuteEdit = () => {
    setExecuteEditMode(true);
    setExecuteEditBranches(session.executeBranches || []);
  };

  const handleCancelExecuteEdit = () => {
    setExecuteEditMode(false);
    setExecuteEditBranches([]);
  };

  const handleSaveExecuteEdit = async () => {
    setExecuteLoading(true);
    try {
      await api.updateExecuteBranches(session.id, executeEditBranches);
      setExecuteEditMode(false);
    } catch (err) {
      console.error("Failed to save execute edit:", err);
    } finally {
      setExecuteLoading(false);
    }
  };

  const handleExecuteBranchesChange = (branches: string[]) => {
    setExecuteSelectedBranches(branches);
  };

  const handleStartExecution = () => {
    if (executeSelectedBranches.length === 0) return;
    // Trigger worktree selection dialog, passing selected branches
    onWorktreeSelect(executeSelectedBranches);
  };

  const handleManualBranchSwitch = (_index: number) => {
    // Note: API for updating currentExecuteIndex directly is not yet implemented
    // Branch switching is currently handled via preview mode in ExecuteSidebar
  };

  const handleBranchCompleted = async (_branchName: string) => {
    // Mark current branch as completed and move to next
    try {
      await api.advanceExecuteTask(session.id);
    } catch (err) {
      console.error("Failed to complete branch:", err);
    }
  };

  const isInProgress = session.executeBranches && session.executeBranches.length > 0;
  const executeStatus = isInProgress ? "in_progress" : "draft";
  const executeStatusLabel = isInProgress ? "In Progress" : "Draft";
  const currentBranch = session.executeBranches?.[session.currentExecuteIndex ?? 0];

  return (
    <div className="planning-panel__detail-content">
      {/* Header */}
      <div className="planning-panel__header">
        <span className="planning-panel__session-type planning-panel__session-type--execute">
          <span className="planning-panel__session-type-icon">⚡</span>
          Execute
        </span>
        <span className={`planning-panel__execute-status planning-panel__execute-status--${executeStatus}`}>
          {executeStatusLabel}
        </span>
        <span className={`planning-panel__header-title${!session.title ? " planning-panel__header-title--untitled" : ""}`}>
          {session.title || "Untitled Session"}
          {!executeEditMode && (
            <button
              className={`planning-panel__generate-title-btn${generatingTitle ? " planning-panel__generate-title-btn--loading" : ""}`}
              onClick={onGenerateTitle}
              disabled={generatingTitle}
              title="Generate title from conversation"
            >
              ↻
            </button>
          )}
        </span>
        {executeEditMode ? (
          <>
            <button
              className="planning-panel__cancel-btn"
              onClick={handleCancelExecuteEdit}
              disabled={executeLoading}
            >
              Cancel
            </button>
            <button
              className="planning-panel__save-btn"
              onClick={handleSaveExecuteEdit}
              disabled={executeLoading}
            >
              {executeLoading ? "Saving..." : "Save"}
            </button>
          </>
        ) : (
          <>
            <button
              className="planning-panel__edit-btn"
              onClick={handleStartExecuteEdit}
            >
              Edit
            </button>
            <button
              className="planning-panel__delete-btn"
              onClick={onSessionDelete}
              title="Delete this session"
            >
              Delete
            </button>
          </>
        )}
      </div>

      {/* Edit Mode - Target Branches */}
      {executeEditMode && (
        <div className="planning-panel__execute-edit">
          <ExecuteBranchSelector
            nodes={graphNodes}
            edges={graphEdges}
            defaultBranch={defaultBranch}
            selectedBranches={executeEditBranches}
            onSelectionChange={setExecuteEditBranches}
          />
        </div>
      )}

      {/* Branch Selection Mode (initial setup) */}
      {!executeEditMode && (!session.executeBranches || session.executeBranches.length === 0) && (
        <div className="planning-panel__execute-selection">
          <ExecuteBranchSelector
            nodes={graphNodes}
            edges={graphEdges}
            defaultBranch={defaultBranch}
            selectedBranches={executeSelectedBranches}
            onSelectionChange={handleExecuteBranchesChange}
            onStartExecution={handleStartExecution}
            executeLoading={executeLoading}
          />
        </div>
      )}

      {/* Execution Mode */}
      {!executeEditMode && session.executeBranches && session.executeBranches.length > 0 && (
        <div className={`planning-panel__detail-main ${sidebarFullscreen ? "planning-panel__detail-main--fullscreen" : ""}`}>
          {/* Chat - hidden when sidebar is fullscreen */}
          {!sidebarFullscreen && (
            <div className="planning-panel__chat">
              {/* Current branch indicator */}
              {currentBranch && (
                <div className="planning-panel__branch-indicator">
                  <span className="planning-panel__branch-indicator-label">
                    {claudeWorking ? "🤖 Working on:" : "📍 Current:"}
                  </span>
                  <span className="planning-panel__branch-indicator-name">
                    {currentBranch}
                  </span>
                  <span className="planning-panel__branch-indicator-hint">
                    Task {(session.currentExecuteIndex ?? 0) + 1} of {session.executeBranches.length}
                  </span>
                  {session.selectedWorktreePath && (
                    <button
                      className="planning-panel__worktree-btn"
                      onClick={() => onWorktreeSelect()}
                      title={`Worktree: ${session.selectedWorktreePath}`}
                    >
                      📁 {session.selectedWorktreePath.split("/").pop()}
                    </button>
                  )}
                </div>
              )}
              {session.chatSessionId && (
                <ChatPanel
                  sessionId={session.chatSessionId}
                  onTaskSuggested={handleTaskSuggestedInternal}
                  existingTaskLabels={session.nodes.map((n) => n.title)}
                  disabled={false}
                  executeMode={true}
                  executeContext={{
                    branchName: currentBranch || "",
                    instruction: currentTaskInstruction?.instructionMd || null,
                    taskIndex: session.currentExecuteIndex ?? 0,
                    totalTasks: session.executeBranches.length,
                    allTasks: allTasksInstructions.length > 0
                      ? allTasksInstructions
                      : session.executeBranches.map(b => ({ branchName: b, instruction: null })),
                  }}
                />
              )}
            </div>
          )}

          {/* Resizer */}
          {!sidebarFullscreen && (
            <div
              className="planning-panel__resizer"
              onMouseDown={onResizeStart}
            />
          )}

          {/* Sidebar */}
          <div
            className={`planning-panel__sidebar ${sidebarFullscreen ? "planning-panel__sidebar--fullscreen" : ""}`}
            style={sidebarFullscreen ? undefined : { width: sidebarWidth }}
          >
            <ExecuteSidebar
              repoId={repoId}
              executeBranches={session.executeBranches}
              currentExecuteIndex={session.currentExecuteIndex ?? 0}
              planningSessionId={session.id}
              onManualBranchSwitch={handleManualBranchSwitch}
              onBranchCompleted={handleBranchCompleted}
              workingBranch={claudeWorking ? currentBranch : null}
              onExpandToggle={() => onSidebarFullscreenChange(!sidebarFullscreen)}
              isExpanded={sidebarFullscreen}
              sessionType="execute"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default ExecuteSessionView;
