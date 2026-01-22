import { useState, useEffect, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  api,
  type PlanningSession,
  type TaskNode,
  type TaskEdge,
  type ExternalLink,
  type ChatMessage,
  type TreeNode,
  type TreeEdge,
  type TaskInstruction,
} from "../lib/api";
import { wsClient } from "../lib/ws";
import { useSessionNotifications } from "../lib/useSessionNotifications";
import { ChatPanel } from "./ChatPanel";
import ExecuteBranchSelector from "./ExecuteBranchSelector";
import type { TaskSuggestion } from "../lib/task-parser";
import githubIcon from "../assets/github.svg";
import notionIcon from "../assets/notion.svg";
import figmaIcon from "../assets/figma.svg";
import linkIcon from "../assets/link.svg";
import "./PlanningPanel.css";

// Draggable task item component
function DraggableTaskItem({
  task,
  parentName,
  depth,
  isDraft,
  onRemove,
  onRemoveParent,
  onBranchNameChange,
}: {
  task: TaskNode;
  parentName?: string;
  depth: number;
  isDraft: boolean;
  onRemove: () => void;
  onRemoveParent?: () => void;
  onBranchNameChange?: (newName: string) => void;
}) {
  const [isEditingBranch, setIsEditingBranch] = useState(false);
  const [editBranchValue, setEditBranchValue] = useState(task.branchName || "");
  const [isExpanded, setIsExpanded] = useState(false);

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !isDraft || isEditingBranch,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${task.id}`,
    disabled: !isDraft,
  });

  const handleBranchSave = () => {
    onBranchNameChange?.(editBranchValue);
    setIsEditingBranch(false);
  };

  const handleBranchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleBranchSave();
    } else if (e.key === "Escape") {
      setEditBranchValue(task.branchName || "");
      setIsEditingBranch(false);
    }
  };

  const handleTaskClick = (e: React.MouseEvent) => {
    // Don't toggle if clicking on interactive elements
    if ((e.target as HTMLElement).closest("button, input, .planning-panel__task-branch--editable")) {
      return;
    }
    setIsExpanded(!isExpanded);
  };

  // Generate default branch name from title if not set
  const displayBranchName = task.branchName || `task/${task.title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").substring(0, 30)}`;

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      className={`planning-panel__task-item ${isOver ? "planning-panel__task-item--drop-target" : ""} ${isExpanded ? "planning-panel__task-item--expanded" : ""} ${task.issueUrl ? "planning-panel__task-item--has-issue" : ""}`}
      style={{ opacity: isDragging ? 0.5 : 1, marginLeft: depth * 16 }}
      onClick={handleTaskClick}
      {...(isEditingBranch ? {} : { ...attributes, ...listeners })}
    >
      {parentName && (
        <div className="planning-panel__task-parent">
          ↳ {parentName}
          {isDraft && onRemoveParent && (
            <button
              className="planning-panel__task-parent-remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveParent();
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
      <div className="planning-panel__task-title">
        {task.title}
        {task.issueUrl && (
          <a
            href={task.issueUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="planning-panel__task-issue-link"
            onClick={(e) => e.stopPropagation()}
            title={task.issueUrl}
          >
            <img src={githubIcon} alt="Issue" />
          </a>
        )}
      </div>
      <div className="planning-panel__task-branch-row">
        {isEditingBranch ? (
          <input
            type="text"
            value={editBranchValue}
            onChange={(e) => setEditBranchValue(e.target.value)}
            onBlur={handleBranchSave}
            onKeyDown={handleBranchKeyDown}
            className="planning-panel__task-branch-input"
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            className={`planning-panel__task-branch ${isDraft ? "planning-panel__task-branch--editable" : ""}`}
            onClick={(e) => {
              if (isDraft) {
                e.stopPropagation();
                setEditBranchValue(task.branchName || displayBranchName);
                setIsEditingBranch(true);
              }
            }}
          >
            {displayBranchName}
            {isDraft && <span className="planning-panel__task-branch-edit">✎</span>}
          </div>
        )}
      </div>
      {task.description && (
        <div className="planning-panel__task-desc-wrapper">
          <div className={`planning-panel__task-desc ${isExpanded ? "planning-panel__task-desc--expanded" : ""}`}>
            {task.description}
          </div>
          <span className="planning-panel__task-expand-hint">
            {isExpanded ? "▲" : "▼"}
          </span>
        </div>
      )}
      {isDraft && (
        <button
          className="planning-panel__task-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          x
        </button>
      )}
    </div>
  );
}

interface PlanningPanelProps {
  repoId: string;
  branches: string[];
  defaultBranch: string;
  onTasksChange?: (nodes: TaskNode[], edges: TaskEdge[]) => void;
  onSessionSelect?: (session: PlanningSession | null) => void;
  pendingPlanning?: { branchName: string; instruction: string | null } | null;
  onPlanningStarted?: () => void;
  // For Execute Session branch selection
  graphNodes?: TreeNode[];
  graphEdges?: TreeEdge[];
}

export function PlanningPanel({
  repoId,
  branches,
  defaultBranch,
  onTasksChange,
  onSessionSelect,
  pendingPlanning,
  onPlanningStarted,
  graphNodes = [],
  graphEdges = [],
}: PlanningPanelProps) {
  const [sessions, setSessions] = useState<PlanningSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tab management
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Derived: currently selected session from active tab
  const selectedSession = activeTabId ? sessions.find(s => s.id === activeTabId) || null : null;

  // New session type selection (for creation modal)
  const [newSessionType, setNewSessionType] = useState<"refinement" | "planning" | "execute">("refinement");

  // New session form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBaseBranch, setNewBaseBranch] = useState(defaultBranch);

  // External links for selected session
  const [externalLinks, setExternalLinks] = useState<ExternalLink[]>([]);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [addingLink, setAddingLink] = useState(false);

  // Chat messages for selected session (used internally in useEffect)
  const [, setMessages] = useState<ChatMessage[]>([]);
  const [, setMessagesLoading] = useState(false);

  // Instructions map for planning sessions (baseBranch -> instruction preview)
  const [branchInstructions, setBranchInstructions] = useState<Map<string, string>>(new Map());

  // Task instruction editing for Planning sessions
  const [currentInstruction, setCurrentInstruction] = useState("");
  const [instructionLoading, setInstructionLoading] = useState(false);
  const [instructionSaving, setInstructionSaving] = useState(false);
  const [instructionDirty, setInstructionDirty] = useState(false);

  // Title editing with IME support
  const [editingTitle, setEditingTitle] = useState("");

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(350);
  const isResizing = useRef(false);

  // Session notifications (unread counts, thinking state)
  const chatSessionIds = sessions
    .filter((s) => s.chatSessionId)
    .map((s) => s.chatSessionId as string);
  const {
    getNotification,
    markAsSeen,
  } = useSessionNotifications(chatSessionIds);

  // Drag and drop for task parent-child relationships
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Execute Session state
  const [executeSelectedBranches, setExecuteSelectedBranches] = useState<string[]>([]);
  const [executeCurrentTaskInstruction, setExecuteCurrentTaskInstruction] = useState<TaskInstruction | null>(null);
  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeEditMode, setExecuteEditMode] = useState(false);
  const [executeEditTitle, setExecuteEditTitle] = useState("");
  const [executeEditBaseBranch, setExecuteEditBaseBranch] = useState("");
  const [executeEditBranches, setExecuteEditBranches] = useState<string[]>([]);

  // Load execute branches from session when selected
  useEffect(() => {
    if (selectedSession?.type === "execute" && selectedSession.executeBranches) {
      setExecuteSelectedBranches(selectedSession.executeBranches);
    } else {
      setExecuteSelectedBranches([]);
    }
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches]);

  // Load current task instruction for Execute Session
  useEffect(() => {
    if (!selectedSession || selectedSession.type !== "execute" || !selectedSession.executeBranches) {
      setExecuteCurrentTaskInstruction(null);
      return;
    }
    const currentBranch = selectedSession.executeBranches[selectedSession.currentExecuteIndex];
    if (!currentBranch) {
      setExecuteCurrentTaskInstruction(null);
      return;
    }
    api.getTaskInstruction(repoId, currentBranch)
      .then(setExecuteCurrentTaskInstruction)
      .catch(() => setExecuteCurrentTaskInstruction(null));
  }, [selectedSession?.id, selectedSession?.currentExecuteIndex, selectedSession?.executeBranches, repoId]);

  // Load sessions
  useEffect(() => {
    if (!repoId) return;
    setLoading(true);
    api.getPlanningSessions(repoId)
      .then((data) => {
        setSessions(data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repoId]);

  // Load instructions for planning sessions' baseBranches
  useEffect(() => {
    if (!repoId || sessions.length === 0) return;
    const planningSessions = sessions.filter(s => s.type === "planning");
    const branchNames = [...new Set(planningSessions.map(s => s.baseBranch))];

    branchNames.forEach(async (branchName) => {
      if (branchInstructions.has(branchName)) return;
      try {
        const instruction = await api.getTaskInstruction(repoId, branchName);
        if (instruction?.instructionMd) {
          setBranchInstructions(prev => new Map(prev).set(branchName, instruction.instructionMd));
        }
      } catch {
        // Instruction may not exist for this branch
      }
    });
  }, [repoId, sessions]);

  // WebSocket updates
  useEffect(() => {
    if (!repoId) return;

    const unsubCreated = wsClient.on("planning.created", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const newSession = msg.data as PlanningSession;
        // Check for duplicates before adding
        setSessions((prev) => {
          if (prev.some((s) => s.id === newSession.id)) {
            return prev;
          }
          return [newSession, ...prev];
        });
      }
    });

    const unsubUpdated = wsClient.on("planning.updated", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const updated = msg.data as PlanningSession;
        setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        if (activeTabId === updated.id) {
          onSessionSelect?.(updated);
          onTasksChange?.(updated.nodes, updated.edges);
        }
      }
    });

    const unsubDeleted = wsClient.on("planning.deleted", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const deleted = msg.data as { id: string };
        setSessions((prev) => prev.filter((s) => s.id !== deleted.id));
        // Close tab if deleted
        if (openTabIds.includes(deleted.id)) {
          closeTab(deleted.id);
        }
      }
    });

    const unsubDiscarded = wsClient.on("planning.discarded", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const discarded = msg.data as PlanningSession;
        setSessions((prev) => prev.map((s) => (s.id === discarded.id ? discarded : s)));
        if (activeTabId === discarded.id) {
          onSessionSelect?.(discarded);
        }
      }
    });

    const unsubConfirmed = wsClient.on("planning.confirmed", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const confirmed = msg.data as PlanningSession;
        setSessions((prev) => prev.map((s) => (s.id === confirmed.id ? confirmed : s)));
        if (activeTabId === confirmed.id) {
          onSessionSelect?.(confirmed);
          onTasksChange?.(confirmed.nodes, confirmed.edges);
        }
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
      unsubDiscarded();
      unsubConfirmed();
    };
  }, [repoId, selectedSession?.id]);

  // Load external links when session changes
  useEffect(() => {
    if (!selectedSession) {
      setExternalLinks([]);
      return;
    }
    api.getExternalLinks(selectedSession.id)
      .then(setExternalLinks)
      .catch(console.error);
  }, [selectedSession?.id]);

  // Load chat messages when session changes
  useEffect(() => {
    if (!selectedSession?.chatSessionId) {
      setMessages([]);
      return;
    }
    setMessagesLoading(true);
    api.getChatMessages(selectedSession.chatSessionId)
      .then(setMessages)
      .catch(console.error)
      .finally(() => setMessagesLoading(false));
  }, [selectedSession?.chatSessionId]);

  // Notify parent of task changes
  useEffect(() => {
    if (selectedSession) {
      onTasksChange?.(selectedSession.nodes, selectedSession.edges);
    }
  }, [selectedSession?.nodes, selectedSession?.edges]);

  // Load task instruction for Planning sessions
  useEffect(() => {
    if (!selectedSession || !repoId) {
      setCurrentInstruction("");
      setInstructionDirty(false);
      return;
    }
    const isPlanning = selectedSession.type === "planning";
    if (!isPlanning) {
      setCurrentInstruction("");
      setInstructionDirty(false);
      return;
    }
    setInstructionLoading(true);
    api.getTaskInstruction(repoId, selectedSession.baseBranch)
      .then((instruction) => {
        setCurrentInstruction(instruction?.instructionMd || "");
        setInstructionDirty(false);
      })
      .catch(console.error)
      .finally(() => setInstructionLoading(false));
  }, [selectedSession?.id, repoId]);

  // Sync editing title with selected session
  useEffect(() => {
    setEditingTitle(selectedSession?.title || "");
  }, [selectedSession?.id, selectedSession?.title]);

  const handleCreateSession = async () => {
    if (!newBaseBranch.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const session = await api.createPlanningSession(
        repoId,
        newBaseBranch.trim(),
        newTitle.trim() || undefined,
        newSessionType
      );
      // State will be updated via WebSocket planning.created event
      openTab(session);
      setShowNewForm(false);
      setNewTitle("");
      setNewBaseBranch(defaultBranch);
      setNewSessionType("refinement");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // Tab management functions
  const openTab = useCallback((session: PlanningSession) => {
    setOpenTabIds((prev) => {
      if (prev.includes(session.id)) {
        return prev; // Already open
      }
      return [...prev, session.id];
    });
    setActiveTabId(session.id);
    onSessionSelect?.(session);
    if (session.chatSessionId) {
      markAsSeen(session.chatSessionId);
    }
  }, [onSessionSelect, markAsSeen]);

  const closeTab = useCallback((sessionId: string) => {
    setOpenTabIds((prev) => {
      const newTabs = prev.filter((id) => id !== sessionId);
      // If closing the active tab, switch to the last remaining tab or null
      if (activeTabId === sessionId) {
        const newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1] : null;
        setActiveTabId(newActiveId);
        const newActiveSession = newActiveId ? sessions.find(s => s.id === newActiveId) : null;
        onSessionSelect?.(newActiveSession || null);
      }
      return newTabs;
    });
  }, [activeTabId, sessions, onSessionSelect]);

  const switchTab = useCallback((sessionId: string) => {
    setActiveTabId(sessionId);
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      onSessionSelect?.(session);
      if (session.chatSessionId) {
        markAsSeen(session.chatSessionId);
      }
    }
  }, [sessions, onSessionSelect, markAsSeen]);

  const handleSelectSession = (session: PlanningSession) => {
    openTab(session);
  };

  // Start planning session from pending planning
  const handleStartPlanningSession = async () => {
    if (!pendingPlanning) return;
    setCreating(true);
    setError(null);
    try {
      const session = await api.createPlanningSession(
        repoId,
        pendingPlanning.branchName,
        `Planning: ${pendingPlanning.branchName}`,
        "planning"
      );
      openTab(session);
      onPlanningStarted?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateTitle = async (title: string) => {
    if (!selectedSession) return;
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, { title });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
    } catch (err) {
      console.error("Failed to update title:", err);
    }
  };

  const handleUpdateBaseBranch = async (baseBranch: string) => {
    if (!selectedSession) return;
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, { baseBranch });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
    } catch (err) {
      console.error("Failed to update base branch:", err);
    }
  };

  // Sidebar resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(200, Math.min(600, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [sidebarWidth]);

  const handleConfirm = async () => {
    if (!selectedSession) return;
    const isPlanningType = selectedSession.title.startsWith("Planning:");
    if (!isPlanningType && selectedSession.nodes.length === 0) {
      setError("No tasks to confirm");
      return;
    }
    setLoading(true);
    try {
      const updated = await api.confirmPlanningSession(selectedSession.id);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDiscard = async () => {
    if (!selectedSession) return;
    if (!confirm("このプランニングセッションを破棄しますか？")) return;
    setLoading(true);
    try {
      const updated = await api.discardPlanningSession(selectedSession.id);
      // Update status in list (keep it visible as discarded)
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      // Close the tab
      closeTab(selectedSession.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedSession) return;
    if (!confirm("このプランニングセッションを完全に削除しますか？")) return;
    setLoading(true);
    try {
      await api.deletePlanningSession(selectedSession.id);
      closeTab(selectedSession.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteFromList = async (sessionId: string) => {
    if (!confirm("このプランニングセッションを完全に削除しますか？")) return;
    try {
      await api.deletePlanningSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Execute Session handlers
  const handleExecuteBranchesChange = async (newBranches: string[]) => {
    setExecuteSelectedBranches(newBranches);
  };

  const handleStartExecution = async () => {
    if (!selectedSession || executeSelectedBranches.length === 0) return;
    setExecuteLoading(true);
    try {
      const updated = await api.updateExecuteBranches(selectedSession.id, executeSelectedBranches);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExecuteLoading(false);
    }
  };

  const handleAdvanceTask = async () => {
    if (!selectedSession) return;
    setExecuteLoading(true);
    try {
      const result = await api.advanceExecuteTask(selectedSession.id);
      setSessions((prev) => prev.map((s) => (s.id === result.id ? result : s)));
      onSessionSelect?.(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExecuteLoading(false);
    }
  };

  const handleSkipTask = async () => {
    // Same as advance but without marking as complete
    await handleAdvanceTask();
  };

  const handleAbortExecution = async () => {
    if (!selectedSession) return;
    if (!confirm("実行を中止しますか？ブランチ選択画面に戻ります。")) return;
    setExecuteLoading(true);
    try {
      // Clear execute branches to go back to selection mode
      const updated = await api.updateExecuteBranches(selectedSession.id, []);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
      setExecuteSelectedBranches([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExecuteLoading(false);
    }
  };

  // Execute Session edit mode handlers
  const handleStartExecuteEdit = () => {
    if (!selectedSession) return;
    setExecuteEditTitle(selectedSession.title);
    setExecuteEditBaseBranch(selectedSession.baseBranch);
    setExecuteEditBranches(selectedSession.executeBranches || []);
    setExecuteEditMode(true);
  };

  const handleCancelExecuteEdit = () => {
    setExecuteEditMode(false);
  };

  const handleSaveExecuteEdit = async () => {
    if (!selectedSession) return;
    setExecuteLoading(true);
    try {
      // Update title
      let updated = await api.updatePlanningSession(selectedSession.id, {
        title: executeEditTitle,
      });
      // Update execute branches if changed
      const branchesChanged = JSON.stringify(executeEditBranches) !== JSON.stringify(selectedSession.executeBranches);
      if (branchesChanged) {
        updated = await api.updateExecuteBranches(selectedSession.id, executeEditBranches);
      }
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
      setExecuteEditMode(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExecuteLoading(false);
    }
  };

  // External link handlers
  const handleAddLink = async () => {
    if (!newLinkUrl.trim() || !selectedSession || addingLink) return;
    setAddingLink(true);
    try {
      const link = await api.addExternalLink(selectedSession.id, newLinkUrl.trim());
      setExternalLinks((prev) => [...prev, link]);
      setNewLinkUrl("");
    } catch (err) {
      console.error("Failed to add link:", err);
    } finally {
      setAddingLink(false);
    }
  };

  const handleRemoveLink = async (id: number) => {
    try {
      await api.deleteExternalLink(id);
      setExternalLinks((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      console.error("Failed to remove link:", err);
    }
  };

  // Save task instruction
  const handleSaveInstruction = async () => {
    if (!selectedSession || !repoId || instructionSaving) return;
    setInstructionSaving(true);
    try {
      await api.updateTaskInstruction(repoId, selectedSession.baseBranch, currentInstruction);
      setInstructionDirty(false);
      // Update the cached instruction for the list view
      setBranchInstructions((prev) => new Map(prev).set(selectedSession.baseBranch, currentInstruction));
    } catch (err) {
      console.error("Failed to save instruction:", err);
      setError("Failed to save instruction");
    } finally {
      setInstructionSaving(false);
    }
  };

  // Task suggestion from chat
  const handleTaskSuggested = useCallback(async (suggestion: TaskSuggestion) => {
    if (!selectedSession) return;
    const newNode: TaskNode = {
      id: crypto.randomUUID(),
      title: suggestion.label,
      description: suggestion.description,
      branchName: suggestion.branchName,
      issueUrl: suggestion.issueUrl,
    };
    const updatedNodes = [...selectedSession.nodes, newNode];

    // Find parent by label if specified
    let updatedEdges = [...selectedSession.edges];
    if (suggestion.parentLabel) {
      const parentNode = selectedSession.nodes.find(
        (n) => n.title.toLowerCase() === suggestion.parentLabel?.toLowerCase()
      );
      if (parentNode) {
        updatedEdges.push({ parent: parentNode.id, child: newNode.id });
      }
    }

    try {
      const updated = await api.updatePlanningSession(selectedSession.id, {
        nodes: updatedNodes,
        edges: updatedEdges,
      });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onTasksChange?.(updated.nodes, updated.edges);
    } catch (err) {
      console.error("Failed to add task:", err);
    }
  }, [selectedSession]);

  // Task removal
  const handleRemoveTask = async (taskId: string) => {
    if (!selectedSession) return;
    const updatedNodes = selectedSession.nodes.filter((n) => n.id !== taskId);
    const updatedEdges = selectedSession.edges.filter(
      (e) => e.parent !== taskId && e.child !== taskId
    );
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, {
        nodes: updatedNodes,
        edges: updatedEdges,
      });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onTasksChange?.(updated.nodes, updated.edges);
    } catch (err) {
      console.error("Failed to remove task:", err);
    }
  };

  // Drag and drop handlers for parent-child relationships
  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || !selectedSession) return;

    const draggedId = active.id as string;
    const droppedOnId = (over.id as string).replace("drop-", "");

    // Don't drop on self
    if (draggedId === droppedOnId) return;

    // Check for circular dependency
    const wouldCreateCycle = (childId: string, parentId: string): boolean => {
      const existingParent = selectedSession.edges.find((e) => e.child === parentId)?.parent;
      if (!existingParent) return false;
      if (existingParent === childId) return true;
      return wouldCreateCycle(childId, existingParent);
    };

    if (wouldCreateCycle(draggedId, droppedOnId)) {
      console.warn("Cannot create circular dependency");
      return;
    }

    // Remove existing parent edge for this task
    const updatedEdges = selectedSession.edges.filter((e) => e.child !== draggedId);
    // Add new parent edge
    updatedEdges.push({ parent: droppedOnId, child: draggedId });

    try {
      const updated = await api.updatePlanningSession(selectedSession.id, {
        edges: updatedEdges,
      });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onTasksChange?.(updated.nodes, updated.edges);
    } catch (err) {
      console.error("Failed to set parent:", err);
    }
  };

  const handleRemoveParent = async (taskId: string) => {
    if (!selectedSession) return;
    const updatedEdges = selectedSession.edges.filter((e) => e.child !== taskId);
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, {
        edges: updatedEdges,
      });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onTasksChange?.(updated.nodes, updated.edges);
    } catch (err) {
      console.error("Failed to remove parent:", err);
    }
  };

  // Update branch name for a task
  const handleBranchNameChange = async (taskId: string, newBranchName: string) => {
    if (!selectedSession) return;
    const updatedNodes = selectedSession.nodes.map((n) =>
      n.id === taskId ? { ...n, branchName: newBranchName } : n
    );
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, {
        nodes: updatedNodes,
      });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onTasksChange?.(updated.nodes, updated.edges);
    } catch (err) {
      console.error("Failed to update branch name:", err);
    }
  };

  // Get parent name for a task
  const getParentName = (taskId: string): string | undefined => {
    if (!selectedSession) return undefined;
    const edge = selectedSession.edges.find((e) => e.child === taskId);
    if (!edge) return undefined;
    const parentTask = selectedSession.nodes.find((n) => n.id === edge.parent);
    return parentTask?.title;
  };

  // Get depth of a task in the hierarchy
  const getTaskDepth = (taskId: string): number => {
    if (!selectedSession) return 0;
    let depth = 0;
    let currentId = taskId;
    while (true) {
      const edge = selectedSession.edges.find((e) => e.child === currentId);
      if (!edge) break;
      depth++;
      currentId = edge.parent;
    }
    return depth;
  };

  const getLinkTypeIcon = (type: string): { iconSrc: string; className: string } => {
    switch (type) {
      case "notion": return { iconSrc: notionIcon, className: "planning-panel__link-icon--notion" };
      case "figma": return { iconSrc: figmaIcon, className: "planning-panel__link-icon--figma" };
      case "github_issue": return { iconSrc: githubIcon, className: "planning-panel__link-icon--github" };
      case "github_pr": return { iconSrc: githubIcon, className: "planning-panel__link-icon--github" };
      default: return { iconSrc: linkIcon, className: "" };
    }
  };

  const [showLinkInput, setShowLinkInput] = useState(false);

  if (loading && sessions.length === 0) {
    return (
      <div className="planning-panel planning-panel--loading">
        <div className="planning-panel__spinner" />
        Loading...
      </div>
    );
  }

  // Helper to get open tab sessions
  const openTabs = openTabIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is PlanningSession => s !== undefined);

  // Render tab bar (shown when tabs are open)
  const renderTabBar = () => {
    if (openTabs.length === 0) return null;
    return (
      <div className="planning-panel__tab-bar">
        {openTabs.map((session) => {
          const sessionType = session.type || "refinement";
          const typeIcon = sessionType === "refinement" ? "💭" : sessionType === "planning" ? "📋" : "⚡";
          const isActive = session.id === activeTabId;
          const notification = session.chatSessionId ? getNotification(session.chatSessionId) : null;
          const isThinking = notification?.isThinking;
          return (
            <div
              key={session.id}
              className={`planning-panel__tab ${isActive ? "planning-panel__tab--active" : ""} planning-panel__tab--${sessionType}`}
              onClick={() => switchTab(session.id)}
            >
              {isThinking && <span className="planning-panel__tab-thinking-indicator" />}
              <span className="planning-panel__tab-icon">{typeIcon}</span>
              <span className="planning-panel__tab-title">{session.title}</span>
              <button
                className="planning-panel__tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(session.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          className="planning-panel__tab-add"
          onClick={() => {
            setActiveTabId(null);
            setShowNewForm(true);
          }}
          title="New Session"
        >
          +
        </button>
      </div>
    );
  };

  // Session list view (when no session is selected or as a pane)
  const renderSessionList = () => (
    <div className={`planning-panel__session-list-view ${showNewForm ? "planning-panel__session-list-view--two-column" : ""}`}>
      {/* Left Column: Create Form (only when showNewForm is true) */}
      {showNewForm && (
        <div className="planning-panel__create-column">
          <div
            className="planning-panel__new-form"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !creating) {
                handleCreateSession();
              }
            }}
          >
            <div className="planning-panel__type-select">
              <button
                className={`planning-panel__type-btn planning-panel__type-btn--refinement ${newSessionType === "refinement" ? "planning-panel__type-btn--active" : ""}`}
                onClick={() => setNewSessionType("refinement")}
                type="button"
              >
                <span className="planning-panel__type-icon">💭</span>
                <span>Refinement</span>
              </button>
              <button
                className={`planning-panel__type-btn planning-panel__type-btn--planning ${newSessionType === "planning" ? "planning-panel__type-btn--active" : ""}`}
                onClick={() => setNewSessionType("planning")}
                type="button"
              >
                <span className="planning-panel__type-icon">📋</span>
                <span>Planning</span>
              </button>
              <button
                className={`planning-panel__type-btn planning-panel__type-btn--execute ${newSessionType === "execute" ? "planning-panel__type-btn--active" : ""}`}
                onClick={() => setNewSessionType("execute")}
                type="button"
              >
                <span className="planning-panel__type-icon">⚡</span>
                <span>Execute</span>
              </button>
            </div>
            <input
              type="text"
              placeholder="Title (optional)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="planning-panel__input"
            />
            <select
              value={newBaseBranch}
              onChange={(e) => setNewBaseBranch(e.target.value)}
              className="planning-panel__select"
            >
              {branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            <div className="planning-panel__form-actions">
              <button onClick={handleCreateSession} disabled={creating}>
                {creating ? "Creating..." : "Create (⌘↵)"}
              </button>
              <button onClick={() => setShowNewForm(false)}>Cancel</button>
            </div>
          </div>

          {/* Pending Planning from Branch Selection */}
          {pendingPlanning && (
            <div className="planning-panel__pending-planning">
              <div className="planning-panel__pending-title">
                Start Planning for: {pendingPlanning.branchName}
              </div>
              {pendingPlanning.instruction && (
                <div className="planning-panel__pending-instruction">
                  {pendingPlanning.instruction}
                </div>
              )}
              <div className="planning-panel__pending-actions">
                <button
                  className="planning-panel__pending-start"
                  onClick={handleStartPlanningSession}
                  disabled={creating}
                >
                  {creating ? "Starting..." : "Start Session"}
                </button>
                <button
                  className="planning-panel__pending-cancel"
                  onClick={() => onPlanningStarted?.()}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Right Column: Sessions List */}
      <div className="planning-panel__list">
        {/* New Session Button (only when form is not shown) */}
        {!showNewForm && (
          <button
            className="planning-panel__session-add"
            onClick={() => setShowNewForm(true)}
          >
            <span className="planning-panel__session-add-icon">+</span>
            <span>New Session</span>
          </button>
        )}

        {/* Session items */}
        {sessions.map((session) => {
          const notification = session.chatSessionId ? getNotification(session.chatSessionId) : null;
          const hasUnread = notification && notification.unreadCount > 0;
          const isThinking = notification?.isThinking;
          const sessionType = session.type || "refinement";
          const typeIcon = sessionType === "refinement" ? "💭" : sessionType === "planning" ? "📋" : "⚡";
          const typeLabel = sessionType === "refinement" ? "Refinement" : sessionType === "planning" ? "Planning" : "Execute";

          return (
            <div
              key={session.id}
              className={`planning-panel__session-item planning-panel__session-item--${session.status} planning-panel__session-item--type-${sessionType}`}
              onClick={() => handleSelectSession(session)}
            >
              <div className="planning-panel__session-header">
                <span className={`planning-panel__session-type-badge planning-panel__session-type-badge--${sessionType}`}>
                  <span className="planning-panel__session-type-icon">{typeIcon}</span>
                  <span className="planning-panel__session-type-label">{typeLabel}</span>
                </span>
                {isThinking && <span className="planning-panel__session-thinking" />}
                {hasUnread && <span className="planning-panel__session-unread" />}
              </div>
              <div className="planning-panel__session-title">
                {session.title}
              </div>
              <div className="planning-panel__session-base">
                {session.baseBranch}
              </div>
              <div className="planning-panel__session-meta">
                <span className={`planning-panel__session-status planning-panel__session-status--${session.status}`}>
                  {session.status}
                </span>
                <span className="planning-panel__session-tasks">
                  {session.nodes.length} tasks
                </span>
                {(session.status === "discarded" || session.status === "confirmed") && (
                  <button
                    className="planning-panel__session-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteFromList(session.id);
                    }}
                    title="Delete"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Empty state (only when no sessions and form not shown) */}
        {sessions.length === 0 && !showNewForm && (
          <div className="planning-panel__empty">
            No sessions yet
          </div>
        )}
      </div>
    </div>
  );

  // Determine session type from type property (for detail view)
  const sessionTypeValue = selectedSession?.type || "refinement";
  const sessionTypeLabel = sessionTypeValue === "refinement" ? "Refinement" : sessionTypeValue === "planning" ? "Planning" : "Execute";
  const sessionTypeIcon = sessionTypeValue === "refinement" ? "💭" : sessionTypeValue === "planning" ? "📋" : "⚡";

  // Render session detail content
  const renderSessionDetail = () => {
    if (!selectedSession) return null;

    // Execute Session header (read-only with edit button)
    if (sessionTypeValue === "execute") {
      const isInProgress = selectedSession.executeBranches && selectedSession.executeBranches.length > 0;
      const executeStatus = isInProgress ? "in_progress" : "draft";
      const executeStatusLabel = isInProgress ? "In Progress" : "Draft";

      return (
        <div className="planning-panel__detail-content">
          <div className="planning-panel__header">
            <span className={`planning-panel__session-type planning-panel__session-type--${sessionTypeValue}`}>
              <span className="planning-panel__session-type-icon">{sessionTypeIcon}</span>
              {sessionTypeLabel}
            </span>
            <span className={`planning-panel__execute-status planning-panel__execute-status--${executeStatus}`}>
              {executeStatusLabel}
            </span>
            {executeEditMode ? (
              <input
                type="text"
                value={executeEditTitle}
                onChange={(e) => setExecuteEditTitle(e.target.value)}
                className="planning-panel__title-input"
                placeholder="Untitled Session"
                autoFocus
              />
            ) : (
              <span className="planning-panel__header-title">{selectedSession.title}</span>
            )}
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
              <button
                className="planning-panel__edit-btn"
                onClick={handleStartExecuteEdit}
              >
                Edit
              </button>
            )}
          </div>

          {error && <div className="planning-panel__error">{error}</div>}

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
          {!executeEditMode && (!selectedSession.executeBranches || selectedSession.executeBranches.length === 0) && (
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
          {!executeEditMode && selectedSession.executeBranches && selectedSession.executeBranches.length > 0 && (
            <div className="planning-panel__detail-main">
              {/* Chat */}
              <div className="planning-panel__chat">
                {selectedSession.chatSessionId && (
                  <ChatPanel
                    sessionId={selectedSession.chatSessionId}
                    onTaskSuggested={handleTaskSuggested}
                    existingTaskLabels={selectedSession.nodes.map((n) => n.title)}
                    disabled={false}
                    executeMode={true}
                    executeContext={{
                      branchName: selectedSession.executeBranches[selectedSession.currentExecuteIndex],
                      instruction: executeCurrentTaskInstruction?.instructionMd || null,
                      taskIndex: selectedSession.currentExecuteIndex,
                      totalTasks: selectedSession.executeBranches.length,
                    }}
                  />
                )}
              </div>

              {/* Sidebar */}
              <div className="planning-panel__sidebar">
                {/* Progress */}
                <div className="planning-panel__execute-progress">
                  <div className="planning-panel__execute-progress-header">
                    <span>{selectedSession.currentExecuteIndex + 1}/{selectedSession.executeBranches.length}</span>
                    <div className="planning-panel__execute-progress-bar">
                      <div
                        className="planning-panel__execute-progress-fill"
                        style={{ width: `${((selectedSession.currentExecuteIndex + 1) / selectedSession.executeBranches.length) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="planning-panel__execute-current">
                    {selectedSession.executeBranches[selectedSession.currentExecuteIndex]}
                  </div>
                </div>

                {/* Task Instruction */}
                <div className="planning-panel__execute-instruction">
                  <div className="planning-panel__execute-instruction-content">
                    {executeCurrentTaskInstruction?.instructionMd || "No instruction"}
                  </div>
                </div>

                {/* Control buttons */}
                <div className="planning-panel__execute-controls">
                  <button
                    className="planning-panel__execute-next-btn"
                    onClick={handleAdvanceTask}
                    disabled={executeLoading || selectedSession.currentExecuteIndex >= selectedSession.executeBranches.length - 1}
                  >
                    {selectedSession.currentExecuteIndex >= selectedSession.executeBranches.length - 1
                      ? "Done"
                      : "Next"}
                  </button>
                  <button
                    className="planning-panel__execute-skip-btn"
                    onClick={handleSkipTask}
                    disabled={executeLoading || selectedSession.currentExecuteIndex >= selectedSession.executeBranches.length - 1}
                  >
                    Skip
                  </button>
                  <button
                    className="planning-panel__execute-abort-btn"
                    onClick={handleAbortExecution}
                    disabled={executeLoading}
                  >
                    Abort
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Non-Execute Session header (editable)
    return (
      <div className="planning-panel__detail-content">
        <div className="planning-panel__header">
          <span className={`planning-panel__session-type planning-panel__session-type--${sessionTypeValue}`}>
          <span className="planning-panel__session-type-icon">{sessionTypeIcon}</span>
          {sessionTypeLabel}
        </span>
        <select
          value={selectedSession.baseBranch}
          onChange={(e) => handleUpdateBaseBranch(e.target.value)}
          className="planning-panel__branch-select"
          disabled={selectedSession.status !== "draft" || sessionTypeValue === "planning"}
        >
          {branches.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <input
          type="text"
          value={editingTitle}
          onChange={(e) => setEditingTitle(e.target.value)}
          onBlur={() => {
            if (editingTitle !== selectedSession.title) {
              handleUpdateTitle(editingTitle);
            }
          }}
          className="planning-panel__title-input"
          placeholder="Untitled Session"
          disabled={selectedSession.status !== "draft"}
        />
      </div>

      {error && <div className="planning-panel__error">{error}</div>}

      {/* Non-Execute Session: Original layout */}
      {sessionTypeValue !== "execute" && (
      <div className="planning-panel__detail-main">
        {/* Chat section */}
        <div className="planning-panel__chat">
          {selectedSession.chatSessionId && (
            <ChatPanel
              sessionId={selectedSession.chatSessionId}
              onTaskSuggested={handleTaskSuggested}
              existingTaskLabels={selectedSession.nodes.map((n) => n.title)}
              disabled={selectedSession.status !== "draft"}
              currentInstruction={sessionTypeValue === "planning" ? currentInstruction : undefined}
              onInstructionUpdated={sessionTypeValue === "planning" ? async (newContent) => {
                // Update local state
                setCurrentInstruction(newContent);
                setInstructionDirty(false);
                // Save to API
                try {
                  await api.updateTaskInstruction(repoId, selectedSession.baseBranch, newContent);
                  // Update cached instruction for list view
                  setBranchInstructions((prev) => new Map(prev).set(selectedSession.baseBranch, newContent));
                } catch (err) {
                  console.error("Failed to save instruction:", err);
                  setError("Failed to save instruction");
                }
              } : undefined}
            />
          )}
        </div>

        {/* Resizer */}
        <div
          className="planning-panel__resizer"
          onMouseDown={handleResizeStart}
        />

        {/* Sidebar: Links + Tasks */}
        <div className="planning-panel__sidebar" style={{ width: sidebarWidth }}>
          {/* External Links */}
          <div className="planning-panel__links">
            <h4>Links</h4>
            <div className="planning-panel__links-list">
              {externalLinks.map((link) => {
                const { iconSrc, className } = getLinkTypeIcon(link.linkType);
                return (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`planning-panel__link-icon ${className}`}
                    title={link.title || link.url}
                  >
                    <img src={iconSrc} alt={link.linkType} />
                    {selectedSession.status === "draft" && (
                      <span
                        className="planning-panel__link-remove-overlay"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleRemoveLink(link.id);
                        }}
                      >
                        ×
                      </span>
                    )}
                  </a>
                );
              })}
              {addingLink && (
                <div className="planning-panel__link-icon planning-panel__link-icon--loading">
                  <div className="planning-panel__link-skeleton" />
                </div>
              )}
              {selectedSession.status === "draft" && !addingLink && (
                <button
                  className="planning-panel__link-add-icon"
                  onClick={() => setShowLinkInput(!showLinkInput)}
                  title="Add link"
                >
                  +
                </button>
              )}
            </div>
            {showLinkInput && selectedSession.status === "draft" && (
              <input
                type="text"
                className="planning-panel__link-add-input"
                placeholder="Paste URL and press Enter..."
                value={newLinkUrl}
                onChange={(e) => setNewLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleAddLink();
                    setShowLinkInput(false);
                  } else if (e.key === "Escape") {
                    setShowLinkInput(false);
                    setNewLinkUrl("");
                  }
                }}
                autoFocus
              />
            )}
          </div>

          {/* Task list - only for Refinement/Execute sessions */}
          {sessionTypeValue !== "planning" && (
            <div className="planning-panel__tasks">
              <h4>Tasks ({selectedSession.nodes.length})</h4>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                {selectedSession.nodes.map((task) => (
                  <DraggableTaskItem
                    key={task.id}
                    task={task}
                    parentName={getParentName(task.id)}
                    depth={getTaskDepth(task.id)}
                    isDraft={selectedSession.status === "draft"}
                    onRemove={() => handleRemoveTask(task.id)}
                    onRemoveParent={() => handleRemoveParent(task.id)}
                    onBranchNameChange={(newName) => handleBranchNameChange(task.id, newName)}
                  />
                ))}
                <DragOverlay>
                  {activeDragId && (
                    <div className="planning-panel__task-item planning-panel__task-item--dragging">
                      {selectedSession.nodes.find((t) => t.id === activeDragId)?.title}
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
              {selectedSession.nodes.length === 0 && (
                <div className="planning-panel__tasks-empty">
                  Chat with AI to suggest tasks
                </div>
              )}
            </div>
          )}

          {/* Task Instruction - only for Planning sessions */}
          {sessionTypeValue === "planning" && (
            <div className="planning-panel__instruction">
              <div className="planning-panel__instruction-header">
                <h4>Task Instruction</h4>
                {instructionDirty && (
                  <span className="planning-panel__instruction-dirty">unsaved</span>
                )}
              </div>
              {instructionLoading ? (
                <div className="planning-panel__instruction-loading">Loading...</div>
              ) : (
                <>
                  <textarea
                    className="planning-panel__instruction-textarea"
                    value={currentInstruction}
                    onChange={(e) => {
                      setCurrentInstruction(e.target.value);
                      setInstructionDirty(true);
                    }}
                    placeholder="Enter detailed task instructions..."
                    disabled={selectedSession.status !== "draft"}
                  />
                  {selectedSession.status === "draft" && (
                    <button
                      className="planning-panel__instruction-save"
                      onClick={handleSaveInstruction}
                      disabled={!instructionDirty || instructionSaving}
                    >
                      {instructionSaving ? "Saving..." : "Save"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Actions in sidebar */}
          {selectedSession.status === "draft" && (
            <div className="planning-panel__actions">
              <button
                className="planning-panel__discard-btn"
                onClick={handleDiscard}
                disabled={loading}
              >
                Discard
              </button>
              <button
                className="planning-panel__confirm-btn"
                onClick={handleConfirm}
                disabled={loading || (sessionTypeValue !== "planning" && selectedSession.nodes.length === 0)}
              >
                Confirm
              </button>
            </div>
          )}

          {selectedSession.status === "confirmed" && (
            <div className="planning-panel__status-banner planning-panel__status-banner--confirmed">
              Confirmed
              <button onClick={handleDelete} className="planning-panel__delete-btn">
                Delete
              </button>
            </div>
          )}

          {selectedSession.status === "discarded" && (
            <div className="planning-panel__status-banner planning-panel__status-banner--discarded">
              Discarded
              <button onClick={handleDelete} className="planning-panel__delete-btn">
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
    );
  };

  // Main render: Tab bar + content
  return (
    <div className="planning-panel">
      {error && <div className="planning-panel__error">{error}</div>}
      {renderTabBar()}
      <div className="planning-panel__content">
        {selectedSession ? renderSessionDetail() : renderSessionList()}
      </div>
    </div>
  );
}
