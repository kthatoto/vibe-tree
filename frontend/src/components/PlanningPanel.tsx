import { useState, useEffect, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  type BranchLink,
  type BranchExternalLink,
  type BranchFile,
} from "../lib/api";
import { wsClient } from "../lib/ws";
import { useSessionNotifications } from "../lib/useSessionNotifications";
import { ChatPanel } from "./ChatPanel";
import ExecuteBranchSelector from "./ExecuteBranchSelector";
import ExecuteSidebar from "./ExecuteSidebar";
import ExecuteBranchTree from "./ExecuteBranchTree";
import ExecuteTodoList from "./ExecuteTodoList";
import PlanningQuestionsPanel from "./PlanningQuestionsPanel";
import type { TaskSuggestion } from "../lib/task-parser";
import { getResourceIcon, figmaIcon, githubIcon, notionIcon, linkIcon } from "../lib/resourceIcons";
import "./PlanningPanel.css";

// Sortable task item component (for reordering)
function SortableTaskItem({
  task,
  index,
  isDraft,
  onRemove,
  onBranchNameChange,
  links = [],
}: {
  task: TaskNode;
  index: number;
  isDraft: boolean;
  onRemove: () => void;
  onBranchNameChange?: (newName: string) => void;
  links?: BranchExternalLink[];
}) {
  const [isEditingBranch, setIsEditingBranch] = useState(false);
  const [editBranchValue, setEditBranchValue] = useState(task.branchName || "");
  const [isExpanded, setIsExpanded] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    disabled: !isDraft || isEditingBranch,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

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
      ref={setNodeRef}
      style={style}
      className={`planning-panel__task-item ${isExpanded ? "planning-panel__task-item--expanded" : ""} ${task.issueUrl ? "planning-panel__task-item--has-issue" : ""} ${isDragging ? "planning-panel__task-item--dragging" : ""}`}
      onClick={handleTaskClick}
      {...(isEditingBranch ? {} : { ...attributes, ...listeners })}
    >
      <div className="planning-panel__task-order">{index + 1}</div>
      <div className="planning-panel__task-content">
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
        {links.length > 0 && (
          <div className="planning-panel__task-links">
            {links.map((link) => {
              const icon = getResourceIcon(link.linkType);
              return (
                <a
                  key={link.id}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`planning-panel__task-link-icon planning-panel__task-link-icon${icon.className}`}
                  onClick={(e) => e.stopPropagation()}
                  title={link.title || link.url}
                >
                  <img src={icon.src} alt={icon.alt} />
                </a>
              );
            })}
          </div>
        )}
      </div>
      {isDraft && (
        <button
          className="planning-panel__task-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

interface PlanningPanelProps {
  repoId: string;
  defaultBranch: string;
  onTasksChange?: (nodes: TaskNode[], edges: TaskEdge[]) => void;
  onSessionSelect?: (session: PlanningSession | null) => void;
  pendingPlanning?: { branchName: string; instruction: string | null } | null;
  onPlanningStarted?: () => void;
  // For Execute Session branch selection
  graphNodes?: TreeNode[];
  graphEdges?: TreeEdge[];
  // Fullscreen mode
  chatFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function PlanningPanel({
  repoId,
  defaultBranch,
  onTasksChange,
  onSessionSelect,
  pendingPlanning,
  onPlanningStarted,
  graphNodes = [],
  graphEdges = [],
  chatFullscreen = false,
  onToggleFullscreen,
}: PlanningPanelProps) {
  const [sessions, setSessions] = useState<PlanningSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tab management
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [emptyTabCounter, setEmptyTabCounter] = useState(0);

  // Helper to check if a tab ID is an empty tab
  const isEmptyTab = (tabId: string) => tabId.startsWith("__new__");

  // Derived: currently selected session from active tab
  const selectedSession = activeTabId && !isEmptyTab(activeTabId) ? sessions.find(s => s.id === activeTabId) || null : null;

  // New session type selection (for creation modal)
  const [newSessionType, setNewSessionType] = useState<"refinement" | "planning" | "execute">("refinement");

  // New session form
  const [showNewForm, setShowNewForm] = useState(false);
  // newBaseBranch removed - all session types now use defaultBranch

  // External links for selected session
  const [externalLinksMap, setExternalLinksMap] = useState<Record<string, ExternalLink[]>>({});
  const externalLinks = selectedSession ? (externalLinksMap[selectedSession.id] || []) : [];
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [addingLinkCountMap, setAddingLinkCountMap] = useState<Record<string, number>>({});
  const addingLinkCount = selectedSession ? (addingLinkCountMap[selectedSession.id] || 0) : 0;

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
  const [instructionEditing, setInstructionEditing] = useState(false);


  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const isResizing = useRef(false);

  // Ref to track the latest selected session for async operations
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;

  // Ref to track pending nodes (added but not yet saved to API) for parent lookup
  const pendingNodesRef = useRef<TaskNode[]>([]);

  // Session notifications (unread counts, thinking state)
  const chatSessionIds = sessions
    .filter((s) => s.chatSessionId)
    .map((s) => s.chatSessionId as string);
  const {
    getNotification,
    markAsSeen,
  } = useSessionNotifications(chatSessionIds, selectedSession?.chatSessionId);

  // Drag and drop for task parent-child relationships
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Branch external links for tasks (keyed by branchName)
  const [taskBranchLinksMap, setTaskBranchLinksMap] = useState<Record<string, BranchExternalLink[]>>({});

  // Execute Session state
  const [executeSelectedBranches, setExecuteSelectedBranches] = useState<string[]>([]);
  const [executeCurrentTaskInstruction, setExecuteCurrentTaskInstruction] = useState<TaskInstruction | null>(null);
  const [executeAllTasksInstructions, setExecuteAllTasksInstructions] = useState<Array<{ branchName: string; instruction: string | null }>>([]);
  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeEditMode, setExecuteEditMode] = useState(false);
  const [executeEditTitle, setExecuteEditTitle] = useState("");
  const [executeEditBranches, setExecuteEditBranches] = useState<string[]>([]);

  // Planning Session state (similar to Execute but for planning multiple branches)
  const [planningSelectedBranches, setPlanningSelectedBranches] = useState<string[]>([]);
  const [planningCurrentBranchIndex, setPlanningCurrentBranchIndex] = useState(0); // AI's working branch
  const [userViewBranchIndex, setUserViewBranchIndex] = useState(0); // User's viewing branch (separate from AI)
  const [planningLoading, setPlanningLoading] = useState(false);
  const [claudeWorking, setClaudeWorking] = useState(false);

  // Planning sidebar tabs (without branches - branches are always shown at top)
  const [planningSidebarTab, setPlanningSidebarTab] = useState<"instruction" | "todo" | "questions" | "resources">("instruction");

  // Planning branch links (PR/Issue) for all branches
  const [planningAllBranchLinks, setPlanningAllBranchLinks] = useState<Map<string, BranchLink[]>>(new Map());

  // Planning branch external links and files for current branch
  const [planningExternalLinks, setPlanningExternalLinks] = useState<BranchExternalLink[]>([]);
  const [planningBranchFiles, setPlanningBranchFiles] = useState<BranchFile[]>([]);

  // Planning branch resource counts for all branches (for tree badges)
  const [planningResourceCounts, setPlanningResourceCounts] = useState<Map<string, { figma: number; githubIssue: number; notion: number; other: number; files: number }>>(new Map());

  // Planning branch counts (ToDo and Question counts per branch)
  const [branchTodoCounts, setBranchTodoCounts] = useState<Map<string, { total: number; completed: number }>>(new Map());
  const [branchQuestionCounts, setBranchQuestionCounts] = useState<Map<string, { total: number; pending: number; answered: number; acknowledged: number }>>(new Map());

  // Ref to track the latest planning branch index for async operations
  const planningCurrentBranchIndexRef = useRef(planningCurrentBranchIndex);
  planningCurrentBranchIndexRef.current = planningCurrentBranchIndex;

  // Load execute branches from session when selected
  useEffect(() => {
    if (selectedSession?.type === "execute" && selectedSession.executeBranches) {
      setExecuteSelectedBranches(selectedSession.executeBranches);
    } else {
      setExecuteSelectedBranches([]);
    }
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches]);

  // Load planning branches from session when selected
  useEffect(() => {
    if (selectedSession?.type === "planning" && selectedSession.executeBranches) {
      setPlanningSelectedBranches(selectedSession.executeBranches);
      setPlanningCurrentBranchIndex(selectedSession.currentExecuteIndex || 0);
    } else {
      setPlanningSelectedBranches([]);
      setPlanningCurrentBranchIndex(0);
    }
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches, selectedSession?.currentExecuteIndex]);

  // Load ToDo and Question counts for Planning Session branches
  useEffect(() => {
    if (!selectedSession || selectedSession.type !== "planning" || !selectedSession.executeBranches) {
      setBranchTodoCounts(new Map());
      setBranchQuestionCounts(new Map());
      return;
    }

    // Load ToDos for all branches
    const loadTodoCounts = async () => {
      const counts = new Map<string, { total: number; completed: number }>();
      for (const branch of selectedSession.executeBranches!) {
        try {
          const todos = await api.getTodos(repoId, branch);
          counts.set(branch, {
            total: todos.length,
            completed: todos.filter(t => t.status === "completed").length,
          });
        } catch {
          counts.set(branch, { total: 0, completed: 0 });
        }
      }
      setBranchTodoCounts(counts);
    };

    // Load Questions and count by branch
    const loadQuestionCounts = async () => {
      try {
        const questions = await api.getQuestions(selectedSession.id);
        const counts = new Map<string, { total: number; pending: number; answered: number; acknowledged: number }>();
        // Initialize counts for all branches
        for (const branch of selectedSession.executeBranches!) {
          counts.set(branch, { total: 0, pending: 0, answered: 0, acknowledged: 0 });
        }
        // Count questions per branch
        for (const q of questions) {
          const branch = q.branchName || "";
          if (counts.has(branch)) {
            const current = counts.get(branch)!;
            counts.set(branch, {
              total: current.total + 1,
              pending: current.pending + (q.status === "pending" ? 1 : 0),
              answered: current.answered + (q.status === "answered" && !q.acknowledged ? 1 : 0),
              acknowledged: current.acknowledged + (q.status === "answered" && q.acknowledged ? 1 : 0),
            });
          }
        }
        setBranchQuestionCounts(counts);
      } catch {
        setBranchQuestionCounts(new Map());
      }
    };

    loadTodoCounts();
    loadQuestionCounts();
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches, repoId]);

  // Update counts on WebSocket events
  useEffect(() => {
    if (!selectedSession || selectedSession.type !== "planning" || !selectedSession.executeBranches) return;

    const updateTodoCounts = (branchName: string) => {
      api.getTodos(repoId, branchName).then(todos => {
        setBranchTodoCounts(prev => {
          const next = new Map(prev);
          next.set(branchName, {
            total: todos.length,
            completed: todos.filter(t => t.status === "completed").length,
          });
          return next;
        });
      }).catch(console.error);
    };

    const updateQuestionCounts = () => {
      api.getQuestions(selectedSession.id).then(questions => {
        const counts = new Map<string, { total: number; pending: number; answered: number; acknowledged: number }>();
        for (const branch of selectedSession.executeBranches!) {
          counts.set(branch, { total: 0, pending: 0, answered: 0, acknowledged: 0 });
        }
        for (const q of questions) {
          const branch = q.branchName || "";
          if (counts.has(branch)) {
            const current = counts.get(branch)!;
            counts.set(branch, {
              total: current.total + 1,
              pending: current.pending + (q.status === "pending" ? 1 : 0),
              answered: current.answered + (q.status === "answered" && !q.acknowledged ? 1 : 0),
              acknowledged: current.acknowledged + (q.status === "answered" && q.acknowledged ? 1 : 0),
            });
          }
        }
        setBranchQuestionCounts(counts);
      }).catch(console.error);
    };

    const unsubTodoCreated = wsClient.on("todo.created", (msg) => {
      const data = msg.data as { branchName?: string };
      if (data.branchName && selectedSession.executeBranches!.includes(data.branchName)) {
        updateTodoCounts(data.branchName);
      }
    });
    const unsubTodoUpdated = wsClient.on("todo.updated", (msg) => {
      const data = msg.data as { branchName?: string };
      if (data.branchName && selectedSession.executeBranches!.includes(data.branchName)) {
        updateTodoCounts(data.branchName);
      }
    });
    const unsubTodoDeleted = wsClient.on("todo.deleted", (msg) => {
      const data = msg.data as { branchName?: string };
      if (data.branchName && selectedSession.executeBranches!.includes(data.branchName)) {
        updateTodoCounts(data.branchName);
      }
    });
    const unsubQuestionCreated = wsClient.on("question.created", (msg) => {
      const data = msg.data as { planningSessionId?: string };
      if (data.planningSessionId === selectedSession.id) {
        updateQuestionCounts();
      }
    });
    const unsubQuestionUpdated = wsClient.on("question.updated", (msg) => {
      const data = msg.data as { planningSessionId?: string };
      if (data.planningSessionId === selectedSession.id) {
        updateQuestionCounts();
      }
    });
    const unsubQuestionAnswered = wsClient.on("question.answered", (msg) => {
      const data = msg.data as { planningSessionId?: string };
      if (data.planningSessionId === selectedSession.id) {
        updateQuestionCounts();
      }
    });

    return () => {
      unsubTodoCreated();
      unsubTodoUpdated();
      unsubTodoDeleted();
      unsubQuestionCreated();
      unsubQuestionUpdated();
      unsubQuestionAnswered();
    };
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches, repoId]);

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

  // Load all task instructions when execute session starts
  useEffect(() => {
    if (!selectedSession || selectedSession.type !== "execute" || !selectedSession.executeBranches || selectedSession.executeBranches.length === 0) {
      setExecuteAllTasksInstructions([]);
      return;
    }
    api.getTaskInstructions(repoId, selectedSession.executeBranches)
      .then(setExecuteAllTasksInstructions)
      .catch(() => setExecuteAllTasksInstructions([]));
  }, [selectedSession?.id, selectedSession?.executeBranches, repoId]);

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
          // Check for optimistic temp session with same baseBranch
          const tempSession = prev.find(s => s.id.startsWith("temp-") && s.baseBranch === newSession.baseBranch);
          if (tempSession) {
            // Replace temp with real session and update tab IDs
            setOpenTabIds((ids) => ids.map((id) => id === tempSession.id ? newSession.id : id));
            setActiveTabId((current) => current === tempSession.id ? newSession.id : current);
            return prev.map((s) => s.id === tempSession.id ? newSession : s);
          }
          return [newSession, ...prev];
        });
      }
    });

    const unsubUpdated = wsClient.on("planning.updated", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const updated = msg.data as Partial<PlanningSession> & { id: string };
        setSessions((prev) => prev.map((s) => {
          if (s.id === updated.id) {
            // Merge updated fields with existing session (preserve nodes/edges if not in update)
            return { ...s, ...updated, nodes: updated.nodes ?? s.nodes, edges: updated.edges ?? s.edges };
          }
          return s;
        }));
        if (activeTabId === updated.id) {
          const existing = sessions.find(s => s.id === updated.id);
          if (existing) {
            const merged = { ...existing, ...updated, nodes: updated.nodes ?? existing.nodes, edges: updated.edges ?? existing.edges };
            onSessionSelect?.(merged as PlanningSession);
            onTasksChange?.(merged.nodes, merged.edges);
          }
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

    // Handle real-time task updates from MCP tools
    const unsubTasksUpdated = wsClient.on("planning.tasksUpdated", (msg) => {
      if (msg.data && typeof msg.data === "object" && "nodes" in msg.data && "edges" in msg.data) {
        const { nodes, edges } = msg.data as { nodes: TaskNode[]; edges: TaskEdge[] };
        const sessionId = (msg.data as { planningSessionId?: string }).planningSessionId;
        if (sessionId) {
          setSessions((prev) => prev.map((s) => {
            if (s.id === sessionId) {
              return { ...s, nodes, edges };
            }
            return s;
          }));
          if (activeTabId === sessionId) {
            const existing = sessions.find(s => s.id === sessionId);
            if (existing) {
              const merged = { ...existing, nodes, edges };
              onSessionSelect?.(merged as PlanningSession);
              onTasksChange?.(nodes, edges);
            }
          }
        }
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
      unsubDiscarded();
      unsubConfirmed();
      unsubTasksUpdated();
    };
  }, [repoId, selectedSession?.id]);

  // Note: Execute session branch advancement is handled by MCP tool mark_branch_complete
  // No auto-advance on streaming.end - AI must explicitly call mark_branch_complete

  // Auto-generate session title when streaming ends
  const messageCountRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!selectedSession?.chatSessionId) return;

    const unsubStreamingEnd = wsClient.on("chat.streaming.end", async (msg) => {
      const data = msg.data as { sessionId: string; message?: { content: string } };
      if (data.sessionId !== selectedSession.chatSessionId) return;

      // Track message count per session
      const currentCount = (messageCountRef.current.get(selectedSession.id) || 0) + 1;
      messageCountRef.current.set(selectedSession.id, currentCount);

      // Title generation - update if untitled (null) or within first 6 messages
      const isUntitled = !selectedSession.title;
      const shouldUpdateTitle = currentCount <= 6 || isUntitled;
      if (shouldUpdateTitle) {
        try {
          const result = await api.generateSessionTitle(selectedSession.id, currentCount);
          if (result.updated) {
            setSessions((prev) =>
              prev.map((s) => s.id === selectedSession.id ? { ...s, title: result.title } : s)
            );
          }
        } catch (err) {
          console.error("[PlanningPanel] Title generation failed:", err);
        }
      }

      // Note: For Planning sessions, branch advancement is handled by MCP tool `mark_branch_complete`
      // which broadcasts `planning.taskAdvanced` event. No auto-advance here.
    });

    return () => {
      unsubStreamingEnd();
    };
  }, [selectedSession?.id, selectedSession?.chatSessionId, selectedSession?.title, selectedSession?.type, selectedSession?.executeBranches]);

  // Track Claude working state for planning and execute sessions
  useEffect(() => {
    if (!selectedSession?.chatSessionId || (selectedSession.type !== "planning" && selectedSession.type !== "execute")) {
      setClaudeWorking(false);
      return;
    }

    const unsubStart = wsClient.on("chat.streaming.start", (msg) => {
      const data = msg.data as { sessionId: string };
      if (data.sessionId === selectedSession.chatSessionId) {
        setClaudeWorking(true);
      }
    });

    const unsubEnd = wsClient.on("chat.streaming.end", (msg) => {
      const data = msg.data as { sessionId: string };
      if (data.sessionId === selectedSession.chatSessionId) {
        setClaudeWorking(false);
      }
    });

    return () => {
      unsubStart();
      unsubEnd();
    };
  }, [selectedSession?.chatSessionId, selectedSession?.type]);

  // Handle branch switch events from MCP server (set_focused_branch, switch_branch)
  // Handle task advancement for both Planning and Execute sessions
  useEffect(() => {
    if (!selectedSession || (selectedSession.type !== "planning" && selectedSession.type !== "execute")) {
      return;
    }

    const unsubTaskAdvanced = wsClient.on("planning.taskAdvanced", (msg) => {
      const data = msg.data as { id: string; newIndex?: number; currentExecuteIndex?: number };
      if (data.id === selectedSession.id) {
        const newIndex = data.newIndex ?? data.currentExecuteIndex ?? 0;
        // Update local state for Planning sessions
        if (selectedSession.type === "planning") {
          setPlanningCurrentBranchIndex(newIndex);
        }
        // Update the session in the list (for both Planning and Execute)
        setSessions((prev) =>
          prev.map((s) =>
            s.id === selectedSession.id
              ? { ...s, currentExecuteIndex: newIndex }
              : s
          )
        );
      }
    });

    return () => {
      unsubTaskAdvanced();
    };
  }, [selectedSession?.id, selectedSession?.type]);

  // Handle instruction updates from MCP server
  useEffect(() => {
    if (!selectedSession || selectedSession.type !== "planning") {
      return;
    }

    const planningBranches = selectedSession.executeBranches || [];
    const viewingBranch = planningBranches[userViewBranchIndex];
    if (!viewingBranch) return;

    const unsubInstructionUpdated = wsClient.on("taskInstruction.updated", (msg) => {
      const data = msg.data as { branchName: string; instructionMd: string };
      // Only update if this is the currently displayed (user's viewing) branch
      if (data.branchName === viewingBranch && !instructionDirty) {
        setCurrentInstruction(data.instructionMd || "");
      }
    });

    return () => {
      unsubInstructionUpdated();
    };
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches, userViewBranchIndex, instructionDirty]);

  // Load external links when session or current branch changes
  useEffect(() => {
    if (!selectedSession) return;
    const sessionId = selectedSession.id;
    // For Planning/Execute sessions, filter by current branch
    const branchName = (selectedSession.type === "planning" || selectedSession.type === "execute")
      ? (selectedSession.executeBranches || [])[selectedSession.currentExecuteIndex ?? 0]
      : undefined;
    api.getExternalLinks(sessionId, branchName)
      .then((links) => {
        setExternalLinksMap((prev) => ({ ...prev, [sessionId]: links }));
      })
      .catch(console.error);
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.currentExecuteIndex]);

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
    // For planning sessions with branches, use the user's viewing branch; otherwise use baseBranch
    const branchToLoad = selectedSession.executeBranches && selectedSession.executeBranches.length > 0
      ? selectedSession.executeBranches[userViewBranchIndex] || selectedSession.baseBranch
      : selectedSession.baseBranch;

    setInstructionLoading(true);
    api.getTaskInstruction(repoId, branchToLoad)
      .then((instruction) => {
        setCurrentInstruction(instruction?.instructionMd || "");
        setInstructionDirty(false);
      })
      .catch(console.error)
      .finally(() => setInstructionLoading(false));
  }, [selectedSession?.id, selectedSession?.executeBranches, userViewBranchIndex, repoId]);

  // Load branch links (PR/Issue) for all Planning session branches
  useEffect(() => {
    if (!selectedSession || !repoId || selectedSession.type !== "planning") {
      setPlanningAllBranchLinks(new Map());
      return;
    }
    const planningBranches = selectedSession.executeBranches || [];
    if (planningBranches.length === 0) {
      setPlanningAllBranchLinks(new Map());
      return;
    }

    const loadAllBranchLinks = async () => {
      const linksMap = new Map<string, BranchLink[]>();
      await Promise.all(
        planningBranches.map(async (branch) => {
          try {
            const links = await api.getBranchLinks(repoId, branch);
            linksMap.set(branch, links);
          } catch {
            linksMap.set(branch, []);
          }
        })
      );
      setPlanningAllBranchLinks(linksMap);
    };

    loadAllBranchLinks();
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches, repoId]);

  // Subscribe to branch link updates for Planning sessions
  useEffect(() => {
    if (!selectedSession || !repoId || selectedSession.type !== "planning") return;
    const planningBranches = selectedSession.executeBranches || [];
    if (planningBranches.length === 0) return;

    const unsubCreated = wsClient.on("branchLink.created", (msg) => {
      const data = msg.data as BranchLink;
      if (data.repoId === repoId && planningBranches.includes(data.branchName)) {
        setPlanningAllBranchLinks((prev) => {
          const newMap = new Map(prev);
          const current = newMap.get(data.branchName) || [];
          if (!current.some((l) => l.id === data.id)) {
            newMap.set(data.branchName, [data, ...current]);
          }
          return newMap;
        });
      }
    });

    const unsubUpdated = wsClient.on("branchLink.updated", (msg) => {
      const data = msg.data as BranchLink;
      if (data.repoId === repoId && planningBranches.includes(data.branchName)) {
        setPlanningAllBranchLinks((prev) => {
          const newMap = new Map(prev);
          const current = newMap.get(data.branchName) || [];
          newMap.set(data.branchName, current.map((l) => (l.id === data.id ? data : l)));
          return newMap;
        });
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
    };
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches, repoId]);

  // Load external links and files for the current planning branch
  useEffect(() => {
    if (!selectedSession || !repoId || selectedSession.type !== "planning") {
      setPlanningExternalLinks([]);
      setPlanningBranchFiles([]);
      return;
    }
    const planningBranches = selectedSession.executeBranches || [];
    const currentBranch = planningBranches[userViewBranchIndex];
    if (!currentBranch) {
      setPlanningExternalLinks([]);
      setPlanningBranchFiles([]);
      return;
    }

    Promise.all([
      api.getBranchExternalLinks(repoId, currentBranch).catch(() => []),
      api.getBranchFiles(repoId, currentBranch).catch(() => []),
    ]).then(([extLinks, files]) => {
      setPlanningExternalLinks(extLinks);
      setPlanningBranchFiles(files);
    });
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches, repoId, userViewBranchIndex]);

  // Load resource counts for all planning branches (for tree badges)
  useEffect(() => {
    if (!selectedSession || !repoId || selectedSession.type !== "planning") {
      setPlanningResourceCounts(new Map());
      return;
    }
    const planningBranches = selectedSession.executeBranches || [];
    if (planningBranches.length === 0) {
      setPlanningResourceCounts(new Map());
      return;
    }

    Promise.all([
      api.getBranchExternalLinksBatch(repoId, planningBranches).catch(() => ({})),
      api.getBranchFilesBatch(repoId, planningBranches).catch(() => ({})),
    ]).then(([extLinksMap, filesMap]) => {
      const countsMap = new Map<string, { figma: number; githubIssue: number; notion: number; other: number; files: number }>();
      for (const branch of planningBranches) {
        const extLinks = (extLinksMap as Record<string, BranchExternalLink[]>)[branch] || [];
        const files = (filesMap as Record<string, BranchFile[]>)[branch] || [];
        countsMap.set(branch, {
          figma: extLinks.filter((l: BranchExternalLink) => l.linkType === "figma").length,
          githubIssue: extLinks.filter((l: BranchExternalLink) => l.linkType === "github_issue").length,
          notion: extLinks.filter((l: BranchExternalLink) => l.linkType === "notion").length,
          other: extLinks.filter((l: BranchExternalLink) => l.linkType !== "figma" && l.linkType !== "github_issue" && l.linkType !== "notion").length,
          files: files.length,
        });
      }
      setPlanningResourceCounts(countsMap);
    });
  }, [selectedSession?.id, selectedSession?.type, selectedSession?.executeBranches, repoId]);

  // Clear pending nodes when session changes
  useEffect(() => {
    pendingNodesRef.current = [];
  }, [selectedSession?.id]);


  const handleCreateSession = async () => {
    // All session types use defaultBranch
    const baseBranch = defaultBranch;
    if (!baseBranch) return;
    setCreating(true);
    setError(null);
    try {
      const session = await api.createPlanningSession(
        repoId,
        baseBranch,
        undefined, // Title is auto-generated
        newSessionType
      );
      // State will be updated via WebSocket planning.created event
      // Replace empty tab if current tab is empty
      const replaceEmpty = activeTabId !== null && isEmptyTab(activeTabId);
      openTab(session, replaceEmpty);
      setShowNewForm(false);
      setNewSessionType("refinement");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // Tab management functions
  const openTab = useCallback((session: PlanningSession, replaceEmptyTab = false) => {
    setOpenTabIds((prev) => {
      // If session already open, just switch to it
      if (prev.includes(session.id)) {
        return prev;
      }
      // If replacing an empty tab, swap it with the session
      if (replaceEmptyTab && activeTabId && isEmptyTab(activeTabId)) {
        return prev.map((id) => (id === activeTabId ? session.id : id));
      }
      return [...prev, session.id];
    });
    setActiveTabId(session.id);
    // onSessionSelect will be called in the useEffect below
    if (session.chatSessionId) {
      markAsSeen(session.chatSessionId);
    }
  }, [markAsSeen, activeTabId]);

  const closeTab = useCallback((tabId: string) => {
    setOpenTabIds((prev) => {
      const newTabs = prev.filter((id) => id !== tabId);
      // If closing the last tab, replace with a new empty tab
      if (newTabs.length === 0) {
        const newEmptyTabId = `__new__${Date.now()}`;
        setActiveTabId(newEmptyTabId);
        return [newEmptyTabId];
      }
      // If closing the active tab, switch to the last remaining tab
      if (activeTabId === tabId) {
        setActiveTabId(newTabs[newTabs.length - 1]);
      }
      return newTabs;
    });
  }, [activeTabId]);

  // Notify parent when active session changes (avoids setState during render)
  useEffect(() => {
    onSessionSelect?.(selectedSession);
  }, [selectedSession, onSessionSelect]);

  // Mark active session as seen when messages arrive
  useEffect(() => {
    if (selectedSession?.chatSessionId) {
      markAsSeen(selectedSession.chatSessionId);
    }
  }, [selectedSession?.chatSessionId, markAsSeen]);

  const switchTab = useCallback((sessionId: string) => {
    setActiveTabId(sessionId);
    const session = sessions.find(s => s.id === sessionId);
    // onSessionSelect will be called in the useEffect above
    if (session?.chatSessionId) {
      markAsSeen(session.chatSessionId);
    }
  }, [sessions, markAsSeen]);

  const handleSelectSession = (session: PlanningSession) => {
    // If current tab is an empty tab, replace it with the selected session
    const replaceEmpty = activeTabId !== null && isEmptyTab(activeTabId);
    openTab(session, replaceEmpty);
  };

  // Start planning session from pending planning (optimistic update)
  const handleStartPlanningSession = async () => {
    if (!pendingPlanning) return;

    // Generate temporary ID for optimistic update
    const tempId = `temp-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    // Create optimistic session object
    const optimisticSession: PlanningSession = {
      id: tempId,
      repoId,
      title: `Planning: ${pendingPlanning.branchName}`,
      type: "planning",
      baseBranch: pendingPlanning.branchName,
      status: "draft",
      nodes: [],
      edges: [],
      chatSessionId: null,
      executeBranches: null,
      currentExecuteIndex: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Immediately show the session (optimistic)
    setSessions((prev) => [optimisticSession, ...prev]);
    openTab(optimisticSession);
    onPlanningStarted?.();

    // Create on server in background
    try {
      const realSession = await api.createPlanningSession(
        repoId,
        pendingPlanning.branchName,
        `Planning: ${pendingPlanning.branchName}`,
        "planning"
      );
      // WebSocket handler may have already replaced temp session
      // Check current state and only update if temp still exists
      setSessions((prev) => {
        const hasTempSession = prev.some((s) => s.id === tempId);
        if (!hasTempSession) {
          // Already handled by WebSocket, nothing to do
          return prev;
        }
        // Replace temp with real (or remove if WebSocket added real)
        const hasReal = prev.some((s) => s.id === realSession.id);
        if (hasReal) {
          return prev.filter((s) => s.id !== tempId);
        }
        return prev.map((s) => s.id === tempId ? realSession : s);
      });
      // Update tab IDs if temp still exists
      setOpenTabIds((prev) => {
        if (!prev.includes(tempId)) return prev;
        return prev.map((id) => id === tempId ? realSession.id : id);
      });
      setActiveTabId((current) => current === tempId ? realSession.id : current);
      // Update selected session if it's the optimistic one
      if (selectedSession?.id === tempId) {
        onSessionSelect?.(realSession);
      }
    } catch (err) {
      // Remove optimistic session on error
      setSessions((prev) => prev.filter((s) => s.id !== tempId));
      setOpenTabIds((prev) => prev.filter((id) => id !== tempId));
      setError((err as Error).message);
    }
  };

  // Auto-start planning session when pendingPlanning is set
  useEffect(() => {
    if (pendingPlanning && !creating) {
      handleStartPlanningSession();
    }
  }, [pendingPlanning]);

  // Fetch branch links when tasks change
  useEffect(() => {
    if (!selectedSession || selectedSession.type !== "refinement") return;

    const branchNames = selectedSession.nodes
      .map((n) => n.branchName)
      .filter((b): b is string => !!b);

    if (branchNames.length === 0) {
      setTaskBranchLinksMap({});
      return;
    }

    api.getBranchExternalLinksBatch(repoId, branchNames)
      .then((links) => {
        setTaskBranchLinksMap(links);
      })
      .catch((err) => {
        console.error("Failed to fetch branch links:", err);
      });
  }, [repoId, selectedSession?.id, selectedSession?.nodes]);

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
    if (selectedSession.type !== "planning" && selectedSession.nodes.length === 0) {
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

  const handleUnconfirm = async () => {
    if (!selectedSession) return;
    setLoading(true);
    try {
      const updated = await api.unconfirmPlanningSession(selectedSession.id);
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

  // Finalize Planning Session
  const handleFinalizePlanning = async () => {
    if (!selectedSession) return;
    try {
      const updated = await api.confirmPlanningSession(selectedSession.id);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
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

  // Planning Session handlers
  const handlePlanningBranchesChange = (branches: string[]) => {
    setPlanningSelectedBranches(branches);
  };

  const handleStartPlanning = async () => {
    if (!selectedSession || planningSelectedBranches.length === 0) return;
    setPlanningLoading(true);
    try {
      const updated = await api.updateExecuteBranches(selectedSession.id, planningSelectedBranches);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPlanningLoading(false);
    }
  };

  const handlePlanningBranchSwitch = (branchIndex: number) => {
    // Only change user's view, not AI's working branch
    setUserViewBranchIndex(branchIndex);
  };

  // Generate title from conversation history (no chat history impact)
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const handleGenerateTitle = async () => {
    if (!selectedSession) return;
    setGeneratingTitle(true);
    try {
      const result = await api.generateSessionTitle(selectedSession.id, 999); // Force generation
      if (result.updated) {
        setSessions((prev) =>
          prev.map((s) => s.id === selectedSession.id ? { ...s, title: result.title } : s)
        );
      }
    } catch (err) {
      console.error("[PlanningPanel] Title generation failed:", err);
    } finally {
      setGeneratingTitle(false);
    }
  };

  // Execute Session edit mode handlers
  const handleStartExecuteEdit = () => {
    if (!selectedSession) return;
    setExecuteEditTitle(selectedSession.title);
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

  // Manual branch switch for Execute Session
  // TODO: Add API endpoint for setting currentExecuteIndex
  const handleManualBranchSwitch = useCallback((_branchIndex: number) => {
    if (!selectedSession || selectedSession.type !== "execute") return;
    // For now, manual branch switching is view-only (via preview)
    // Full implementation would require an API to update currentExecuteIndex
  }, [selectedSession]);

  // Note: ToDo and Question updates are now handled via MCP tools
  // The MCP server directly updates the database and sends WebSocket notifications

  // Note: Branch completion and advancement is handled by MCP tool mark_branch_complete
  // Frontend only logs completion for debugging
  const handleBranchCompleted = useCallback((branchName: string) => {
    console.log(`[PlanningPanel] Branch ${branchName} todos completed (MCP will handle advancement)`);
  }, []);

  // Get current branch for Planning/Execute sessions
  const getCurrentBranchName = (): string | undefined => {
    if (!selectedSession) return undefined;
    if (selectedSession.type === "planning" || selectedSession.type === "execute") {
      const branches = selectedSession.executeBranches || [];
      const index = selectedSession.currentExecuteIndex ?? 0;
      return branches[index] || undefined;
    }
    return undefined; // Refinement sessions don't have branch-specific links
  };

  // External link handlers
  const handleAddLink = async () => {
    if (!newLinkUrl.trim() || !selectedSession || addingLinkCount > 0) return;

    // Capture session ID at start to handle session switching during async
    const sessionId = selectedSession.id;
    const branchName = getCurrentBranchName();
    // Split by newlines and filter valid URLs
    const urls = newLinkUrl
      .split(/[\n\r]+/)
      .map((u) => u.trim())
      .filter((u) => u && (u.startsWith("http://") || u.startsWith("https://")));

    if (urls.length === 0) return;

    const updateCount = (countOrFn: number | ((prev: number) => number)) => {
      setAddingLinkCountMap((prev) => ({
        ...prev,
        [sessionId]: typeof countOrFn === 'function' ? countOrFn(prev[sessionId] || 0) : countOrFn,
      }));
    };

    updateCount(urls.length);
    setNewLinkUrl("");

    // Process all URLs in parallel, preserve original order
    const results: (ExternalLink | null)[] = new Array(urls.length).fill(null);

    const promises = urls.map(async (url, index) => {
      try {
        const link = await api.addExternalLink(sessionId, url, undefined, branchName);
        results[index] = link;
        updateCount((prev) => Math.max(0, prev - 1));
        // Update with all completed links so far, in order
        setExternalLinksMap((prev) => ({
          ...prev,
          [sessionId]: [
            ...(prev[sessionId] || []),
            ...results.filter((r): r is ExternalLink => r !== null && !(prev[sessionId] || []).some(l => l.id === r.id)),
          ],
        }));
        return link;
      } catch (err) {
        console.error("Failed to add link:", url, err);
        updateCount((prev) => Math.max(0, prev - 1));
        return null;
      }
    });

    await Promise.all(promises);
    updateCount(0);
  };

  const [linksCopied, setLinksCopied] = useState(false);

  const handleCopyAllLinks = () => {
    const urls = externalLinks.map((link) => link.url).join("\n");
    navigator.clipboard.writeText(urls);
    setLinksCopied(true);
    setTimeout(() => setLinksCopied(false), 2000);
  };

  const handleRemoveLink = async (id: number) => {
    if (!selectedSession) return;
    const sessionId = selectedSession.id;
    try {
      await api.deleteExternalLink(id);
      setExternalLinksMap((prev) => ({
        ...prev,
        [sessionId]: (prev[sessionId] || []).filter((l) => l.id !== id),
      }));
    } catch (err) {
      console.error("Failed to remove link:", err);
    }
  };

  // Task suggestion from chat
  const handleTaskSuggested = useCallback(async (suggestion: TaskSuggestion) => {
    // Use the ref to get the latest session (may have been updated by previous async calls)
    const currentSession = selectedSessionRef.current;
    if (!currentSession) return;

    const newNode: TaskNode = {
      id: crypto.randomUUID(),
      title: suggestion.label,
      description: suggestion.description,
      branchName: suggestion.branchName,
      issueUrl: suggestion.issueUrl,
    };

    // Add to pending nodes so subsequent calls can find this node
    pendingNodesRef.current = [...pendingNodesRef.current, newNode];

    // Combine session nodes with pending nodes for parent lookup
    const allKnownNodes = [...currentSession.nodes, ...pendingNodesRef.current];
    const updatedNodes = [...currentSession.nodes, newNode];

    // Find parent by label if specified (look in both session nodes and pending nodes)
    let updatedEdges = [...currentSession.edges];
    if (suggestion.parentLabel) {
      const parentNode = allKnownNodes.find(
        (n) => n.title.toLowerCase() === suggestion.parentLabel?.toLowerCase()
      );
      if (parentNode) {
        updatedEdges.push({ parent: parentNode.id, child: newNode.id });
      }
    }

    try {
      const updated = await api.updatePlanningSession(currentSession.id, {
        nodes: updatedNodes,
        edges: updatedEdges,
      });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onTasksChange?.(updated.nodes, updated.edges);
      // Remove from pending nodes after successful save
      pendingNodesRef.current = pendingNodesRef.current.filter((n) => n.id !== newNode.id);
    } catch (err) {
      console.error("Failed to add task:", err);
      // Remove from pending nodes on error too
      pendingNodesRef.current = pendingNodesRef.current.filter((n) => n.id !== newNode.id);
    }
  }, [onTasksChange]);

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

  // Drag and drop handlers for reordering tasks (serial order)
  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || !selectedSession) return;

    const draggedId = active.id as string;
    const overId = over.id as string;

    // Don't reorder if dropped on self
    if (draggedId === overId) return;

    const oldIndex = selectedSession.nodes.findIndex((n) => n.id === draggedId);
    const newIndex = selectedSession.nodes.findIndex((n) => n.id === overId);

    if (oldIndex === -1 || newIndex === -1) return;

    // Reorder nodes using arrayMove
    const reorderedNodes = arrayMove(selectedSession.nodes, oldIndex, newIndex);

    // Generate serial edges (each task depends on the previous one)
    const serialEdges: TaskEdge[] = [];
    for (let i = 0; i < reorderedNodes.length - 1; i++) {
      const current = reorderedNodes[i];
      const next = reorderedNodes[i + 1];
      if (current && next) {
        serialEdges.push({ parent: current.id, child: next.id });
      }
    }

    // Optimistic update
    setSessions((prev) => prev.map((s) =>
      s.id === selectedSession.id ? { ...s, nodes: reorderedNodes, edges: serialEdges } : s
    ));
    onTasksChange?.(reorderedNodes, serialEdges);

    try {
      await api.updatePlanningSession(selectedSession.id, {
        nodes: reorderedNodes,
        edges: serialEdges,
      });
    } catch (err) {
      console.error("Failed to reorder tasks:", err);
      // Revert on error
      setSessions((prev) => prev.map((s) =>
        s.id === selectedSession.id ? selectedSession : s
      ));
      onTasksChange?.(selectedSession.nodes, selectedSession.edges);
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

  // Helper to get open tab data (sessions or empty tabs)
  type TabData = { type: "session"; session: PlanningSession } | { type: "empty"; id: string };
  const openTabs: TabData[] = openTabIds
    .map((id): TabData | null => {
      if (isEmptyTab(id)) {
        return { type: "empty", id };
      }
      const session = sessions.find((s) => s.id === id);
      return session ? { type: "session", session } : null;
    })
    .filter((t): t is TabData => t !== null);

  // Render tab bar (always shown)
  const renderTabBar = () => {
    const showNewTab = openTabs.length === 0;
    return (
      <div className="planning-panel__tab-bar">
        {showNewTab ? (
          // Show "New" tab when no sessions are open
          <div
            className="planning-panel__tab planning-panel__tab--active planning-panel__tab--new"
            onClick={() => {
              const newTabId = `__new__${emptyTabCounter}`;
              setEmptyTabCounter((c) => c + 1);
              setOpenTabIds([newTabId]);
              setActiveTabId(newTabId);
            }}
          >
            <span className="planning-panel__tab-icon">+</span>
            <span className="planning-panel__tab-title">New</span>
          </div>
        ) : (
          <>
            {openTabs.map((tab) => {
              if (tab.type === "empty") {
                const isActive = tab.id === activeTabId;
                return (
                  <div
                    key={tab.id}
                    className={`planning-panel__tab planning-panel__tab--new ${isActive ? "planning-panel__tab--active" : ""}`}
                    onClick={() => setActiveTabId(tab.id)}
                  >
                    <span className="planning-panel__tab-icon">+</span>
                    <span className="planning-panel__tab-title">New</span>
                    <button
                      className="planning-panel__tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              }
              const session = tab.session;
              const sessionType = session.type || "refinement";
              const typeIcon = sessionType === "refinement" ? "💭" : sessionType === "planning" ? "📋" : "⚡";
              const isActive = session.id === activeTabId;
              const notification = session.chatSessionId ? getNotification(session.chatSessionId) : null;
              const isThinking = notification?.isThinking;
              // Session tabs can always be closed (will be replaced with empty tab if last one)
              return (
                <div
                  key={session.id}
                  className={`planning-panel__tab ${isActive ? "planning-panel__tab--active" : ""} planning-panel__tab--${sessionType}`}
                  onClick={() => switchTab(session.id)}
                >
                  {isThinking && <span className="planning-panel__tab-thinking-indicator" />}
                  <span className="planning-panel__tab-icon">{typeIcon}</span>
                  <span className={`planning-panel__tab-title${!session.title ? " planning-panel__tab-title--untitled" : ""}`}>
                    {session.title || "Untitled Session"}
                  </span>
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
                const newTabId = `__new__${emptyTabCounter}`;
                setEmptyTabCounter((c) => c + 1);
                setOpenTabIds((prev) => [...prev, newTabId]);
                setActiveTabId(newTabId);
              }}
              title="New Session"
            >
              +
            </button>
          </>
        )}
        {onToggleFullscreen && (
          <button
            className="planning-panel__fullscreen-toggle"
            onClick={onToggleFullscreen}
            title={chatFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {chatFullscreen ? "⤓" : "⤢"}
          </button>
        )}
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
            {/* Branch selection only for Refinement (Planning/Execute select branches later) */}
            {/* All session types use defaultBranch - no branch selection needed */}
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
              <div className={`planning-panel__session-title${!session.title ? " planning-panel__session-title--untitled" : ""}`}>
                {session.title || "Untitled Session"}
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
            <span className={`planning-panel__header-title${!selectedSession.title ? " planning-panel__header-title--untitled" : ""}`}>
              {selectedSession.title || "Untitled Session"}
              {!executeEditMode && (
                <button
                  className={`planning-panel__generate-title-btn${generatingTitle ? " planning-panel__generate-title-btn--loading" : ""}`}
                  onClick={handleGenerateTitle}
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
                  onClick={handleDelete}
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
                {/* Current branch indicator */}
                {selectedSession.executeBranches[selectedSession.currentExecuteIndex] && (
                  <div className="planning-panel__branch-indicator">
                    <span className="planning-panel__branch-indicator-label">
                      {claudeWorking ? "🤖 Working on:" : "📍 Current:"}
                    </span>
                    <span className="planning-panel__branch-indicator-name">
                      {selectedSession.executeBranches[selectedSession.currentExecuteIndex]}
                    </span>
                    <span className="planning-panel__branch-indicator-hint">
                      Task {selectedSession.currentExecuteIndex + 1} of {selectedSession.executeBranches.length}
                    </span>
                  </div>
                )}
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
                      allTasks: executeAllTasksInstructions.length > 0
                        ? executeAllTasksInstructions
                        : selectedSession.executeBranches.map(b => ({ branchName: b, instruction: null })),
                    }}
                  />
                )}
              </div>

              {/* Resizer */}
              <div
                className="planning-panel__resizer"
                onMouseDown={handleResizeStart}
              />

              {/* Sidebar */}
              <div className="planning-panel__sidebar" style={{ width: sidebarWidth }}>
                <ExecuteSidebar
                  repoId={repoId}
                  executeBranches={selectedSession.executeBranches}
                  currentExecuteIndex={selectedSession.currentExecuteIndex}
                  planningSessionId={selectedSession.id}
                  onManualBranchSwitch={handleManualBranchSwitch}
                  onBranchCompleted={handleBranchCompleted}
                  workingBranch={claudeWorking ? selectedSession.executeBranches[selectedSession.currentExecuteIndex] : null}
                />
              </div>
            </div>
          )}
        </div>
      );
    }

    // Planning Session
    if (sessionTypeValue === "planning") {
      const planningBranches = selectedSession.executeBranches || [];
      const hasBranches = planningBranches.length > 0;
      const planningStatus = hasBranches ? "in_progress" : "draft";
      const planningStatusLabel = hasBranches ? "In Progress" : "Draft";
      // User's viewing branch (separate from AI's working branch)
      const currentPlanningBranch = hasBranches
        ? planningBranches[userViewBranchIndex]
        : null;

      return (
        <div className="planning-panel__detail-content">
          <div className="planning-panel__header">
            <span className={`planning-panel__session-type planning-panel__session-type--${sessionTypeValue}`}>
              <span className="planning-panel__session-type-icon">{sessionTypeIcon}</span>
              {sessionTypeLabel}
            </span>
            <span className={`planning-panel__execute-status planning-panel__execute-status--${planningStatus}`}>
              {planningStatusLabel}
            </span>
            <span className={`planning-panel__header-title${!selectedSession.title ? " planning-panel__header-title--untitled" : ""}`}>
              {selectedSession.title || "Untitled Session"}
              <button
                className={`planning-panel__generate-title-btn${generatingTitle ? " planning-panel__generate-title-btn--loading" : ""}`}
                onClick={handleGenerateTitle}
                disabled={generatingTitle}
                title="Generate title from conversation"
              >
                ↻
              </button>
            </span>
            {hasBranches && selectedSession.status !== "confirmed" && (
              <button
                className="planning-panel__finalize-btn"
                onClick={() => handleFinalizePlanning()}
                title="Finalize planning session"
              >
                Finalize
              </button>
            )}
            {selectedSession.status === "confirmed" && (
              <span className="planning-panel__finalized-badge">Finalized</span>
            )}
            <button
              className="planning-panel__delete-btn"
              onClick={handleDelete}
              title="Delete this session"
            >
              Delete
            </button>
          </div>

          {/* Branch Selection Mode (initial setup) */}
          {!hasBranches && (
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
          {hasBranches && (
            <div className="planning-panel__detail-main">
              {/* Chat */}
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
                {selectedSession.chatSessionId && (
                  <ChatPanel
                    sessionId={selectedSession.chatSessionId}
                    onTaskSuggested={handleTaskSuggested}
                    existingTaskLabels={selectedSession.nodes.map((n) => n.title)}
                    disabled={false}
                  />
                )}
              </div>

              {/* Resizer */}
              <div
                className="planning-panel__resizer"
                onMouseDown={handleResizeStart}
              />

              {/* Sidebar: Branches at top, then tabbed content */}
              <div className="planning-panel__sidebar" style={{ width: sidebarWidth }}>
                {/* Branch Tree (always visible at top) */}
                <div className="planning-panel__sidebar-branches">
                  <ExecuteBranchTree
                    branches={planningBranches}
                    selectedBranchIndex={userViewBranchIndex}
                    aiBranchIndex={claudeWorking ? planningCurrentBranchIndex : null}
                    onBranchSelect={(_branch, index) => handlePlanningBranchSwitch(index)}
                    completedBranches={new Set()}
                    branchTodoCounts={branchTodoCounts}
                    branchQuestionCounts={branchQuestionCounts}
                    branchLinks={planningAllBranchLinks}
                    branchResourceCounts={planningResourceCounts}
                    showCompletionCount={false}
                  />
                </div>

                {/* Branch Header with PR/Issue links */}
                {currentPlanningBranch && (() => {
                  const currentBranchLinks = planningAllBranchLinks.get(currentPlanningBranch) || [];
                  return (
                  <div className="execute-sidebar__branch-header">
                    <div className="execute-sidebar__branch-name">
                      {currentPlanningBranch}
                    </div>
                    {currentBranchLinks.length > 0 && (
                      <div className="execute-sidebar__links">
                        {currentBranchLinks.filter(l => l.linkType === "pr").map((prLink) => (
                          <a
                            key={prLink.id}
                            href={prLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="execute-sidebar__link execute-sidebar__link--pr"
                          >
                            PR #{prLink.number}
                            {prLink.checksStatus && (
                              <span className={`execute-sidebar__checks execute-sidebar__checks--${prLink.checksStatus}`}>
                                {prLink.checksStatus === "success" ? "✓" : prLink.checksStatus === "failure" ? "✕" : "◌"}
                              </span>
                            )}
                          </a>
                        ))}
                        {currentBranchLinks.filter(l => l.linkType === "issue").map((issueLink) => (
                          <a
                            key={issueLink.id}
                            href={issueLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="execute-sidebar__link execute-sidebar__link--issue"
                          >
                            Issue #{issueLink.number}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })()}

                {/* Tab Header */}
                {(() => {
                  const todoCount = currentPlanningBranch ? branchTodoCounts.get(currentPlanningBranch) : null;
                  const questionCount = currentPlanningBranch ? branchQuestionCounts.get(currentPlanningBranch) : null;
                  const hasTodos = todoCount && todoCount.total > 0;
                  const hasQuestions = questionCount && questionCount.total > 0;
                  const pendingQuestions = questionCount ? questionCount.pending + questionCount.answered : 0;
                  const resourceCount = planningExternalLinks.length + planningBranchFiles.length;
                  return (
                <div className="planning-panel__sidebar-tabs">
                  <button
                    className={`planning-panel__sidebar-tab ${planningSidebarTab === "instruction" ? "planning-panel__sidebar-tab--active" : ""}`}
                    onClick={() => setPlanningSidebarTab("instruction")}
                  >
                    Instruction
                  </button>
                  <button
                    className={`planning-panel__sidebar-tab ${planningSidebarTab === "todo" ? "planning-panel__sidebar-tab--active" : ""}`}
                    onClick={() => setPlanningSidebarTab("todo")}
                  >
                    ToDo
                    {hasTodos && (
                      <span className="planning-panel__tab-badge planning-panel__tab-badge--todo">
                        {todoCount.completed}/{todoCount.total}
                      </span>
                    )}
                  </button>
                  <button
                    className={`planning-panel__sidebar-tab ${planningSidebarTab === "questions" ? "planning-panel__sidebar-tab--active" : ""}`}
                    onClick={() => setPlanningSidebarTab("questions")}
                  >
                    Questions
                    {hasQuestions && pendingQuestions > 0 && (
                      <span className="planning-panel__tab-badge planning-panel__tab-badge--question">
                        {pendingQuestions}
                      </span>
                    )}
                  </button>
                  <button
                    className={`planning-panel__sidebar-tab ${planningSidebarTab === "resources" ? "planning-panel__sidebar-tab--active" : ""}`}
                    onClick={() => setPlanningSidebarTab("resources")}
                  >
                    Resources
                    {resourceCount > 0 && (
                      <span className="planning-panel__tab-badge planning-panel__tab-badge--resource">
                        {resourceCount}
                      </span>
                    )}
                  </button>
                </div>
                  );
                })()}

                {/* Tab Content */}
                <div className="planning-panel__sidebar-content">
                  {/* Instruction Tab */}
                  {planningSidebarTab === "instruction" && currentPlanningBranch && (
                    <div className="planning-panel__instruction">
                      <div className="planning-panel__instruction-header">
                        <h4>{currentPlanningBranch}</h4>
                        <div className="planning-panel__instruction-actions">
                          {instructionDirty && (
                            <span className="planning-panel__instruction-dirty">unsaved</span>
                          )}
                          {!instructionEditing ? (
                            <button
                              className="planning-panel__instruction-edit-btn"
                              onClick={() => setInstructionEditing(true)}
                            >
                              Edit
                            </button>
                          ) : (
                            <button
                              className="planning-panel__instruction-edit-btn"
                              onClick={() => {
                                setInstructionEditing(false);
                              }}
                            >
                              Done
                            </button>
                          )}
                        </div>
                      </div>
                      {instructionLoading ? (
                        <div className="planning-panel__instruction-loading">Loading...</div>
                      ) : instructionEditing ? (
                        <>
                          <textarea
                            className="planning-panel__instruction-textarea"
                            value={currentInstruction}
                            onChange={(e) => {
                              setCurrentInstruction(e.target.value);
                              setInstructionDirty(true);
                            }}
                            placeholder="Enter detailed task instructions..."
                          />
                          <button
                            className="planning-panel__instruction-save"
                            onClick={async () => {
                              if (!currentPlanningBranch) return;
                              setInstructionSaving(true);
                              try {
                                await api.updateTaskInstruction(repoId, currentPlanningBranch, currentInstruction);
                                setBranchInstructions((prev) => new Map(prev).set(currentPlanningBranch, currentInstruction));
                                setInstructionDirty(false);
                              } catch (err) {
                                console.error("Failed to save instruction:", err);
                                setError("Failed to save instruction");
                              } finally {
                                setInstructionSaving(false);
                              }
                            }}
                            disabled={!instructionDirty || instructionSaving}
                          >
                            {instructionSaving ? "Saving..." : "Save"}
                          </button>
                        </>
                      ) : (
                        <div className="planning-panel__instruction-view">
                          {currentInstruction ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {currentInstruction}
                            </ReactMarkdown>
                          ) : (
                            <span className="planning-panel__instruction-empty">
                              No instruction yet. Click Edit to add.
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ToDo Tab */}
                  {planningSidebarTab === "todo" && currentPlanningBranch && (
                    <div className="planning-panel__todo-section">
                      <ExecuteTodoList
                        repoId={repoId}
                        branchName={currentPlanningBranch}
                        planningSessionId={selectedSession.id}
                      />
                    </div>
                  )}

                  {/* Questions Tab */}
                  {planningSidebarTab === "questions" && (
                    <div className="planning-panel__questions-section">
                      <PlanningQuestionsPanel
                        planningSessionId={selectedSession.id}
                        branchName={currentPlanningBranch ?? undefined}
                      />
                    </div>
                  )}

                  {/* Resources Tab */}
                  {planningSidebarTab === "resources" && (
                    <div className="planning-panel__resources-section">
                      {/* External Links */}
                      {planningExternalLinks.length > 0 && (
                        <div className="execute-sidebar__links-section">
                          <div className="execute-sidebar__links-header">
                            <h4>Links</h4>
                          </div>
                          <div className="execute-sidebar__external-links">
                            {planningExternalLinks.map((link) => {
                              const icon = getResourceIcon(link.linkType);
                              return (
                                <a
                                  key={link.id}
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="execute-sidebar__external-link"
                                >
                                  <img
                                    src={icon.src}
                                    alt={icon.alt}
                                    className={`execute-sidebar__link-icon execute-sidebar__link-icon${icon.className}`}
                                  />
                                  <span className="execute-sidebar__external-link-text">
                                    {link.title || link.url}
                                  </span>
                                </a>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Files/Images */}
                      {planningBranchFiles.length > 0 && (
                        <div className="execute-sidebar__links-section">
                          <div className="execute-sidebar__links-header">
                            <h4>Files</h4>
                          </div>
                          <div className="execute-sidebar__files">
                            {planningBranchFiles.map((file) => {
                              const isImage = file.mimeType?.startsWith("image/");
                              return (
                                <div key={file.id} className="execute-sidebar__file">
                                  {isImage ? (
                                    <a
                                      href={api.getBranchFileUrl(file.id)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="execute-sidebar__file-image-link"
                                    >
                                      <img
                                        src={api.getBranchFileUrl(file.id)}
                                        alt={file.originalName || "Image"}
                                        className="execute-sidebar__file-thumbnail"
                                      />
                                    </a>
                                  ) : (
                                    <a
                                      href={api.getBranchFileUrl(file.id)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="execute-sidebar__file-link"
                                    >
                                      📄 {file.originalName || file.filePath}
                                    </a>
                                  )}
                                  {file.description && (
                                    <span className="execute-sidebar__file-description">{file.description}</span>
                                  )}
                                  {file.sourceType === "figma_mcp" && (
                                    <span className="execute-sidebar__file-source">From Figma</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Empty State */}
                      {planningExternalLinks.length === 0 && planningBranchFiles.length === 0 && (
                        <div className="execute-sidebar__no-links" style={{ padding: "12px" }}>
                          No resources attached to this branch
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Non-Execute, Non-Planning Session (Refinement)
    const refinementStatus = selectedSession.status === "confirmed" ? "confirmed" : "draft";
    const refinementStatusLabel = selectedSession.status === "confirmed" ? "Confirmed" : "Draft";

    return (
      <div className="planning-panel__detail-content">
        <div className="planning-panel__header">
          <span className={`planning-panel__session-type planning-panel__session-type--${sessionTypeValue}`}>
            <span className="planning-panel__session-type-icon">{sessionTypeIcon}</span>
            {sessionTypeLabel}
          </span>
          <span className={`planning-panel__execute-status planning-panel__execute-status--${refinementStatus}`}>
            {refinementStatusLabel}
          </span>
          <span className={`planning-panel__header-title${!selectedSession.title ? " planning-panel__header-title--untitled" : ""}`}>
            {selectedSession.title || "Untitled Session"}
            <button
              className={`planning-panel__generate-title-btn${generatingTitle ? " planning-panel__generate-title-btn--loading" : ""}`}
              onClick={handleGenerateTitle}
              disabled={generatingTitle}
              title="Generate title from conversation"
            >
              ↻
            </button>
          </span>
          <button
            className="planning-panel__delete-btn"
            onClick={handleDelete}
            title="Delete this session"
          >
            Delete
          </button>
        </div>

      {/* Non-Execute Session: Original layout */}
      <div className="planning-panel__detail-main">
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

        {/* Resizer */}
        <div
          className="planning-panel__resizer"
          onMouseDown={handleResizeStart}
        />

        {/* Sidebar: Links + Tasks */}
        <div className="planning-panel__sidebar" style={{ width: sidebarWidth }}>
          {/* External Links */}
          <div className="planning-panel__links">
            <div className="planning-panel__links-header">
              <h4>Links</h4>
              {externalLinks.length > 0 && (
                <button
                  className={`planning-panel__links-copy-btn${linksCopied ? ' planning-panel__links-copy-btn--copied' : ''}`}
                  onClick={handleCopyAllLinks}
                  title="Copy all links"
                >
                  {linksCopied ? 'Copied!' : 'Copy All'}
                </button>
              )}
            </div>
            <div className="planning-panel__links-list">
              {externalLinks.map((link) => {
                const { iconSrc, className } = getLinkTypeIcon(link.linkType);
                const isSessionLevel = link.branchName === null;
                // Extract sub-issue count from contentCache
                const subIssueMatch = link.contentCache?.match(/## Sub-Issues \((\d+)件\)/);
                const subIssueCount = subIssueMatch ? parseInt(subIssueMatch[1], 10) : 0;
                const linkTitle = link.branchName
                  ? `${link.title || link.url} (Branch: ${link.branchName})${subIssueCount > 0 ? ` - ${subIssueCount} sub-issues` : ''}`
                  : `${link.title || link.url}${subIssueCount > 0 ? ` - ${subIssueCount} sub-issues` : ''}`;
                return (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`planning-panel__link-icon ${className}${isSessionLevel ? ' planning-panel__link-icon--session' : ''}`}
                    title={linkTitle}
                  >
                    <img src={iconSrc} alt={link.linkType} />
                    {subIssueCount > 0 && (
                      <span className="planning-panel__link-sub-badge">{subIssueCount}</span>
                    )}
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
              {addingLinkCount > 0 && (
                Array.from({ length: addingLinkCount }).map((_, i) => (
                  <div key={`skeleton-${i}`} className="planning-panel__link-icon planning-panel__link-icon--loading">
                    <div className="planning-panel__link-skeleton" />
                  </div>
                ))
              )}
              {selectedSession.status === "draft" && addingLinkCount === 0 && (
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
              <div className="planning-panel__link-add-container">
                <textarea
                  className="planning-panel__link-add-input"
                  placeholder="Paste URLs (one per line)..."
                  value={newLinkUrl}
                  onChange={(e) => setNewLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      handleAddLink();
                      setShowLinkInput(false);
                    } else if (e.key === "Escape") {
                      setShowLinkInput(false);
                      setNewLinkUrl("");
                    }
                  }}
                  autoFocus
                />
                <button
                  className="planning-panel__link-add-submit"
                  onClick={() => {
                    handleAddLink();
                    setShowLinkInput(false);
                  }}
                  disabled={!newLinkUrl.trim()}
                >
                  Add (⌘+Enter)
                </button>
              </div>
            )}
          </div>

          {/* Task list - for Refinement sessions */}
          <div className="planning-panel__tasks">
              <h4>Tasks ({selectedSession.nodes.length})</h4>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={selectedSession.nodes.map((n) => n.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {selectedSession.nodes.map((task, index) => (
                    <SortableTaskItem
                      key={task.id}
                      task={task}
                      index={index}
                      isDraft={selectedSession.status === "draft"}
                      onRemove={() => handleRemoveTask(task.id)}
                      onBranchNameChange={(newName) => handleBranchNameChange(task.id, newName)}
                      links={task.branchName ? taskBranchLinksMap[task.branchName] : []}
                    />
                  ))}
                </SortableContext>
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
              <button onClick={handleUnconfirm} className="planning-panel__unconfirm-btn">
                Unconfirm
              </button>
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
