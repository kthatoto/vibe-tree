import { useState, useEffect, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  api,
  type Plan,
  type ScanSnapshot,
  type TreeNode,
  type RepoPin,
  type ChatSession,
  type ChatMessage,
  type TreeSpecNode,
  type TreeSpecEdge,
  type TaskStatus,
  type TreeSpecStatus,
  type BranchNamingRule,
} from "../lib/api";
import { wsClient } from "../lib/ws";
import BranchGraph from "../components/BranchGraph";

// Draggable task item component
function DraggableTask({
  task,
  children,
}: {
  task: TreeSpecNode;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.5 : 1, cursor: "grab" }}
    >
      {children}
    </div>
  );
}

// Droppable zone for tree nodes
function DroppableTreeNode({
  id,
  children,
  isOver,
}: {
  id: string;
  children: React.ReactNode;
  isOver?: boolean;
}) {
  const { setNodeRef, isOver: dropIsOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`droppable-zone ${dropIsOver || isOver ? "droppable-zone--over" : ""}`}
    >
      {children}
    </div>
  );
}

// Task card component for reuse
function TaskCard({
  task,
  onStatusChange,
  onRemove,
  onStart,
  onClick,
  onConsult,
  loading,
  compact,
  isLocked,
}: {
  task: TreeSpecNode;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onRemove: (taskId: string) => void;
  onStart: (taskId: string) => void;
  onClick?: (task: TreeSpecNode) => void;
  onConsult?: (task: TreeSpecNode) => void;
  loading: boolean;
  compact?: boolean;
  isLocked?: boolean;
}) {
  const hasWorktree = !!task.worktreePath;

  return (
    <div
      className={`task-card task-card--${task.status} ${compact ? "task-card--compact" : ""} ${hasWorktree ? "task-card--clickable" : ""}`}
      onClick={() => hasWorktree && onClick?.(task)}
    >
      <div className="task-card__header">
        <select
          value={task.status}
          onChange={(e) => onStatusChange(task.id, e.target.value as TaskStatus)}
          className="task-card__status"
          onClick={(e) => e.stopPropagation()}
          disabled={isLocked}
        >
          <option value="todo">Todo</option>
          <option value="doing">Doing</option>
          <option value="done">Done</option>
        </select>
        <span className="task-card__title">{task.title}</span>
        <div className="task-card__actions">
          {hasWorktree ? (
            <button
              className="task-card__open"
              onClick={(e) => {
                e.stopPropagation();
                onClick?.(task);
              }}
            >
              開く
            </button>
          ) : (
            <button
              className="task-card__consult"
              onClick={(e) => {
                e.stopPropagation();
                onConsult?.(task);
              }}
            >
              相談
            </button>
          )}
          {!isLocked && !task.branchName && task.status === "todo" && (
            <button
              className="task-card__start"
              onClick={(e) => {
                e.stopPropagation();
                onStart(task.id);
              }}
              disabled={loading}
            >
              Start
            </button>
          )}
          {!isLocked && (
            <button
              className="task-card__remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(task.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>
      {!compact && task.description && (
        <div className="task-card__description">{task.description}</div>
      )}
      <div className="task-card__meta">
        {task.branchName && (
          <span className="task-card__branch">{task.branchName}</span>
        )}
        {task.worktreePath && (
          <span className="task-card__worktree">WT</span>
        )}
      </div>
    </div>
  );
}

export default function TreeDashboard() {
  // Repo pins state
  const [repoPins, setRepoPins] = useState<RepoPin[]>([]);
  const [selectedPinId, setSelectedPinId] = useState<number | null>(null);
  const [newLocalPath, setNewLocalPath] = useState("");
  const [showAddNew, setShowAddNew] = useState(false);

  // Main state
  const [plan, setPlan] = useState<Plan | null>(null);
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Chat state
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // Tree Spec state (Task-based)
  const [wizardBaseBranch, setWizardBaseBranch] = useState<string>("main");
  const [wizardNodes, setWizardNodes] = useState<TreeSpecNode[]>([]);
  const [wizardEdges, setWizardEdges] = useState<TreeSpecEdge[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [newTaskParent, setNewTaskParent] = useState("");
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [wizardStatus, setWizardStatus] = useState<TreeSpecStatus>("draft");

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [settingsRule, setSettingsRule] = useState<BranchNamingRule | null>(null);
  const [settingsPattern, setSettingsPattern] = useState("");
  const [settingsDescription, setSettingsDescription] = useState("");
  const [settingsExamples, setSettingsExamples] = useState<string[]>([]);
  const [settingsNewExample, setSettingsNewExample] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // D&D sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Load repo pins on mount
  useEffect(() => {
    api.getRepoPins().then((pins) => {
      setRepoPins(pins);
      // Don't auto-select - show project list first
    }).catch(console.error);
  }, []);

  // Get selected pin
  const selectedPin = repoPins.find((p) => p.id === selectedPinId) ?? null;

  // Auto-scan when pin is selected
  useEffect(() => {
    if (selectedPin && !snapshot) {
      handleScan(selectedPin.localPath);
    }
  }, [selectedPin?.id]);

  // Load plan and connect WS when snapshot is available
  useEffect(() => {
    if (!snapshot?.repoId) return;

    api.getCurrentPlan(snapshot.repoId).then(setPlan).catch(console.error);
    wsClient.connect(snapshot.repoId);

    const unsubScan = wsClient.on("scan.updated", (msg) => {
      setSnapshot(msg.data as ScanSnapshot);
    });

    const unsubChatMessage = wsClient.on("chat.message", (msg) => {
      const message = msg.data as ChatMessage;
      setChatMessages((prev) => {
        // Avoid duplicates
        if (prev.some((m) => m.id === message.id)) return prev;
        return [...prev, message];
      });
      // Auto-scroll chat
      setTimeout(() => {
        if (chatRef.current) {
          chatRef.current.scrollTop = chatRef.current.scrollHeight;
        }
      }, 10);
    });

    return () => {
      unsubScan();
      unsubChatMessage();
    };
  }, [snapshot?.repoId]);

  const handleScan = useCallback(async (localPath: string) => {
    if (!localPath) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.scan(localPath);
      setSnapshot(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleAddRepoPin = async () => {
    if (!newLocalPath.trim()) return;
    try {
      const pin = await api.createRepoPin(newLocalPath.trim());
      setRepoPins((prev) => [pin, ...prev]);
      setSelectedPinId(pin.id);
      setNewLocalPath("");
      setShowAddNew(false);
      setSnapshot(null); // Will trigger auto-scan via useEffect
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSelectPin = async (id: number) => {
    setSelectedPinId(id);
    setSnapshot(null); // Reset to trigger new scan
    try {
      await api.useRepoPin(id);
    } catch (err) {
      console.error("Failed to mark pin as used:", err);
    }
  };

  const handleDeletePin = async (id: number) => {
    try {
      await api.deleteRepoPin(id);
      setRepoPins((prev) => prev.filter((p) => p.id !== id));
      if (selectedPinId === id) {
        setSelectedPinId(repoPins[0]?.id ?? null);
        setSnapshot(null);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Chat functions
  const handleOpenChat = async (worktreePath: string) => {
    if (!snapshot?.repoId) return;
    setChatLoading(true);
    setError(null);
    try {
      // Create or get existing session
      const session = await api.createChatSession(snapshot.repoId, worktreePath, plan?.id);
      setChatSession(session);
      // Load messages
      const messages = await api.getChatMessages(session.id);
      setChatMessages(messages);
      setShowChat(true);
      // Auto-scroll
      setTimeout(() => {
        if (chatRef.current) {
          chatRef.current.scrollTop = chatRef.current.scrollHeight;
        }
      }, 10);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChatLoading(false);
    }
  };

  const handleSendChat = async () => {
    if (!chatSession || !chatInput.trim()) return;
    setChatLoading(true);
    setError(null);
    const message = chatInput;
    setChatInput("");
    try {
      // Note: The response will come via WebSocket, but we also get it here
      await api.sendChatMessage(chatSession.id, message);
      // Messages are added via WebSocket handler
    } catch (err) {
      setError((err as Error).message);
      setChatInput(message); // Restore input on error
    } finally {
      setChatLoading(false);
    }
  };

  const handleCloseChat = () => {
    setShowChat(false);
    setChatSession(null);
    setChatMessages([]);
  };

  // Initialize tree spec state when snapshot changes
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.treeSpec) {
      setWizardBaseBranch(snapshot.treeSpec.baseBranch);
      setWizardNodes(snapshot.treeSpec.specJson.nodes);
      setWizardEdges(snapshot.treeSpec.specJson.edges);
      setWizardStatus(snapshot.treeSpec.status);
    } else {
      const baseBranch = snapshot.defaultBranch ?? "main";
      setWizardBaseBranch(baseBranch);
      setWizardNodes([]);
      setWizardEdges([]);
      setWizardStatus("draft");
    }
  }, [snapshot?.repoId]);

  const generateTaskId = () => crypto.randomUUID();

  const handleAddWizardTask = () => {
    if (!newTaskTitle.trim()) return;
    const newNode: TreeSpecNode = {
      id: generateTaskId(),
      title: newTaskTitle.trim(),
      description: newTaskDescription.trim() || undefined,
      status: "todo" as TaskStatus,
      branchName: undefined,
    };
    setWizardNodes((prev) => [...prev, newNode]);
    if (newTaskParent) {
      setWizardEdges((prev) => [...prev, { parent: newTaskParent, child: newNode.id }]);
    }
    setNewTaskTitle("");
    setNewTaskDescription("");
    setNewTaskParent("");
  };

  const handleRemoveWizardTask = async (taskId: string) => {
    const newNodes = wizardNodes.filter((n) => n.id !== taskId);
    const newEdges = wizardEdges.filter((e) => e.parent !== taskId && e.child !== taskId);
    setWizardNodes(newNodes);
    setWizardEdges(newEdges);

    // Auto-save after deletion
    if (snapshot?.repoId) {
      try {
        await api.updateTreeSpec({
          repoId: snapshot.repoId,
          baseBranch: wizardBaseBranch,
          nodes: newNodes,
          edges: newEdges,
        });
      } catch (err) {
        console.error("Failed to save after deletion:", err);
      }
    }
  };

  // Drag and drop handlers
  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);

    if (!over) return;

    const taskId = active.id as string;
    const targetId = over.id as string;

    // Don't drop on itself
    if (taskId === targetId) return;

    // Handle dropping on "backlog" zone - remove from tree
    if (targetId === "backlog-zone") {
      setWizardEdges((prev) => prev.filter((e) => e.child !== taskId));
      return;
    }

    // Handle dropping on "tree-root" - make it a root task (child of base branch)
    if (targetId === "tree-root") {
      // Remove existing parent edge if any
      setWizardEdges((prev) => prev.filter((e) => e.child !== taskId));
      return;
    }

    // Handle dropping on another task - set that task as parent
    const targetTask = wizardNodes.find((n) => n.id === targetId);
    if (targetTask) {
      // Remove existing parent edge
      setWizardEdges((prev) => {
        const filtered = prev.filter((e) => e.child !== taskId);
        // Add new edge
        return [...filtered, { parent: targetId, child: taskId }];
      });
    }
  };

  // Get tasks for backlog (no parent edge)
  const backlogTasks = wizardNodes.filter(
    (n) => !wizardEdges.some((e) => e.child === n.id)
  );

  // Helper to get children of a parent (null = root tasks)
  const getChildren = (parentId: string | null): TreeSpecNode[] => {
    if (parentId === null) {
      // Root tasks: have no parent edge
      return wizardNodes.filter(
        (n) => !wizardEdges.some((e) => e.child === n.id)
      );
    }
    const childEdges = wizardEdges.filter((e) => e.parent === parentId);
    return childEdges.map((e) => wizardNodes.find((n) => n.id === e.child)!).filter(Boolean);
  };

  // Render a tree node with its children
  const renderTreeNode = (task: TreeSpecNode, depth: number): React.ReactNode => {
    const children = getChildren(task.id);
    return (
      <div key={task.id} className="tree-builder__node" style={{ marginLeft: depth * 20 }}>
        <DroppableTreeNode id={task.id}>
          <DraggableTask task={task}>
            <TaskCard
              task={task}
              onStatusChange={handleUpdateTaskStatus}
              onRemove={handleRemoveWizardTask}
              onStart={handleStartTask}
              onClick={handleTaskNodeClick}
              onConsult={handleConsultTask}
              loading={loading}
              compact
              isLocked={isLocked}
            />
          </DraggableTask>
        </DroppableTreeNode>
        {children.length > 0 && (
          <div className="tree-builder__children">
            {children.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const handleUpdateTaskStatus = (taskId: string, status: TaskStatus) => {
    setWizardNodes((prev) =>
      prev.map((n) => (n.id === taskId ? { ...n, status } : n))
    );
  };

  // Generate branch name from task title
  const generateBranchName = (title: string): string => {
    const slug = title
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .substring(0, 50);
    // Use branch naming rule if available
    const pattern = snapshot?.rules?.branchNaming?.pattern;
    if (pattern && pattern.includes("{taskSlug}")) {
      return pattern.replace("{taskSlug}", slug);
    }
    return `task/${slug}`;
  };

  // Start task: create branch and update status
  const handleStartTask = async (taskId: string) => {
    if (!selectedPin || !snapshot) return;

    const task = wizardNodes.find((n) => n.id === taskId);
    if (!task) return;

    // Don't start if already has a branch
    if (task.branchName) {
      setError("Task already has a branch");
      return;
    }

    const branchName = generateBranchName(task.title);
    setLoading(true);
    setError(null);

    try {
      // Create the git branch
      await api.createBranch(selectedPin.localPath, branchName, wizardBaseBranch);

      // Update task with branch name and status
      const updatedNodes = wizardNodes.map((n) =>
        n.id === taskId ? { ...n, branchName, status: "doing" as TaskStatus } : n
      );
      setWizardNodes(updatedNodes);

      // Save tree spec and update local snapshot
      const updatedSpec = await api.updateTreeSpec({
        repoId: snapshot.repoId,
        baseBranch: wizardBaseBranch,
        nodes: updatedNodes,
        edges: wizardEdges,
      });
      setSnapshot((prev) =>
        prev ? { ...prev, treeSpec: updatedSpec } : prev
      );

      // Rescan in background to update branch graph (don't await)
      handleScan(selectedPin.localPath);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveTreeSpec = async () => {
    if (!snapshot?.repoId) return;
    setLoading(true);
    setError(null);
    try {
      const updatedSpec = await api.updateTreeSpec({
        repoId: snapshot.repoId,
        baseBranch: wizardBaseBranch,
        nodes: wizardNodes,
        edges: wizardEdges,
      });
      // Update local snapshot with new treeSpec (no rescan needed)
      setSnapshot((prev) =>
        prev ? { ...prev, treeSpec: updatedSpec } : prev
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // State for generation logs
  const [generateLogs, setGenerateLogs] = useState<string[]>([]);
  const [showGenerateLogs, setShowGenerateLogs] = useState(false);

  // Topological sort for nodes (parent → child order)
  const topologicalSort = (nodes: TreeSpecNode[], edges: TreeSpecEdge[]): TreeSpecNode[] => {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const inDegree = new Map<string, number>();
    const children = new Map<string, string[]>();

    // Initialize
    nodes.forEach(n => {
      inDegree.set(n.id, 0);
      children.set(n.id, []);
    });

    // Build graph
    edges.forEach(e => {
      inDegree.set(e.child, (inDegree.get(e.child) || 0) + 1);
      children.get(e.parent)?.push(e.child);
    });

    // Find roots (nodes with no incoming edges)
    const queue = nodes.filter(n => (inDegree.get(n.id) || 0) === 0);
    const sorted: TreeSpecNode[] = [];

    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);

      for (const childId of children.get(node.id) || []) {
        const newDegree = (inDegree.get(childId) || 1) - 1;
        inDegree.set(childId, newDegree);
        if (newDegree === 0) {
          const childNode = nodeMap.get(childId);
          if (childNode) queue.push(childNode);
        }
      }
    }

    return sorted;
  };

  // Batch create worktrees for all tasks
  const handleBatchCreateWorktrees = async () => {
    if (!selectedPin || !snapshot) return;

    // Filter tasks that need worktrees (no worktreePath yet)
    const tasksNeedingWorktrees = wizardNodes.filter(
      (n) => !n.worktreePath
    );

    if (tasksNeedingWorktrees.length === 0) {
      setError("No tasks to create worktrees for");
      return;
    }

    setLoading(true);
    setError(null);
    setGenerateLogs([]);
    setShowGenerateLogs(true);

    const addLog = (msg: string) => {
      setGenerateLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    try {
      addLog(`Starting generation for ${tasksNeedingWorktrees.length} tasks...`);

      // Sort tasks in topological order (parent → child)
      const sortedTasks = topologicalSort(tasksNeedingWorktrees, wizardEdges);
      addLog(`Topological order: ${sortedTasks.map(t => t.title).join(' → ')}`);

      // Track generated branch names for parent lookup
      const generatedBranchNames = new Map<string, string>();

      // Build task list with branch names and parent branches
      const tasks = sortedTasks.map((task) => {
        // Generate branch name if not set
        const branchName = task.branchName || generateBranchName(task.title);
        generatedBranchNames.set(task.id, branchName);

        // Find parent branch: check if this task has a parent edge
        const parentEdge = wizardEdges.find((e) => e.child === task.id);
        let parentBranch = wizardBaseBranch;
        if (parentEdge) {
          // Use the generated branch name of the parent
          const parentBranchName = generatedBranchNames.get(parentEdge.parent);
          if (parentBranchName) {
            parentBranch = parentBranchName;
          }
        }

        addLog(`Task "${task.title}": branch=${branchName}, parent=${parentBranch}`);

        // Generate worktree name from branch name (replace / with -)
        const worktreeName = branchName.replace(/\//g, "-");

        return {
          id: task.id,
          branchName,
          parentBranch,
          worktreeName,
        };
      });

      addLog(`Creating branches and worktrees...`);

      // Call API to create branches and worktrees
      const result = await api.createTree(
        snapshot.repoId,
        selectedPin.localPath,
        tasks
      );

      // Log results
      for (const r of result.results) {
        if (r.success) {
          addLog(`✓ ${r.branchName} → ${r.worktreePath}`);
        } else {
          addLog(`✗ ${r.branchName}: ${r.error}`);
        }
      }

      // Update wizard nodes with results
      const updatedNodes = wizardNodes.map((node) => {
        const taskResult = result.results.find((r) => r.taskId === node.id);
        if (taskResult && taskResult.success) {
          return {
            ...node,
            branchName: taskResult.branchName,
            worktreePath: taskResult.worktreePath,
            chatSessionId: taskResult.chatSessionId,
            status: "doing" as TaskStatus,
          };
        }
        // Even if failed, set branchName if it was generated
        const taskData = tasks.find(t => t.id === node.id);
        if (taskData && !node.branchName) {
          return { ...node, branchName: taskData.branchName };
        }
        return node;
      });
      setWizardNodes(updatedNodes);
      setWizardStatus("generated");

      // Save tree spec and update local snapshot
      const updatedSpec = await api.updateTreeSpec({
        repoId: snapshot.repoId,
        baseBranch: wizardBaseBranch,
        nodes: updatedNodes,
        edges: wizardEdges,
      });
      setSnapshot((prev) =>
        prev ? { ...prev, treeSpec: { ...updatedSpec, status: "generated" } } : prev
      );

      addLog(`Done! Created ${result.summary.success}/${result.summary.total} worktrees.`);

      // Show error summary if any failed
      if (result.summary.failed > 0) {
        setError(`${result.summary.failed} worktrees failed to create. Check logs for details.`);
      }

      // Rescan in background to update branch graph
      handleScan(selectedPin.localPath);
    } catch (err) {
      addLog(`Error: ${(err as Error).message}`);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Count tasks that can have worktrees created
  const tasksReadyForWorktrees = wizardNodes.filter(
    (n) => !n.worktreePath
  ).length;

  // Handle clicking a task node to open its chat session
  const handleTaskNodeClick = async (task: TreeSpecNode) => {
    if (!task.worktreePath || !snapshot) return;

    // If chat session exists, open it
    if (task.chatSessionId) {
      // Load chat session
      try {
        const sessions = await api.getChatSessions(snapshot.repoId);
        const session = sessions.find(s => s.id === task.chatSessionId);
        if (session) {
          setChatSession(session);
          const messages = await api.getChatMessages(session.id);
          setChatMessages(messages);
          setShowChat(true);
          return;
        }
      } catch (err) {
        console.error("Failed to load chat session:", err);
      }
    }

    // Create new chat session if needed
    try {
      const newSession = await api.createChatSession(
        snapshot.repoId,
        task.worktreePath,
        plan?.id
      );

      // Add system message with task context
      const systemContent = `# Task: ${task.title}

## Worktree
\`${task.worktreePath}\`

## Branch
\`${task.branchName}\`

${task.description ? `## Done Condition\n${task.description}` : ""}

---
このworktreeで作業を開始してください。`;

      await api.sendChatMessage(newSession.id, systemContent);

      // Open the chat
      setChatSession(newSession);
      const messages = await api.getChatMessages(newSession.id);
      setChatMessages(messages);
      setShowChat(true);
    } catch (err) {
      setError(`Failed to create chat session: ${(err as Error).message}`);
    }
  };

  // Handle consulting about a task (without worktree)
  const handleConsultTask = async (task: TreeSpecNode) => {
    if (!snapshot || !selectedPin) return;

    try {
      // Create chat session using main repo path
      const newSession = await api.createChatSession(
        snapshot.repoId,
        selectedPin.localPath,
        plan?.id
      );

      // Add system message with task context for consultation
      const systemContent = `# タスク相談: ${task.title}

${task.description ? `## タスク内容\n${task.description}\n` : ""}
## リポジトリ
\`${selectedPin.localPath}\`

---
このタスクについて相談してください。実装方針、技術的な質問、タスクの分解などお手伝いします。`;

      await api.sendChatMessage(newSession.id, systemContent);

      // Open the chat
      setChatSession(newSession);
      const messages = await api.getChatMessages(newSession.id);
      setChatMessages(messages);
      setShowChat(true);
    } catch (err) {
      setError(`Failed to create chat session: ${(err as Error).message}`);
    }
  };

  // Check if can confirm: has base branch, has nodes, has at least one root
  const childIds = new Set(wizardEdges.map((e) => e.child));
  const rootNodes = wizardNodes.filter((n) => !childIds.has(n.id));
  const canConfirm = wizardBaseBranch && wizardNodes.length > 0 && rootNodes.length > 0;
  const isLocked = wizardStatus === "confirmed" || wizardStatus === "generated";

  // Confirm tree spec
  const handleConfirmTreeSpec = async () => {
    if (!snapshot?.repoId) return;
    setLoading(true);
    setError(null);
    try {
      // First save current state
      await api.updateTreeSpec({
        repoId: snapshot.repoId,
        baseBranch: wizardBaseBranch,
        nodes: wizardNodes,
        edges: wizardEdges,
      });
      // Then confirm
      const updatedSpec = await api.confirmTreeSpec(snapshot.repoId);
      setWizardStatus(updatedSpec.status);
      setSnapshot((prev) =>
        prev ? { ...prev, treeSpec: updatedSpec } : prev
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Unconfirm tree spec
  const handleUnconfirmTreeSpec = async () => {
    if (!snapshot?.repoId) return;
    setLoading(true);
    setError(null);
    try {
      const updatedSpec = await api.unconfirmTreeSpec(snapshot.repoId);
      setWizardStatus(updatedSpec.status);
      setSnapshot((prev) =>
        prev ? { ...prev, treeSpec: updatedSpec } : prev
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogInstruction = async () => {
    if (!snapshot?.repoId || !instruction.trim()) return;
    try {
      await api.logInstruction({
        repoId: snapshot.repoId,
        planId: plan?.id,
        branchName: selectedNode?.branchName,
        kind: "user_instruction",
        contentMd: instruction,
      });
      setInstruction("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  // Settings functions
  const handleOpenSettings = async () => {
    if (!snapshot?.repoId) return;
    setShowSettings(true);
    setSettingsLoading(true);
    try {
      const rule = await api.getBranchNaming(snapshot.repoId);
      setSettingsRule(rule);
      setSettingsPattern(rule.pattern);
      setSettingsDescription(rule.description);
      setSettingsExamples(rule.examples);
    } catch {
      // Default rule if not exists
      setSettingsRule({ pattern: "vt/{planId}/{taskSlug}", description: "", examples: [] });
      setSettingsPattern("vt/{planId}/{taskSlug}");
      setSettingsDescription("");
      setSettingsExamples([]);
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!snapshot?.repoId) return;
    setSettingsLoading(true);
    setSettingsSaved(false);
    try {
      const updated = await api.updateBranchNaming({
        repoId: snapshot.repoId,
        pattern: settingsPattern,
        description: settingsDescription,
        examples: settingsExamples,
      });
      setSettingsRule(updated);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleAddSettingsExample = () => {
    if (settingsNewExample && !settingsExamples.includes(settingsNewExample)) {
      setSettingsExamples([...settingsExamples, settingsNewExample]);
      setSettingsNewExample("");
    }
  };

  const handleRemoveSettingsExample = (ex: string) => {
    setSettingsExamples(settingsExamples.filter((e) => e !== ex));
  };

  // If no project selected, show project list
  if (!selectedPinId) {
    return (
      <div className="project-list-page">
        <div className="project-list-header">
          <h1>Vibe Tree</h1>
          <p>プロジェクトを選択してください</p>
        </div>
        <div className="project-list">
          {repoPins.map((pin) => (
            <div
              key={pin.id}
              className="project-card"
              onClick={() => handleSelectPin(pin.id)}
            >
              <div className="project-card__name">{pin.label || pin.repoId}</div>
              <div className="project-card__path">{pin.localPath}</div>
              <button
                className="project-card__delete"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeletePin(pin.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {repoPins.length === 0 && !showAddNew && (
            <div className="project-list__empty">
              プロジェクトがありません
            </div>
          )}
        </div>
        {showAddNew ? (
          <div className="add-project-form">
            <input
              type="text"
              placeholder="ローカルパス（例: ~/projects/my-app）"
              value={newLocalPath}
              onChange={(e) => setNewLocalPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddRepoPin()}
              autoFocus
            />
            <div className="add-project-form__buttons">
              <button className="btn-primary" onClick={handleAddRepoPin}>追加</button>
              <button className="btn-secondary" onClick={() => setShowAddNew(false)}>キャンセル</button>
            </div>
          </div>
        ) : (
          <button className="add-project-btn" onClick={() => setShowAddNew(true)}>
            + 新しいプロジェクトを追加
          </button>
        )}
        {error && <div className="project-list__error">{error}</div>}

        <style>{`
          .project-list-page {
            min-height: 100vh;
            background: #f5f5f5;
            padding: 60px 20px;
            max-width: 600px;
            margin: 0 auto;
          }
          .project-list-header {
            text-align: center;
            margin-bottom: 40px;
          }
          .project-list-header h1 {
            margin: 0 0 8px;
            font-size: 32px;
            color: #333;
          }
          .project-list-header p {
            margin: 0;
            color: #666;
          }
          .project-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 24px;
          }
          .project-card {
            background: white;
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            border: 2px solid transparent;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            position: relative;
            transition: all 0.2s;
          }
          .project-card:hover {
            border-color: #2196f3;
            box-shadow: 0 4px 16px rgba(0,0,0,0.12);
          }
          .project-card__name {
            font-weight: 600;
            font-size: 18px;
            margin-bottom: 4px;
          }
          .project-card__path {
            font-size: 13px;
            color: #888;
            font-family: monospace;
          }
          .project-card__delete {
            position: absolute;
            top: 12px;
            right: 12px;
            background: #fee;
            color: #c00;
            border: none;
            border-radius: 6px;
            padding: 4px 10px;
            cursor: pointer;
            font-size: 16px;
            opacity: 0;
            transition: opacity 0.2s;
          }
          .project-card:hover .project-card__delete {
            opacity: 1;
          }
          .project-list__empty {
            text-align: center;
            padding: 40px;
            color: #999;
          }
          .add-project-btn {
            width: 100%;
            padding: 16px;
            background: #2196f3;
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
          }
          .add-project-btn:hover {
            background: #1976d2;
          }
          .add-project-form {
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          }
          .add-project-form input {
            width: 100%;
            padding: 14px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 16px;
            margin-bottom: 12px;
          }
          .add-project-form input:focus {
            outline: none;
            border-color: #2196f3;
          }
          .add-project-form__buttons {
            display: flex;
            gap: 12px;
          }
          .add-project-form__buttons button {
            flex: 1;
            padding: 12px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
          }
          .project-list__error {
            margin-top: 16px;
            padding: 12px;
            background: #fee;
            color: #c00;
            border-radius: 8px;
            text-align: center;
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="dashboard dashboard--with-sidebar">
      {/* Left Sidebar */}
      <aside className="sidebar">
        <div className="sidebar__header">
          <button className="sidebar__back" onClick={() => {
            setSelectedPinId(null);
            setSnapshot(null);
          }}>
            ← Projects
          </button>
        </div>

        {/* Current Project */}
        <div className="sidebar__section">
          <h3>Project</h3>
          <div className="sidebar__project-name">{selectedPin?.label || selectedPin?.repoId}</div>
          <div className="sidebar__path">{selectedPin?.localPath}</div>
        </div>

        {/* Actions */}
        {snapshot && (
          <div className="sidebar__section">
            <button
              className="sidebar__btn"
              onClick={handleOpenSettings}
            >
              Settings
            </button>
          </div>
        )}

        {/* Plan Info */}
        {plan && (
          <div className="sidebar__section">
            <h3>Plan</h3>
            <div className="sidebar__plan">
              <strong>{plan.title}</strong>
              {plan.githubIssueUrl && (
                <a href={plan.githubIssueUrl} target="_blank" rel="noopener noreferrer">
                  View Issue
                </a>
              )}
            </div>
          </div>
        )}

        {/* Worktrees */}
        {snapshot && snapshot.worktrees.length > 0 && (
          <div className="sidebar__section">
            <h3>Worktrees</h3>
            <div className="sidebar__worktrees">
              {snapshot.worktrees.map((wt) => (
                <div
                  key={wt.path}
                  className={`sidebar__worktree ${wt.isActive ? "sidebar__worktree--active" : ""}`}
                >
                  <span className="sidebar__worktree-branch">{wt.branch}</span>
                  <button
                    className="sidebar__worktree-chat"
                    onClick={() => handleOpenChat(wt.path)}
                    title="Open chat"
                  >
                    Chat
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {error && <div className="dashboard__error">{error}</div>}

        {/* Tree View */}
        {snapshot && (
          <div className="tree-view">
            {/* Left: Graph */}
            <div className="tree-view__graph">
              <div className="panel panel--graph">
                <div className="panel__header">
                  <h3>Branch Graph</h3>
                  <div className="panel__header-actions">
                    <span className="panel__count">{snapshot.nodes.length} branches</span>
                  </div>
                </div>
                <div className="graph-container">
                  <BranchGraph
                    nodes={snapshot.nodes}
                    edges={snapshot.edges}
                    defaultBranch={snapshot.defaultBranch}
                    selectedBranch={selectedNode?.branchName ?? null}
                    onSelectBranch={(branchName) => {
                      const node = snapshot.nodes.find((n) => n.branchName === branchName);
                      setSelectedNode(node ?? null);
                    }}
                  />
                </div>
              </div>

              {/* Warnings */}
              {snapshot.warnings.length > 0 && (
                <div className="panel panel--warnings">
                  <div className="panel__header">
                    <h3>Warnings ({snapshot.warnings.length})</h3>
                  </div>
                  {snapshot.warnings.map((w, i) => (
                    <div key={i} className={`warning warning--${w.severity}`}>
                      <strong>[{w.code}]</strong> {w.message}
                    </div>
                  ))}
                </div>
              )}

              {/* Task Tree Panel - Inline */}
              <div className="panel panel--task-tree">
                <div className="panel__header">
                  <h3>Task Tree</h3>
                  <div className="panel__header-actions">
                    <span className={`status-badge status-badge--${wizardStatus}`}>
                      {wizardStatus}
                    </span>
                    <span className="panel__count">{wizardNodes.length} tasks</span>
                  </div>
                </div>

                {/* Base Branch Selector */}
                <div className="task-tree-panel__settings">
                  <label>Base Branch:</label>
                  <select
                    value={wizardBaseBranch}
                    onChange={(e) => setWizardBaseBranch(e.target.value)}
                    disabled={isLocked}
                  >
                    {snapshot.branches.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>

                {/* Add Task Form */}
                {!isLocked && (
                  <div className="task-tree-panel__add">
                    <input
                      type="text"
                      placeholder="Task title..."
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddWizardTask()}
                    />
                    <button onClick={handleAddWizardTask} disabled={!newTaskTitle.trim()}>
                      Add
                    </button>
                  </div>
                )}

                {/* D&D Task Tree */}
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                >
                  <div className="task-tree-panel__content">
                    {/* Tree Area */}
                    <DroppableTreeNode id="tree-root">
                      <div className="task-tree-panel__tree">
                        <div className="tree-label">
                          {wizardBaseBranch} (base)
                        </div>
                        {getChildren(null).map((task) => renderTreeNode(task, 0))}
                        {getChildren(null).length === 0 && (
                          <div className="tree-empty">ドラッグしてタスクを配置</div>
                        )}
                      </div>
                    </DroppableTreeNode>

                    {/* Backlog */}
                    <DroppableTreeNode id="backlog-zone">
                      <div className="task-tree-panel__backlog">
                        <div className="backlog-label">Backlog ({backlogTasks.length})</div>
                        {backlogTasks.map((task) => (
                          <DraggableTask key={task.id} task={task}>
                            <TaskCard
                              task={task}
                              onStatusChange={handleUpdateTaskStatus}
                              onRemove={handleRemoveWizardTask}
                              onStart={handleStartTask}
                              onClick={handleTaskNodeClick}
                              onConsult={handleConsultTask}
                              loading={loading}
                              isLocked={isLocked}
                            />
                          </DraggableTask>
                        ))}
                      </div>
                    </DroppableTreeNode>
                  </div>

                  <DragOverlay>
                    {activeDragId && (
                      <div className="task-card task-card--dragging">
                        {wizardNodes.find((n) => n.id === activeDragId)?.title}
                      </div>
                    )}
                  </DragOverlay>
                </DndContext>

                {/* Generation Logs */}
                {showGenerateLogs && (
                  <div className="generate-logs">
                    <div className="generate-logs__header">
                      <span>Generation Logs</span>
                      <button onClick={() => setShowGenerateLogs(false)}>×</button>
                    </div>
                    <div className="generate-logs__content">
                      {generateLogs.map((log, i) => (
                        <div key={i} className="generate-logs__line">{log}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="task-tree-panel__actions">
                  {wizardStatus === "draft" && (
                    <>
                      <button
                        className="btn-secondary"
                        onClick={handleSaveTreeSpec}
                        disabled={loading}
                      >
                        下書き保存
                      </button>
                      <button
                        className="btn-primary"
                        onClick={handleConfirmTreeSpec}
                        disabled={loading || !canConfirm}
                        title={!canConfirm ? "Base branch, at least one task required" : ""}
                      >
                        確定
                      </button>
                    </>
                  )}
                  {wizardStatus === "confirmed" && (
                    <>
                      <button
                        className="btn-secondary"
                        onClick={handleUnconfirmTreeSpec}
                        disabled={loading}
                      >
                        編集に戻す
                      </button>
                      <button
                        className="btn-primary"
                        onClick={handleBatchCreateWorktrees}
                        disabled={loading || tasksReadyForWorktrees === 0}
                      >
                        Worktree生成 ({tasksReadyForWorktrees})
                      </button>
                    </>
                  )}
                  {wizardStatus === "generated" && (
                    <button
                      className="btn-secondary"
                      onClick={handleUnconfirmTreeSpec}
                      disabled={loading}
                    >
                      編集に戻す
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Right: Details */}
            <div className="tree-view__details">
              {selectedNode ? (
                <div className="panel">
                  <div className="panel__header">
                    <h3>{selectedNode.branchName}</h3>
                  </div>

                  {/* PR Info */}
                  {selectedNode.pr && (
                    <div className="detail-section">
                      <h4>Pull Request</h4>
                      <a href={selectedNode.pr.url} target="_blank" rel="noopener noreferrer">
                        #{selectedNode.pr.number}: {selectedNode.pr.title}
                      </a>
                      <div className="detail-row">
                        <span>State: {selectedNode.pr.state}</span>
                        {selectedNode.pr.isDraft && <span>(Draft)</span>}
                      </div>
                      {selectedNode.pr.reviewDecision && (
                        <div className="detail-row">Review: {selectedNode.pr.reviewDecision}</div>
                      )}
                      {selectedNode.pr.checks && (
                        <div className="detail-row">CI: {selectedNode.pr.checks}</div>
                      )}
                    </div>
                  )}

                  {/* Worktree Info */}
                  {selectedNode.worktree && (
                    <div className="detail-section">
                      <h4>Worktree</h4>
                      <div className="detail-row">
                        <span>Path: {selectedNode.worktree.path}</span>
                      </div>
                      <div className="detail-row">
                        <span>Dirty: {selectedNode.worktree.dirty ? "Yes" : "No"}</span>
                      </div>
                      {selectedNode.worktree.isActive && (
                        <div className="detail-row">
                          <span>Active: {selectedNode.worktree.activeAgent || "Yes"}</span>
                        </div>
                      )}
                      <button
                        className="btn-chat"
                        onClick={() => handleOpenChat(selectedNode.worktree!.path)}
                      >
                        Open Chat
                      </button>
                    </div>
                  )}

                  {/* Ahead/Behind */}
                  {selectedNode.aheadBehind && (
                    <div className="detail-section">
                      <h4>Sync Status</h4>
                      <div className="detail-row" style={{ gap: "16px" }}>
                        <span style={{ color: "#4caf50" }}>+{selectedNode.aheadBehind.ahead} ahead</span>
                        <span style={{ color: "#f44336" }}>-{selectedNode.aheadBehind.behind} behind</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="panel">
                  <div className="panel__header">
                    <h3>Select a branch</h3>
                  </div>
                  <p style={{ padding: "16px", color: "#666" }}>
                    Click on a branch to see details.
                  </p>
                </div>
              )}

              {/* Restart Info */}
              {snapshot.restart && (
                <div className="panel panel--restart">
                  <div className="panel__header">
                    <h3>Restart Session</h3>
                  </div>
                  <div className="detail-section">
                    <label>CD Command:</label>
                    <div className="copy-row">
                      <code>{snapshot.restart.cdCommand}</code>
                      <button onClick={() => copyToClipboard(snapshot.restart!.cdCommand, "cd")}>
                        {copied === "cd" ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <div className="detail-section">
                    <label>Restart Prompt:</label>
                    <pre className="restart-prompt">{snapshot.restart.restartPromptMd}</pre>
                    <button onClick={() => copyToClipboard(snapshot.restart!.restartPromptMd, "prompt")}>
                      {copied === "prompt" ? "Copied!" : "Copy Prompt"}
                    </button>
                  </div>
                </div>
              )}

              {/* Instruction Logger */}
              <div className="panel">
                <div className="panel__header">
                  <h3>Log Instruction</h3>
                </div>
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Enter instruction for Claude..."
                />
                <button
                  onClick={handleLogInstruction}
                  disabled={!instruction.trim() || !snapshot?.repoId}
                  className="btn-primary"
                >
                  Log Instruction
                </button>
              </div>
            </div>
          </div>
        )}

        {!snapshot && !loading && (
          <div className="empty-state">
            <h2>No repository selected</h2>
            <p>Select a repository from the sidebar and click Scan to get started.</p>
          </div>
        )}
      </main>

      {/* Chat Panel (floating) */}
      {showChat && chatSession && (
        <div className="chat-panel">
          <div className="chat-panel__header">
            <div className="chat-panel__title">
              <h3>Chat: {chatSession.branchName || "Session"}</h3>
              <span className="chat-panel__path">{chatSession.worktreePath}</span>
            </div>
            <div className="chat-panel__actions">
              <button onClick={handleCloseChat}>×</button>
            </div>
          </div>
          <div className="chat-panel__messages" ref={chatRef}>
            {chatMessages.length === 0 ? (
              <div className="chat-panel__empty">
                No messages yet. Start a conversation with Claude.
              </div>
            ) : (
              chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`chat-message chat-message--${msg.role}`}
                >
                  <div className="chat-message__role">{msg.role}</div>
                  <div className="chat-message__content">
                    <pre>{msg.content}</pre>
                  </div>
                  <div className="chat-message__time">
                    {new Date(msg.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              ))
            )}
            {chatLoading && (
              <div className="chat-message chat-message--loading">
                <div className="chat-message__role">assistant</div>
                <div className="chat-message__content">Thinking...</div>
              </div>
            )}
          </div>
          <div className="chat-panel__input">
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Type a message..."
              disabled={chatLoading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendChat();
                }
              }}
            />
            <button
              onClick={handleSendChat}
              disabled={chatLoading || !chatInput.trim()}
            >
              {chatLoading ? "..." : "Send"}
            </button>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal__header">
              <h2>Settings</h2>
              <button onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="modal__content">
              {settingsLoading && !settingsRule ? (
                <div className="modal__loading">Loading...</div>
              ) : settingsRule ? (
                <>
                  {settingsSaved && (
                    <div className="modal__success">Settings saved!</div>
                  )}
                  <div className="settings-section">
                    <label>Branch Naming Pattern</label>
                    <input
                      type="text"
                      value={settingsPattern}
                      onChange={(e) => setSettingsPattern(e.target.value)}
                      placeholder="vt/{planId}/{taskSlug}"
                    />
                    <small>Use {"{planId}"} and {"{taskSlug}"} as placeholders</small>
                  </div>
                  <div className="settings-section">
                    <label>Description</label>
                    <textarea
                      value={settingsDescription}
                      onChange={(e) => setSettingsDescription(e.target.value)}
                      placeholder="Description of the naming convention..."
                    />
                  </div>
                  <div className="settings-section">
                    <label>Examples</label>
                    <div className="settings-examples">
                      {settingsExamples.map((ex, i) => (
                        <span key={i} className="settings-example">
                          <code>{ex}</code>
                          <button onClick={() => handleRemoveSettingsExample(ex)}>×</button>
                        </span>
                      ))}
                    </div>
                    <div className="settings-add-example">
                      <input
                        type="text"
                        value={settingsNewExample}
                        onChange={(e) => setSettingsNewExample(e.target.value)}
                        placeholder="Add example..."
                        onKeyDown={(e) => e.key === "Enter" && handleAddSettingsExample()}
                      />
                      <button onClick={handleAddSettingsExample}>Add</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="modal__error">Failed to load settings</div>
              )}
            </div>
            <div className="modal__footer">
              <button className="btn-secondary" onClick={() => setShowSettings(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleSaveSettings}
                disabled={settingsLoading}
              >
                {settingsLoading ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .dashboard {
          min-height: 100vh;
          background: #f5f5f5;
        }
        .dashboard--with-sidebar {
          display: flex;
        }

        /* Sidebar styles */
        .sidebar {
          width: 280px;
          min-width: 280px;
          background: white;
          border-right: 1px solid #ddd;
          display: flex;
          flex-direction: column;
          height: 100vh;
          position: sticky;
          top: 0;
          overflow-y: auto;
        }
        .sidebar__header {
          padding: 16px 20px;
          border-bottom: 1px solid #eee;
        }
        .sidebar__header h1 {
          margin: 0;
          font-size: 18px;
          color: #333;
        }
        .sidebar__back {
          background: none;
          border: none;
          color: #666;
          font-size: 13px;
          cursor: pointer;
          padding: 0;
        }
        .sidebar__back:hover {
          color: #333;
        }
        .sidebar__project-name {
          font-weight: 600;
          font-size: 16px;
          margin-bottom: 4px;
        }
        .sidebar__section {
          padding: 16px 20px;
          border-bottom: 1px solid #eee;
        }
        .sidebar__section h3 {
          margin: 0 0 10px;
          font-size: 12px;
          font-weight: 600;
          color: #666;
          text-transform: uppercase;
        }
        .sidebar__path {
          font-size: 11px;
          color: #888;
          margin-top: 8px;
          word-break: break-all;
          font-family: monospace;
        }
        .sidebar__btn {
          width: 100%;
          padding: 10px 16px;
          border: 1px solid #ddd;
          border-radius: 6px;
          background: white;
          color: #333;
          cursor: pointer;
          font-size: 14px;
          margin-bottom: 8px;
        }
        .sidebar__btn:hover {
          background: #f5f5f5;
        }
        .sidebar__btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .sidebar__btn--primary {
          background: #0066cc;
          color: white;
          border-color: #0066cc;
        }
        .sidebar__btn--primary:hover {
          background: #0052a3;
        }
        .sidebar__btn--primary:disabled {
          background: #ccc;
          border-color: #ccc;
        }
        .sidebar__plan {
          font-size: 13px;
        }
        .sidebar__plan strong {
          display: block;
          margin-bottom: 4px;
        }
        .sidebar__plan a {
          color: #0066cc;
          font-size: 12px;
        }
        .sidebar__worktrees {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 200px;
          overflow-y: auto;
        }
        .sidebar__worktree {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 10px;
          background: #f5f5f5;
          border-radius: 4px;
          font-size: 12px;
        }
        .sidebar__worktree--active {
          background: #e8f5e9;
          border-left: 3px solid #28a745;
        }
        .sidebar__worktree-branch {
          font-family: monospace;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sidebar__worktree-chat {
          padding: 2px 8px;
          background: #6c5ce7;
          color: white;
          border: none;
          border-radius: 3px;
          font-size: 10px;
          cursor: pointer;
        }
        .sidebar__worktree-chat:hover {
          background: #5b4cdb;
        }

        /* Repo selector in sidebar */
        .repo-selector {
          display: flex;
          gap: 4px;
          align-items: center;
        }
        .repo-selector select {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 13px;
        }
        .add-repo-form {
          margin-top: 10px;
        }
        .add-repo-form input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 13px;
          margin-bottom: 8px;
        }
        .add-repo-form__buttons {
          display: flex;
          gap: 8px;
        }
        .add-repo-form__buttons button {
          flex: 1;
          padding: 6px 12px;
          border: 1px solid #ddd;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          background: white;
        }
        .add-repo-form__buttons button:first-child {
          background: #0066cc;
          color: white;
          border-color: #0066cc;
        }
        .btn-delete {
          padding: 4px 8px;
          background: #fee;
          color: #c00;
          border: 1px solid #fcc;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
        }

        /* Main content area */
        .main-content {
          flex: 1;
          padding: 20px;
          overflow-y: auto;
        }
        .dashboard__error {
          background: #fee;
          color: #c00;
          padding: 12px 16px;
          border-radius: 6px;
          margin-bottom: 16px;
        }
        .empty-state {
          text-align: center;
          padding: 60px 20px;
          color: #666;
        }
        .empty-state h2 {
          margin: 0 0 8px;
          font-size: 18px;
          color: #333;
        }
        .empty-state p {
          margin: 0;
          font-size: 14px;
        }

        /* Tree view layout */
        .tree-view {
          display: grid;
          grid-template-columns: 1fr 360px;
          gap: 20px;
          height: calc(100vh - 40px);
        }
        .tree-view__graph {
          display: flex;
          flex-direction: column;
          gap: 16px;
          overflow: hidden;
        }
        .tree-view__details {
          display: flex;
          flex-direction: column;
          gap: 16px;
          overflow-y: auto;
        }

        /* Graph container */
        .panel--graph {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .graph-container {
          flex: 1;
          overflow: auto;
          background: #fafafa;
          border-radius: 4px;
          min-height: 300px;
        }
        .branch-graph {
          min-width: fit-content;
        }
        .branch-graph--empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 200px;
          color: #999;
        }
        .branch-graph__svg {
          display: block;
        }
        .panel {
          background: white;
          border: 1px solid #ddd;
          border-radius: 8px;
          padding: 16px;
        }
        .panel--warnings {
          border-color: #f90;
        }
        .panel--task-tree {
          margin-top: 16px;
        }
        .task-tree-panel__settings {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          padding-bottom: 12px;
          border-bottom: 1px solid #eee;
        }
        .task-tree-panel__settings label {
          font-size: 13px;
          color: #666;
        }
        .task-tree-panel__settings select {
          flex: 1;
          padding: 6px 8px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 13px;
        }
        .task-tree-panel__add {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
        }
        .task-tree-panel__add input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 13px;
        }
        .task-tree-panel__add button {
          padding: 8px 16px;
          background: #2196f3;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .task-tree-panel__add button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .task-tree-panel__content {
          display: flex;
          gap: 16px;
          min-height: 150px;
        }
        .task-tree-panel__tree {
          flex: 2;
          min-height: 100px;
          padding: 12px;
          background: #f8f9fa;
          border: 2px dashed #ddd;
          border-radius: 8px;
        }
        .task-tree-panel__backlog {
          flex: 1;
          min-height: 100px;
          padding: 12px;
          background: #fff3e0;
          border: 2px dashed #ffcc80;
          border-radius: 8px;
        }
        .tree-label, .backlog-label {
          font-size: 12px;
          font-weight: 600;
          color: #666;
          margin-bottom: 8px;
          padding-bottom: 6px;
          border-bottom: 1px solid #ddd;
        }
        .tree-empty {
          font-size: 12px;
          color: #999;
          text-align: center;
          padding: 20px;
        }
        .task-tree-panel__actions {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #eee;
        }
        .btn-primary {
          padding: 8px 16px;
          background: #2196f3;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-primary:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .btn-secondary {
          padding: 8px 16px;
          background: white;
          color: #333;
          border: 1px solid #ddd;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-secondary:hover {
          background: #f5f5f5;
        }
        .status-badge {
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
        }
        .status-badge--draft {
          background: #e0e0e0;
          color: #666;
        }
        .status-badge--confirmed {
          background: #fff3e0;
          color: #e65100;
        }
        .status-badge--generated {
          background: #e8f5e9;
          color: #2e7d32;
        }
        .panel--restart {
          background: #e8f4f8;
          border-color: #b8d4e8;
        }
        .panel--placeholder {
          color: #999;
          text-align: center;
          padding: 40px;
        }
        .panel__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        .panel__header h3 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
        }
        .panel__count {
          font-size: 12px;
          color: #666;
        }
        .tree-list {
          font-family: monospace;
          font-size: 13px;
        }
        .tree-node {
          padding: 8px 12px;
          margin-bottom: 4px;
          background: #f9f9f9;
          border-radius: 4px;
          cursor: pointer;
          border-left: 3px solid transparent;
        }
        .tree-node:hover {
          background: #f0f0f0;
        }
        .tree-node--selected {
          background: #e8f4fc;
          border-left-color: #0066cc;
        }
        .tree-node--active {
          border-left-color: #28a745;
        }
        .tree-node__header {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .tree-node__name {
          font-weight: 600;
        }
        .tree-node__badge {
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 10px;
          font-weight: 500;
        }
        .tree-node__badge--designed {
          background: #9c27b0;
          color: white;
        }
        .tree-node__badge--agent {
          background: #28a745;
          color: white;
        }
        .tree-node__badge--dirty {
          background: #ff9800;
          color: white;
        }
        .tree-node__badge--pr {
          background: #2196F3;
          color: white;
        }
        .tree-node__badge--open {
          background: #28a745;
        }
        .tree-node__badge--closed {
          background: #6c757d;
        }
        .tree-node__badge--merged {
          background: #9c27b0;
        }
        .tree-node__badge--draft {
          background: #6c757d;
          color: white;
        }
        .tree-node__badge--review {
          font-weight: bold;
        }
        .tree-node__badge--approved {
          background: #28a745;
          color: white;
        }
        .tree-node__badge--changes_requested {
          background: #dc3545;
          color: white;
        }
        .tree-node__badge--ci {
          font-weight: bold;
        }
        .tree-node__badge--success {
          background: #28a745;
          color: white;
        }
        .tree-node__badge--failure {
          background: #dc3545;
          color: white;
        }
        .tree-node__badge--pending {
          background: #ffc107;
          color: black;
        }
        .tree-node__meta {
          display: flex;
          gap: 8px;
          margin-top: 4px;
          font-size: 11px;
          color: #666;
        }
        .tree-node__stat {
          font-family: monospace;
        }
        .tree-node__changes {
          color: #28a745;
        }
        .tree-node__label {
          background: #e0e0e0;
          padding: 1px 4px;
          border-radius: 2px;
        }
        .warning {
          padding: 8px;
          margin-bottom: 8px;
          border-radius: 4px;
          font-size: 13px;
        }
        .warning--warn {
          background: #fff8e8;
        }
        .warning--error {
          background: #fee;
        }
        .detail-section {
          margin-bottom: 16px;
        }
        .detail-section h4 {
          margin: 0 0 8px;
          font-size: 12px;
          font-weight: 600;
          color: #666;
          text-transform: uppercase;
        }
        .detail-section a {
          color: #0066cc;
          text-decoration: none;
        }
        .detail-section a:hover {
          text-decoration: underline;
        }
        .detail-section code {
          display: block;
          background: #f5f5f5;
          padding: 8px;
          border-radius: 4px;
          font-size: 12px;
          word-break: break-all;
        }
        .detail-section label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .detail-row {
          font-size: 13px;
          margin-top: 4px;
        }
        .copy-row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .copy-row code {
          flex: 1;
        }
        .copy-row button {
          padding: 4px 12px;
          background: #e0e0e0;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        .restart-prompt {
          background: white;
          padding: 12px;
          border-radius: 4px;
          font-size: 11px;
          max-height: 200px;
          overflow: auto;
          white-space: pre-wrap;
          margin: 8px 0;
        }
        .panel textarea {
          width: 100%;
          min-height: 80px;
          padding: 8px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-family: inherit;
          font-size: 13px;
          resize: vertical;
          margin-bottom: 8px;
        }
        .btn-primary {
          padding: 8px 16px;
          background: #28a745;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .btn-primary:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .btn-chat-small {
          padding: 2px 8px;
          background: #6c5ce7;
          color: white;
          border: none;
          border-radius: 3px;
          font-size: 10px;
          cursor: pointer;
          margin-left: auto;
        }
        .btn-chat-small:hover {
          background: #5b4cdb;
        }
        .chat-panel {
          position: fixed;
          right: 20px;
          bottom: 20px;
          width: 450px;
          max-height: 600px;
          background: white;
          border: 1px solid #ddd;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.15);
          display: flex;
          flex-direction: column;
          z-index: 1000;
        }
        .chat-panel__header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 12px 16px;
          background: #6c5ce7;
          color: white;
          border-radius: 12px 12px 0 0;
        }
        .chat-panel__title h3 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
        }
        .chat-panel__path {
          font-size: 11px;
          opacity: 0.8;
          display: block;
          margin-top: 2px;
        }
        .chat-panel__actions button {
          background: rgba(255,255,255,0.2);
          color: white;
          border: none;
          border-radius: 4px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 14px;
        }
        .chat-panel__actions button:hover {
          background: rgba(255,255,255,0.3);
        }
        .chat-panel__messages {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
          max-height: 400px;
          background: #f8f9fa;
        }
        .chat-panel__empty {
          color: #999;
          text-align: center;
          padding: 40px 20px;
          font-size: 13px;
        }
        .chat-message {
          margin-bottom: 12px;
          padding: 10px 12px;
          border-radius: 8px;
          max-width: 90%;
        }
        .chat-message--user {
          background: #6c5ce7;
          color: white;
          margin-left: auto;
        }
        .chat-message--assistant {
          background: white;
          border: 1px solid #e0e0e0;
        }
        .chat-message--system {
          background: #fff3cd;
          border: 1px solid #ffc107;
          font-size: 12px;
        }
        .chat-message--loading {
          background: #e8e8e8;
          color: #666;
        }
        .chat-message__role {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          margin-bottom: 4px;
          opacity: 0.7;
        }
        .chat-message--user .chat-message__role {
          color: rgba(255,255,255,0.8);
        }
        .chat-message__content {
          font-size: 13px;
          line-height: 1.5;
        }
        .chat-message__content pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: inherit;
        }
        .chat-message__time {
          font-size: 10px;
          margin-top: 4px;
          opacity: 0.6;
          text-align: right;
        }
        .chat-panel__input {
          display: flex;
          gap: 8px;
          padding: 12px;
          border-top: 1px solid #e0e0e0;
          background: white;
          border-radius: 0 0 12px 12px;
        }
        .chat-panel__input textarea {
          flex: 1;
          padding: 10px 12px;
          border: 1px solid #ddd;
          border-radius: 8px;
          font-size: 13px;
          font-family: inherit;
          resize: none;
          min-height: 40px;
          max-height: 100px;
        }
        .chat-panel__input textarea:focus {
          outline: none;
          border-color: #6c5ce7;
        }
        .chat-panel__input button {
          padding: 10px 20px;
          background: #6c5ce7;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 500;
        }
        .chat-panel__input button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .chat-panel__input button:hover:not(:disabled) {
          background: #5b4cdb;
        }
        .panel__header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .btn-wizard {
          padding: 4px 10px;
          background: #9c27b0;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 11px;
          cursor: pointer;
        }
        .btn-wizard:hover {
          background: #7b1fa2;
        }
        .wizard-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2000;
        }
        .wizard-modal {
          background: white;
          border-radius: 12px;
          width: 500px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        .wizard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid #e0e0e0;
        }
        .wizard-header h2 {
          margin: 0;
          font-size: 18px;
        }
        .wizard-header button {
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: #666;
        }
        .wizard-content {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        .wizard-section {
          margin-bottom: 20px;
        }
        .wizard-section h3 {
          margin: 0 0 12px;
          font-size: 14px;
          font-weight: 600;
          color: #333;
        }
        .wizard-nodes {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .wizard-node {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: #f5f5f5;
          border-radius: 6px;
        }
        .wizard-node__name {
          font-family: monospace;
          font-weight: 600;
        }
        .wizard-node__parent {
          font-size: 12px;
          color: #666;
        }
        .wizard-node__remove {
          margin-left: auto;
          background: #fee;
          color: #c00;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 14px;
        }
        .wizard-add-form {
          display: flex;
          gap: 8px;
        }
        .wizard-add-form input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
        }
        .wizard-add-form select {
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
        }
        .wizard-add-form button {
          padding: 8px 16px;
          background: #9c27b0;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }
        .wizard-add-form button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .wizard-base-select {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
        }
        .wizard-tasks {
          display: flex;
          flex-direction: column;
          gap: 8px;
          max-height: 300px;
          overflow-y: auto;
        }
        .wizard-task {
          padding: 12px;
          background: #f5f5f5;
          border-radius: 8px;
          border-left: 4px solid #9e9e9e;
        }
        .wizard-task--todo {
          border-left-color: #9e9e9e;
        }
        .wizard-task--doing {
          border-left-color: #2196f3;
          background: #e3f2fd;
        }
        .wizard-task--done {
          border-left-color: #4caf50;
          background: #e8f5e9;
        }
        .wizard-task__header {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .wizard-task__status {
          padding: 4px 8px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 12px;
          background: white;
        }
        .wizard-task__title {
          flex: 1;
          font-weight: 600;
          font-size: 14px;
        }
        .wizard-task__start {
          background: #4CAF50;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 4px 12px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        }
        .wizard-task__start:hover {
          background: #45a049;
        }
        .wizard-task__start:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .wizard-task__remove {
          background: #fee;
          color: #c00;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 14px;
        }
        .wizard-task__description {
          margin-top: 6px;
          font-size: 12px;
          color: #666;
          padding-left: 8px;
        }
        .wizard-task__meta {
          display: flex;
          gap: 12px;
          margin-top: 8px;
          font-size: 11px;
          color: #888;
        }
        .wizard-task__parent {
          font-style: italic;
        }
        .wizard-task__branch {
          font-family: monospace;
          background: #e0e0e0;
          padding: 1px 4px;
          border-radius: 3px;
        }
        .wizard-task__worktree {
          background: #4caf50;
          color: white;
          padding: 1px 6px;
          border-radius: 3px;
          font-weight: 500;
        }

        /* Tree Builder styles */
        .wizard-modal--wide {
          width: 900px;
          max-width: 95vw;
        }
        .wizard-header__controls {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .wizard-base-select-inline {
          padding: 6px 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 13px;
        }
        .tree-builder {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          min-height: 400px;
        }
        .tree-builder--locked {
          opacity: 0.8;
          pointer-events: none;
        }
        .tree-builder--locked .task-card {
          cursor: default;
        }
        .tree-builder__backlog,
        .tree-builder__tree {
          display: flex;
          flex-direction: column;
          background: #f8f9fa;
          border-radius: 8px;
          padding: 12px;
        }
        .tree-builder__backlog h3,
        .tree-builder__tree h3 {
          margin: 0 0 12px;
          font-size: 14px;
          color: #666;
        }
        .tree-builder__backlog-list,
        .tree-builder__tree-content {
          flex: 1;
          min-height: 200px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .tree-builder__tree-root {
          flex: 1;
          display: flex;
          flex-direction: column;
        }
        .tree-builder__base-branch {
          padding: 8px 12px;
          background: #2196f3;
          color: white;
          border-radius: 6px;
          font-family: monospace;
          font-weight: 600;
          margin-bottom: 8px;
        }
        .tree-builder__empty {
          padding: 40px 20px;
          text-align: center;
          color: #999;
          border: 2px dashed #ddd;
          border-radius: 8px;
          font-size: 13px;
        }
        .tree-builder__add-form {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #e0e0e0;
        }
        .tree-builder__add-form input {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 13px;
        }
        .tree-builder__add-form button {
          padding: 8px 16px;
          background: #4caf50;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        .tree-builder__add-form button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .tree-builder__node {
          margin-bottom: 4px;
        }
        .tree-builder__children {
          border-left: 2px solid #e0e0e0;
          margin-left: 12px;
          padding-left: 8px;
        }

        /* Task Card styles */
        .task-card {
          background: white;
          border-radius: 8px;
          padding: 10px 12px;
          border-left: 4px solid #9e9e9e;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .task-card--todo {
          border-left-color: #9e9e9e;
        }
        .task-card--doing {
          border-left-color: #2196f3;
          background: #e3f2fd;
        }
        .task-card--done {
          border-left-color: #4caf50;
          background: #e8f5e9;
        }
        .task-card--compact {
          padding: 6px 10px;
        }
        .task-card--dragging {
          background: white;
          padding: 10px 12px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
          font-weight: 600;
        }
        .task-card__header {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .task-card__status {
          padding: 2px 6px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 11px;
          background: white;
        }
        .task-card__title {
          flex: 1;
          font-weight: 600;
          font-size: 13px;
        }
        .task-card__actions {
          display: flex;
          gap: 4px;
        }
        .task-card__start {
          background: #4CAF50;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 11px;
        }
        .task-card__start:disabled {
          background: #ccc;
        }
        .task-card__remove {
          background: #fee;
          color: #c00;
          border: none;
          border-radius: 4px;
          padding: 2px 6px;
          cursor: pointer;
          font-size: 14px;
        }
        .task-card__description {
          margin-top: 6px;
          font-size: 12px;
          color: #666;
        }
        .task-card__meta {
          display: flex;
          gap: 8px;
          margin-top: 6px;
          font-size: 10px;
        }
        .task-card__branch {
          font-family: monospace;
          background: #e0e0e0;
          padding: 1px 4px;
          border-radius: 3px;
        }
        .task-card__worktree {
          background: #4caf50;
          color: white;
          padding: 1px 4px;
          border-radius: 3px;
          font-weight: 600;
        }
        .task-card--clickable {
          cursor: pointer;
          border: 2px solid transparent;
        }
        .task-card--clickable:hover {
          border-color: #2196f3;
        }
        .task-card__open {
          background: #2196f3;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 11px;
        }
        .task-card__open:hover {
          background: #1976d2;
        }
        .task-card__consult {
          background: #9c27b0;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 11px;
        }
        .task-card__consult:hover {
          background: #7b1fa2;
        }

        /* Generation logs */
        .generate-logs {
          margin: 12px 0;
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          background: #1e1e1e;
          color: #d4d4d4;
          font-family: monospace;
          font-size: 12px;
        }
        .generate-logs__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: #2d2d2d;
          border-radius: 8px 8px 0 0;
        }
        .generate-logs__header h4 {
          margin: 0;
          font-size: 12px;
          color: #fff;
        }
        .generate-logs__header button {
          background: none;
          border: none;
          color: #999;
          cursor: pointer;
          font-size: 16px;
        }
        .generate-logs__content {
          padding: 12px;
          max-height: 200px;
          overflow-y: auto;
        }
        .generate-logs__line {
          padding: 2px 0;
        }
        .generate-logs__line--success {
          color: #4caf50;
        }
        .generate-logs__line--error {
          color: #f44336;
        }

        /* Droppable zone styles */
        .droppable-zone {
          transition: background 0.2s;
          border-radius: 6px;
        }
        .droppable-zone--over {
          background: rgba(33, 150, 243, 0.1);
          outline: 2px dashed #2196f3;
        }

        .wizard-empty {
          text-align: center;
          color: #999;
          padding: 20px;
          font-size: 13px;
        }
        .wizard-add-form--vertical {
          flex-direction: column;
        }
        .wizard-add-form--vertical input {
          flex: none;
          width: 100%;
        }
        .wizard-add-row {
          display: flex;
          gap: 8px;
        }
        .wizard-add-row select {
          flex: 1;
        }
        .wizard-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 16px 20px;
          border-top: 1px solid #e0e0e0;
        }
        .wizard-footer__left {
          display: flex;
          align-items: center;
        }
        .wizard-footer__right {
          display: flex;
          gap: 12px;
        }
        .wizard-status {
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
        }
        .wizard-status--draft {
          background: #fff3e0;
          color: #e65100;
        }
        .wizard-status--confirmed {
          background: #e3f2fd;
          color: #1565c0;
        }
        .wizard-status--generated {
          background: #e8f5e9;
          color: #2e7d32;
        }
        .wizard-locked-notice {
          background: #fff3e0;
          color: #e65100;
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 12px;
          text-align: center;
          margin-bottom: 12px;
        }
        .btn-secondary {
          padding: 10px 20px;
          background: #f5f5f5;
          color: #333;
          border: 1px solid #ddd;
          border-radius: 6px;
          cursor: pointer;
        }
        .btn-secondary:hover {
          background: #e8e8e8;
        }
        .btn-create-all {
          padding: 10px 20px;
          background: #ff9800;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
        }
        .btn-create-all:hover {
          background: #f57c00;
        }
        .btn-create-all:disabled {
          background: #ccc;
          cursor: not-allowed;
        }

        /* Modal styles */
        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2000;
        }
        .modal {
          background: white;
          border-radius: 12px;
          width: 500px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        .modal__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid #e0e0e0;
        }
        .modal__header h2 {
          margin: 0;
          font-size: 18px;
        }
        .modal__header button {
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: #666;
        }
        .modal__content {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        .modal__loading {
          text-align: center;
          padding: 40px;
          color: #666;
        }
        .modal__error {
          color: #c00;
          text-align: center;
          padding: 20px;
        }
        .modal__success {
          background: #e8f5e9;
          color: #2e7d32;
          padding: 12px 16px;
          border-radius: 6px;
          margin-bottom: 16px;
          text-align: center;
        }
        .modal__footer {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding: 16px 20px;
          border-top: 1px solid #e0e0e0;
        }

        /* Settings styles */
        .settings-section {
          margin-bottom: 20px;
        }
        .settings-section label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          color: #666;
          text-transform: uppercase;
          margin-bottom: 8px;
        }
        .settings-section input[type="text"] {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
        }
        .settings-section textarea {
          width: 100%;
          min-height: 80px;
          padding: 10px 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
          font-family: inherit;
          resize: vertical;
        }
        .settings-section small {
          display: block;
          margin-top: 4px;
          font-size: 11px;
          color: #888;
        }
        .settings-examples {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 10px;
        }
        .settings-example {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          background: #f0f0f0;
          border-radius: 4px;
          font-size: 12px;
        }
        .settings-example code {
          font-family: monospace;
        }
        .settings-example button {
          background: none;
          border: none;
          color: #c00;
          cursor: pointer;
          padding: 0 4px;
          font-size: 14px;
        }
        .settings-add-example {
          display: flex;
          gap: 8px;
        }
        .settings-add-example input {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 13px;
        }
        .settings-add-example button {
          padding: 8px 16px;
          background: #0066cc;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }

        /* Chat button in details panel */
        .btn-chat {
          margin-top: 8px;
          padding: 8px 16px;
          background: #6c5ce7;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-chat:hover {
          background: #5b4cdb;
        }
      `}</style>
    </div>
  );
}
