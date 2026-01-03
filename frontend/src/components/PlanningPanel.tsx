import { useState, useEffect, useCallback } from "react";
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
} from "../lib/api";
import { wsClient } from "../lib/ws";
import { ChatPanel } from "./ChatPanel";
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
      className={`planning-panel__task-item ${isOver ? "planning-panel__task-item--drop-target" : ""} ${isExpanded ? "planning-panel__task-item--expanded" : ""}`}
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
  onCollapseChange?: (collapsed: boolean) => void;
}

export function PlanningPanel({
  repoId,
  branches,
  defaultBranch,
  onTasksChange,
  onSessionSelect,
  onCollapseChange,
}: PlanningPanelProps) {
  const [sessions, setSessions] = useState<PlanningSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<PlanningSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem("planningPanel.collapsed");
    return saved === "true";
  });

  // New session form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBaseBranch, setNewBaseBranch] = useState(defaultBranch);

  // Notify parent of initial collapse state
  useEffect(() => {
    onCollapseChange?.(isCollapsed);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist collapse state and notify parent
  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("planningPanel.collapsed", String(next));
      onCollapseChange?.(next);
      return next;
    });
  }, [onCollapseChange]);

  // External links for selected session
  const [externalLinks, setExternalLinks] = useState<ExternalLink[]>([]);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [addingLink, setAddingLink] = useState(false);

  // Chat messages for selected session (used internally in useEffect)
  const [, setMessages] = useState<ChatMessage[]>([]);
  const [, setMessagesLoading] = useState(false);

  // Drag and drop for task parent-child relationships
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

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
        if (selectedSession?.id === updated.id) {
          setSelectedSession(updated);
          onSessionSelect?.(updated);
          onTasksChange?.(updated.nodes, updated.edges);
        }
      }
    });

    const unsubDeleted = wsClient.on("planning.deleted", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const deleted = msg.data as { id: string };
        setSessions((prev) => prev.filter((s) => s.id !== deleted.id));
        if (selectedSession?.id === deleted.id) {
          setSelectedSession(null);
          onSessionSelect?.(null);
        }
      }
    });

    const unsubDiscarded = wsClient.on("planning.discarded", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const discarded = msg.data as PlanningSession;
        setSessions((prev) => prev.map((s) => (s.id === discarded.id ? discarded : s)));
        if (selectedSession?.id === discarded.id) {
          setSelectedSession(discarded);
          onSessionSelect?.(discarded);
        }
      }
    });

    const unsubConfirmed = wsClient.on("planning.confirmed", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const confirmed = msg.data as PlanningSession;
        setSessions((prev) => prev.map((s) => (s.id === confirmed.id ? confirmed : s)));
        if (selectedSession?.id === confirmed.id) {
          setSelectedSession(confirmed);
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

  const handleCreateSession = async () => {
    if (!newBaseBranch.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const session = await api.createPlanningSession(
        repoId,
        newBaseBranch.trim(),
        newTitle.trim() || undefined
      );
      // State will be updated via WebSocket planning.created event
      setSelectedSession(session);
      onSessionSelect?.(session);
      setShowNewForm(false);
      setNewTitle("");
      setNewBaseBranch(defaultBranch);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleSelectSession = (session: PlanningSession) => {
    setSelectedSession(session);
    onSessionSelect?.(session);
  };

  const handleUpdateTitle = async (title: string) => {
    if (!selectedSession) return;
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, { title });
      setSelectedSession(updated);
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
      setSelectedSession(updated);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
    } catch (err) {
      console.error("Failed to update base branch:", err);
    }
  };

  const handleConfirm = async () => {
    if (!selectedSession) return;
    if (selectedSession.nodes.length === 0) {
      setError("No tasks to confirm");
      return;
    }
    setLoading(true);
    try {
      const updated = await api.confirmPlanningSession(selectedSession.id);
      setSelectedSession(updated);
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
      // Go back to list
      setSelectedSession(null);
      onSessionSelect?.(null);
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
      setSelectedSession(null);
      onSessionSelect?.(null);
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
      setSelectedSession(updated);
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
      setSelectedSession(updated);
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
      setSelectedSession(updated);
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
      setSelectedSession(updated);
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
      setSelectedSession(updated);
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

  // Session list view
  if (!selectedSession) {
    return (
      <div className={`planning-panel ${isCollapsed ? "planning-panel--collapsed" : ""}`}>
        <div className="planning-panel__header">
          <button
            className="planning-panel__collapse-btn"
            onClick={toggleCollapse}
            title={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
          <h3>Planning Sessions</h3>
          {!isCollapsed && (
            <button
              className="planning-panel__new-btn"
              onClick={() => setShowNewForm(true)}
            >
              + New
            </button>
          )}
        </div>

        {!isCollapsed && error && <div className="planning-panel__error">{error}</div>}

        {!isCollapsed && showNewForm && (
          <div
            className="planning-panel__new-form"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !creating) {
                handleCreateSession();
              }
            }}
          >
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
        )}

        {!isCollapsed && (
          <div className="planning-panel__list">
            {sessions.length === 0 ? (
              <div className="planning-panel__empty">
                No planning sessions yet. Create one to start!
              </div>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={`planning-panel__session-item planning-panel__session-item--${session.status}`}
                  onClick={() => handleSelectSession(session)}
                >
                  <div className="planning-panel__session-title">
                    {session.title}
                  </div>
                  <div className="planning-panel__session-meta">
                    <span className="planning-panel__session-base">
                      {session.baseBranch}
                    </span>
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
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  // Session detail view
  return (
    <div className="planning-panel planning-panel--detail">
      <div className="planning-panel__header">
        <button
          className="planning-panel__back-btn"
          onClick={() => {
            setSelectedSession(null);
            onSessionSelect?.(null);
          }}
        >
          &larr; Back
        </button>
        <select
          value={selectedSession.baseBranch}
          onChange={(e) => handleUpdateBaseBranch(e.target.value)}
          className="planning-panel__branch-select"
          disabled={selectedSession.status !== "draft"}
        >
          {branches.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <input
          type="text"
          value={selectedSession.title}
          onChange={(e) => handleUpdateTitle(e.target.value)}
          className="planning-panel__title-input"
          placeholder="Untitled Planning"
          disabled={selectedSession.status !== "draft"}
        />
      </div>

      {error && <div className="planning-panel__error">{error}</div>}

      <div className="planning-panel__content">
        {/* Chat section */}
        <div className="planning-panel__chat">
          {selectedSession.chatSessionId && (
            <ChatPanel
              sessionId={selectedSession.chatSessionId}
              onTaskSuggested={handleTaskSuggested}
              existingTaskLabels={selectedSession.nodes.map((n) => n.title)}
              disabled={selectedSession.status !== "draft"}
            />
          )}
        </div>

        {/* Sidebar: Links + Tasks */}
        <div className="planning-panel__sidebar">
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

          {/* Task list */}
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
                disabled={loading || selectedSession.nodes.length === 0}
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
    </div>
  );
}
