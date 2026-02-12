import { useState, useEffect, useCallback } from "react";
import {
  api,
  type PlanningSession,
  type TaskInstruction,
  type TreeNode,
  type TreeEdge,
} from "../../lib/api";
import { wsClient } from "../../lib/ws";
import { useIsStreaming } from "../../lib/useStreamingState";
import { ChatPanel } from "../ChatPanel";
import ExecuteBranchSelector from "../ExecuteBranchSelector";
import ExecuteSidebar from "../ExecuteSidebar";
import type { TaskSuggestion } from "../../lib/task-parser";

interface PlanningSessionViewProps {
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
  generatingTitle: boolean;
  onGenerateTitle: () => void;
  // Graph data for branch selector (passed from parent)
  graphNodes: TreeNode[];
  graphEdges: TreeEdge[];
  defaultBranch: string;
}

export function PlanningSessionView({
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
  generatingTitle,
  onGenerateTitle,
  graphNodes,
  graphEdges,
  defaultBranch,
}: PlanningSessionViewProps) {
  // Session-specific state
  // Use global streaming state as single source of truth
  const claudeWorking = useIsStreaming(session.chatSessionId);
  const [planningLoading, setPlanningLoading] = useState(false);
  const [executeEditMode, setExecuteEditMode] = useState(false);
  const [executeEditBranches, setExecuteEditBranches] = useState<string[]>([]);
  const [planningSelectedBranches, setPlanningSelectedBranches] = useState<string[]>([]);
  const [planningCurrentBranchIndex, setPlanningCurrentBranchIndex] = useState(0);
  const [userViewBranchIndex, setUserViewBranchIndex] = useState(0);
  const [_currentInstruction, setCurrentInstruction] = useState<TaskInstruction | null>(null);

  // Notify parent of claude working state
  useEffect(() => {
    onClaudeWorkingChange?.(session.id, claudeWorking);
  }, [session.id, claudeWorking, onClaudeWorkingChange]);

  // Initialize branches from session
  useEffect(() => {
    if (session.executeBranches && session.executeBranches.length > 0) {
      setPlanningSelectedBranches(session.executeBranches);
      setPlanningCurrentBranchIndex(session.currentExecuteIndex ?? 0);
      setUserViewBranchIndex(session.currentExecuteIndex ?? 0);
    } else {
      setPlanningSelectedBranches([]);
      setPlanningCurrentBranchIndex(0);
      setUserViewBranchIndex(0);
    }
  }, [session.id, session.executeBranches, session.currentExecuteIndex]);

  // Load current branch instruction
  useEffect(() => {
    const planningBranches = session.executeBranches || [];
    if (planningBranches.length === 0) {
      setCurrentInstruction(null);
      return;
    }

    const currentBranch = planningBranches[userViewBranchIndex];
    if (!currentBranch) return;

    let cancelled = false;
    api.getTaskInstruction(repoId, currentBranch)
      .then((instruction) => {
        if (!cancelled) {
          setCurrentInstruction(instruction);
        }
      })
      .catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [session.id, session.executeBranches, userViewBranchIndex, repoId]);

  // Subscribe to branch advance events from MCP
  useEffect(() => {
    if (!session.id) return;

    const unsubAdvance = wsClient.on("planning.taskAdvanced", (msg) => {
      const data = msg.data as { planningSessionId: string; newIndex: number };
      if (data.planningSessionId === session.id) {
        setPlanningCurrentBranchIndex(data.newIndex);
      }
    });

    return () => {
      unsubAdvance();
    };
  }, [session.id]);

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
    setPlanningLoading(true);
    try {
      await api.updateExecuteBranches(session.id, executeEditBranches);
      setExecuteEditMode(false);
    } catch (err) {
      console.error("Failed to save planning edit:", err);
    } finally {
      setPlanningLoading(false);
    }
  };

  const handlePlanningBranchesChange = (branches: string[]) => {
    setPlanningSelectedBranches(branches);
  };

  const handleStartPlanning = async () => {
    if (planningSelectedBranches.length === 0) return;
    setPlanningLoading(true);
    try {
      await api.updateExecuteBranches(session.id, planningSelectedBranches);
    } catch (err) {
      console.error("Failed to start planning:", err);
    } finally {
      setPlanningLoading(false);
    }
  };

  const handlePlanningBranchSwitch = (index: number) => {
    setUserViewBranchIndex(index);
  };

  const handleFinalizePlanning = async () => {
    setPlanningLoading(true);
    try {
      await api.confirmPlanningSession(session.id);
    } catch (err) {
      console.error("Failed to finalize planning:", err);
    } finally {
      setPlanningLoading(false);
    }
  };

  const planningBranches = session.executeBranches || [];
  const hasBranches = planningBranches.length > 0;
  const planningStatus = hasBranches ? "in_progress" : "draft";
  const planningStatusLabel = hasBranches ? "In Progress" : "Draft";
  const currentPlanningBranch = hasBranches ? planningBranches[userViewBranchIndex] : null;

  return (
    <div className="planning-panel__detail-content">
      {/* Header */}
      <div className="planning-panel__header">
        <span className="planning-panel__session-type planning-panel__session-type--planning">
          <span className="planning-panel__session-type-icon">📋</span>
          Planning
        </span>
        <span className={`planning-panel__execute-status planning-panel__execute-status--${planningStatus}`}>
          {planningStatusLabel}
        </span>
        <span className={`planning-panel__header-title${!session.title ? " planning-panel__header-title--untitled" : ""}`}>
          {session.title || "Untitled Session"}
          <button
            className={`planning-panel__generate-title-btn${generatingTitle ? " planning-panel__generate-title-btn--loading" : ""}`}
            onClick={onGenerateTitle}
            disabled={generatingTitle}
            title="Generate title from conversation"
          >
            ↻
          </button>
        </span>
        {executeEditMode ? (
          <>
            <button
              className="planning-panel__cancel-btn"
              onClick={handleCancelExecuteEdit}
              disabled={planningLoading}
            >
              Cancel
            </button>
            <button
              className="planning-panel__save-btn"
              onClick={handleSaveExecuteEdit}
              disabled={planningLoading}
            >
              {planningLoading ? "Saving..." : "Save"}
            </button>
          </>
        ) : (
          <>
            {hasBranches && session.status !== "confirmed" && (
              <button
                className="planning-panel__finalize-btn"
                onClick={handleFinalizePlanning}
                title="Finalize planning session"
              >
                Finalize
              </button>
            )}
            {session.status === "confirmed" && (
              <span className="planning-panel__finalized-badge">Finalized</span>
            )}
            {hasBranches && (
              <button
                className="planning-panel__edit-btn"
                onClick={handleStartExecuteEdit}
              >
                Edit
              </button>
            )}
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
      {!executeEditMode && !hasBranches && (
        <div className="planning-panel__execute-selection">
          <ExecuteBranchSelector
            nodes={graphNodes}
            edges={graphEdges}
            defaultBranch={defaultBranch}
            selectedBranches={planningSelectedBranches}
            onSelectionChange={handlePlanningBranchesChange}
            onStartExecution={handleStartPlanning}
            executeLoading={planningLoading}
          />
        </div>
      )}

      {/* Planning Mode */}
      {!executeEditMode && hasBranches && (
        <div className={`planning-panel__detail-main ${sidebarFullscreen ? "planning-panel__detail-main--fullscreen" : ""}`}>
          {/* Chat - hidden when sidebar is fullscreen */}
          {!sidebarFullscreen && (
            <div className="planning-panel__chat">
              {/* Current branch indicator */}
              {currentPlanningBranch && (
                <div className="planning-panel__branch-indicator">
                  <span className="planning-panel__branch-indicator-label">
                    {claudeWorking ? "🤖 Working on:" : "📍 Focused:"}
                  </span>
                  <span className="planning-panel__branch-indicator-name">
                    {currentPlanningBranch}
                  </span>
                  <span className="planning-panel__branch-indicator-hint">
                    Chat messages will reference this branch
                  </span>
                </div>
              )}
              {session.chatSessionId && (
                <ChatPanel
                  sessionId={session.chatSessionId}
                  onTaskSuggested={handleTaskSuggestedInternal}
                  existingTaskLabels={session.nodes.map((n) => n.title)}
                  disabled={false}
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
              executeBranches={planningBranches}
              currentExecuteIndex={userViewBranchIndex}
              planningSessionId={session.id}
              onManualBranchSwitch={handlePlanningBranchSwitch}
              workingBranch={claudeWorking ? planningBranches[planningCurrentBranchIndex] : null}
              sessionType="planning"
              onExpandToggle={() => onSidebarFullscreenChange(!sidebarFullscreen)}
              isExpanded={sidebarFullscreen}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default PlanningSessionView;
