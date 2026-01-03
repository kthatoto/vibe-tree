import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  api,
  type Plan,
  type ScanSnapshot,
  type TreeNode,
  type RepoPin,
  type TreeSpecNode,
  type TreeSpecEdge,
  type TaskStatus,
  type TreeSpecStatus,
  type BranchNamingRule,
} from "../lib/api";
import { wsClient } from "../lib/ws";
import BranchGraph from "../components/BranchGraph";
import { TerminalPanel } from "../components/TerminalPanel";
import { TaskCard } from "../components/TaskCard";
import { DraggableTask, DroppableTreeNode } from "../components/DndComponents";
import { PlanningPanel } from "../components/PlanningPanel";
import { TaskDetailPanel } from "../components/TaskDetailPanel";
import type { PlanningSession, TaskNode, TaskEdge } from "../lib/api";

export default function TreeDashboard() {
  const { pinId: urlPinId } = useParams<{ pinId?: string }>();
  const navigate = useNavigate();

  // Repo pins state
  const [repoPins, setRepoPins] = useState<RepoPin[]>([]);
  const [newLocalPath, setNewLocalPath] = useState("");
  const [showAddNew, setShowAddNew] = useState(false);
  const [deletingPinId, setDeletingPinId] = useState<number | null>(null);

  // Selected pin derived from URL
  const selectedPinId = urlPinId ? parseInt(urlPinId, 10) : null;

  // Main state
  const [plan, setPlan] = useState<Plan | null>(null);
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);


  // Multi-session planning state
  const [selectedPlanningSession, setSelectedPlanningSession] = useState<PlanningSession | null>(null);
  const [tentativeNodes, setTentativeNodes] = useState<TaskNode[]>([]);
  const [tentativeEdges, setTentativeEdges] = useState<TaskEdge[]>([]);
  const [planningPanelCollapsed, setPlanningPanelCollapsed] = useState(false);

  // Terminal state
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalWorktreePath, setTerminalWorktreePath] = useState<string | null>(null);
  const [terminalTaskContext, setTerminalTaskContext] = useState<{ title: string; description?: string } | undefined>(undefined);
  const [terminalAutoRunClaude, setTerminalAutoRunClaude] = useState(false);


  // Tree Spec state (Task-based)
  const [wizardBaseBranch, setWizardBaseBranch] = useState<string>("main");
  const [wizardNodes, setWizardNodes] = useState<TreeSpecNode[]>([]);
  const [wizardEdges, setWizardEdges] = useState<TreeSpecEdge[]>([]);
  const [wizardStatus, setWizardStatus] = useState<TreeSpecStatus>("draft");

  // Branch graph edit mode
  const [branchGraphEditMode, setBranchGraphEditMode] = useState(false);

  // Create branch dialog
  const [createBranchBase, setCreateBranchBase] = useState<string | null>(null);
  const [createBranchName, setCreateBranchName] = useState("");
  const [createBranchLoading, setCreateBranchLoading] = useState(false);

  // Fetch state
  const [fetching, setFetching] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [originalTreeSpecEdges, setOriginalTreeSpecEdges] = useState<TreeSpecEdge[] | null>(null);

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [settingsRule, setSettingsRule] = useState<BranchNamingRule | null>(null);
  const [settingsPattern, setSettingsPattern] = useState("");
  const [settingsDefaultBranch, setSettingsDefaultBranch] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Warnings modal state
  const [showWarnings, setShowWarnings] = useState(false);
  const [warningFilter, setWarningFilter] = useState<string | null>(null);

  // D&D sensors (reserved for future drag-and-drop)
  void useSensors(
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

  // Define handleScan before useEffects that use it
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

  const handleFetch = useCallback(async (localPath: string) => {
    if (!localPath) return;
    setFetching(true);
    setError(null);
    try {
      await api.fetch(localPath);
      // Rescan after fetch to update the view
      const result = await api.scan(localPath);
      setSnapshot(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFetching(false);
    }
  }, []);

  // Auto-scan when pin is selected
  useEffect(() => {
    if (selectedPin && !snapshot) {
      handleScan(selectedPin.localPath);
    }
  }, [selectedPin?.id, handleScan]);

  // Sync selectedNode with latest snapshot data
  useEffect(() => {
    if (selectedNode && snapshot) {
      const updatedNode = snapshot.nodes.find((n) => n.branchName === selectedNode.branchName);
      if (updatedNode && updatedNode !== selectedNode) {
        setSelectedNode(updatedNode);
      } else if (!updatedNode) {
        // Node was deleted
        setSelectedNode(null);
      }
    }
  }, [snapshot, selectedNode]);

  // Load plan and connect WS when snapshot is available
  useEffect(() => {
    if (!snapshot?.repoId) return;

    api.getCurrentPlan(snapshot.repoId).then(setPlan).catch(console.error);
    wsClient.connect(snapshot.repoId);

    const unsubScan = wsClient.on("scan.updated", (msg) => {
      // Use the snapshot data from the broadcast directly (don't re-scan to avoid infinite loop)
      if (msg.data && typeof msg.data === "object" && "repoId" in msg.data) {
        setSnapshot(msg.data as ScanSnapshot);
      }
    });

    // Refetch branches when planning is confirmed
    const unsubBranches = wsClient.on("branches.changed", () => {
      if (selectedPin) {
        handleScan(selectedPin.localPath);
      }
    });

    // Update Branch Graph when PR info is refreshed
    const unsubBranchLink = wsClient.on("branchLink.updated", (msg) => {
      const data = msg.data as {
        branchName: string;
        linkType: string;
        status: string | null;
        checksStatus: string | null;
        reviewDecision: string | null;
      };
      if (data.linkType === "pr") {
        setSnapshot((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            nodes: prev.nodes.map((node) => {
              if (node.branchName === data.branchName && node.pr) {
                return {
                  ...node,
                  pr: {
                    ...node.pr,
                    state: data.status?.toUpperCase() || node.pr.state,
                    reviewDecision: data.reviewDecision || node.pr.reviewDecision,
                    checks: data.checksStatus?.toUpperCase() || node.pr.checks,
                  },
                };
              }
              return node;
            }),
          };
        });
      }
    });

    return () => {
      unsubScan();
      unsubBranches();
      unsubBranchLink();
    };
  }, [snapshot?.repoId, selectedPin, handleScan]);

  // Planning session handlers
  const handlePlanningSessionSelect = useCallback((session: PlanningSession | null) => {
    setSelectedPlanningSession(session);
    if (session) {
      setTentativeNodes(session.nodes);
      setTentativeEdges(session.edges);
    } else {
      setTentativeNodes([]);
      setTentativeEdges([]);
    }
  }, []);

  const handlePlanningTasksChange = useCallback((nodes: TaskNode[], edges: TaskEdge[]) => {
    setTentativeNodes(nodes);
    setTentativeEdges(edges);
  }, []);

  const handleAddRepoPin = async () => {
    if (!newLocalPath.trim()) return;
    try {
      const pin = await api.createRepoPin(newLocalPath.trim());
      setRepoPins((prev) => [pin, ...prev]);
      navigate(`/projects/${pin.id}`);
      setNewLocalPath("");
      setShowAddNew(false);
      setSnapshot(null); // Will trigger auto-scan via useEffect
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSelectPin = async (id: number) => {
    navigate(`/projects/${id}`);
    setSnapshot(null); // Reset to trigger new scan
    try {
      await api.useRepoPin(id);
    } catch (err) {
      console.error("Failed to mark pin as used:", err);
    }
  };

  const handleConfirmDeletePin = async () => {
    if (!deletingPinId) return;
    const id = deletingPinId;
    try {
      await api.deleteRepoPin(id);
      setRepoPins((prev) => prev.filter((p) => p.id !== id));
      if (selectedPinId === id) {
        const remaining = repoPins.filter((p) => p.id !== id);
        navigate(remaining.length > 0 ? `/projects/${remaining[0].id}` : "/");
        setSnapshot(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingPinId(null);
    }
  };

  // Create branch handler
  const handleCreateBranch = async () => {
    if (!createBranchBase || !createBranchName.trim() || !selectedPin || !snapshot) return;

    setCreateBranchLoading(true);
    try {
      const newBranchName = createBranchName.trim();

      // Create the git branch
      await api.createBranch(selectedPin.localPath, newBranchName, createBranchBase);

      // Add edge to tree spec (parent -> child relationship)
      const currentEdges = snapshot.treeSpec?.specJson.edges ?? [];
      const currentNodes = snapshot.treeSpec?.specJson.nodes ?? [];

      // Add edge from base branch to new branch
      const newEdges = [
        ...currentEdges,
        { parent: createBranchBase, child: newBranchName },
      ];

      // Update tree spec
      await api.updateTreeSpec({
        repoId: snapshot.repoId,
        baseBranch: snapshot.treeSpec?.baseBranch ?? snapshot.defaultBranch,
        nodes: currentNodes,
        edges: newEdges,
      });

      // Rescan to update the graph
      const newSnapshot = await api.scan(selectedPin.localPath);
      setSnapshot(newSnapshot);

      // Close dialog
      setCreateBranchBase(null);
      setCreateBranchName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreateBranchLoading(false);
    }
  };

  // Terminal handlers
  const handleOpenTerminal = (worktreePath: string, taskContext?: { title: string; description?: string }, autoRunClaude = false) => {
    setTerminalWorktreePath(worktreePath);
    setTerminalTaskContext(taskContext);
    setTerminalAutoRunClaude(autoRunClaude);
    setShowTerminal(true);
  };

  const handleCloseTerminal = () => {
    setShowTerminal(false);
    setTerminalWorktreePath(null);
    setTerminalTaskContext(undefined);
    setTerminalAutoRunClaude(false);
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
              showClaudeButton={true}
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
  const generateBranchName = (title: string, taskId?: string): string => {
    let slug = title
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")  // collapse multiple dashes
      .replace(/^-|-$/g, "") // trim leading/trailing dashes
      .substring(0, 50);

    // Fallback if slug is empty (e.g., Japanese-only title)
    if (!slug) {
      slug = taskId ? taskId.substring(0, 8) : `task-${Date.now()}`;
    }

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

    const branchName = generateBranchName(task.title, task.id);
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

  // Handle clicking a task node to open its terminal
  const handleTaskNodeClick = (task: TreeSpecNode) => {
    if (!task.worktreePath) return;
    handleOpenTerminal(task.worktreePath, {
      title: task.title,
      description: task.description,
    });
  };

  // Handle consulting about a task - open terminal with Claude (auto-run)
  const handleConsultTask = (task: TreeSpecNode) => {
    if (!selectedPin) return;
    // Use worktree path if available, otherwise use main repo path
    const terminalPath = task.worktreePath || selectedPin.localPath;
    handleOpenTerminal(terminalPath, {
      title: task.title,
      description: task.description,
    }, true); // Auto-run Claude
  };

  // Check if can confirm: has base branch, has nodes, has at least one root
  const childIds = new Set(wizardEdges.map((e) => e.child));
  const rootNodes = wizardNodes.filter((n) => !childIds.has(n.id));
  void (wizardBaseBranch && wizardNodes.length > 0 && rootNodes.length > 0); // canConfirm reserved for future use
  const isLocked = wizardStatus === "confirmed" || wizardStatus === "generated";

  // Settings functions
  const handleOpenSettings = async () => {
    if (!snapshot?.repoId || !selectedPin) return;
    setShowSettings(true);
    setSettingsLoading(true);
    setSettingsDefaultBranch(selectedPin.baseBranch || "");
    try {
      const rule = await api.getBranchNaming(snapshot.repoId);
      setSettingsRule(rule);
      setSettingsPattern(rule.pattern);
    } catch {
      // Default rule if not exists
      setSettingsRule({ pattern: "feat_{issueId}_{taskSlug}" });
      setSettingsPattern("feat_{issueId}_{taskSlug}");
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!snapshot?.repoId || !selectedPin) return;
    setSettingsLoading(true);
    setSettingsSaved(false);
    try {
      // Save branch naming rule
      const updated = await api.updateBranchNaming({
        repoId: snapshot.repoId,
        pattern: settingsPattern,
      });
      setSettingsRule(updated);

      // Save default branch (empty string clears it)
      await api.updateRepoPin(selectedPin.id, { baseBranch: settingsDefaultBranch || null });
      // Refresh pins to update baseBranch
      const pins = await api.getRepoPins();
      setRepoPins(pins);

      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSettingsLoading(false);
    }
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
                  setDeletingPinId(pin.id);
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
            background: #0f172a;
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
            color: #e5e7eb;
          }
          .project-list-header p {
            margin: 0;
            color: #9ca3af;
          }
          .project-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 24px;
          }
          .project-card {
            background: #1f2937;
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            border: 1px solid #374151;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            position: relative;
            transition: all 0.2s;
          }
          .project-card:hover {
            border-color: #3b82f6;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
          }
          .project-card__name {
            font-weight: 600;
            font-size: 18px;
            margin-bottom: 4px;
          }
          .project-card__path {
            font-size: 13px;
            color: #6b7280;
            font-family: monospace;
          }
          .project-card__delete {
            position: absolute;
            top: 12px;
            right: 12px;
            background: #7f1d1d;
            color: #f87171;
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
            color: #6b7280;
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
            background: #111827;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          }
          .add-project-form input {
            width: 100%;
            padding: 14px;
            border: 2px solid #374151;
            border-radius: 8px;
            font-size: 16px;
            margin-bottom: 12px;
            background: #111827;
            color: #e5e7eb;
          }
          .add-project-form input:focus {
            outline: none;
            border-color: #3b82f6;
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
            background: #7f1d1d;
            color: #f87171;
            border-radius: 8px;
            text-align: center;
          }
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
            background: #111827;
            border-radius: 12px;
            width: 360px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6);
          }
          .modal__header {
            padding: 16px 20px;
            border-bottom: 1px solid #374151;
          }
          .modal__header h2 {
            margin: 0;
            font-size: 18px;
          }
          .modal__body {
            padding: 20px;
          }
          .modal__footer {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding: 16px 20px;
            border-top: 1px solid #374151;
          }
          .btn-secondary {
            background: #374151;
            color: #e5e7eb;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
          }
          .btn-danger {
            background: #dc2626;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
          }
          .btn-danger:hover {
            background: #b91c1c;
          }
        `}</style>

        {/* Delete Confirmation Modal */}
        {deletingPinId && (
          <div className="modal-overlay" onClick={() => setDeletingPinId(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal__header">
                <h2>プロジェクトを削除</h2>
              </div>
              <div className="modal__body">
                <p style={{ margin: 0, color: "#9ca3af" }}>
                  「{repoPins.find(p => p.id === deletingPinId)?.label || repoPins.find(p => p.id === deletingPinId)?.repoId}」を削除しますか？
                </p>
                <p style={{ margin: "8px 0 0", fontSize: 13, color: "#6b7280" }}>
                  ※ローカルのファイルは削除されません
                </p>
              </div>
              <div className="modal__footer">
                <button className="btn-secondary" onClick={() => setDeletingPinId(null)}>
                  キャンセル
                </button>
                <button className="btn-danger" onClick={handleConfirmDeletePin}>
                  削除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="dashboard dashboard--with-sidebar">
      {/* Left Sidebar */}
      <aside className="sidebar">
        <div className="sidebar__header">
          <button className="sidebar__back" onClick={() => {
            navigate("/");
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
                  className={`sidebar__worktree ${selectedNode?.branchName === wt.branch ? "sidebar__worktree--selected" : ""}`}
                  onClick={() => {
                    const node = snapshot.nodes.find((n) => n.branchName === wt.branch);
                    if (node) setSelectedNode(node);
                  }}
                >
                  <div className="sidebar__worktree-branch">
                    {wt.branch || "(detached)"}
                    {wt.dirty && <span className="sidebar__worktree-dirty">●</span>}
                  </div>
                  <div className="sidebar__worktree-path">{wt.path.split("/").pop()}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Warnings */}
        {snapshot && snapshot.warnings.length > 0 && (
          <div className="sidebar__section">
            <button
              className="sidebar__warnings-btn"
              onClick={() => setShowWarnings(true)}
            >
              <span className="sidebar__warnings-icon">⚠</span>
              <span>Warnings</span>
              <span className="sidebar__warnings-count">{snapshot.warnings.length}</span>
            </button>
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
                    {branchGraphEditMode ? (
                      <>
                        <button
                          className="btn-icon btn-icon--danger"
                          disabled={discarding}
                          onClick={async () => {
                            // Discard: restore original edges
                            if (selectedPin && snapshot?.repoId && originalTreeSpecEdges !== null) {
                              setDiscarding(true);
                              try {
                                await api.updateTreeSpec({
                                  repoId: snapshot.repoId,
                                  baseBranch: snapshot.treeSpec?.baseBranch ?? snapshot.defaultBranch,
                                  nodes: snapshot.treeSpec?.specJson.nodes ?? [],
                                  edges: originalTreeSpecEdges,
                                });
                                const newSnapshot = await api.scan(selectedPin.localPath);
                                setSnapshot(newSnapshot);
                              } catch (err) {
                                console.error("Failed to discard:", err);
                              } finally {
                                setDiscarding(false);
                              }
                            }
                            setOriginalTreeSpecEdges(null);
                            setBranchGraphEditMode(false);
                          }}
                          title="変更を破棄"
                        >
                          {discarding ? "Discarding..." : "Discard"}
                        </button>
                        <button
                          className="btn-icon btn-icon--active"
                          onClick={() => {
                            setOriginalTreeSpecEdges(null);
                            setBranchGraphEditMode(false);
                          }}
                          title="編集モード終了"
                          disabled={discarding}
                        >
                          Done
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn-icon"
                          onClick={() => {
                            // Save current edges before entering edit mode
                            setOriginalTreeSpecEdges(snapshot.treeSpec?.specJson.edges ?? []);
                            setBranchGraphEditMode(true);
                          }}
                          title="ブランチ構造を編集"
                        >
                          Edit
                        </button>
                        <button
                          className="btn-icon"
                          onClick={() => selectedPin && handleFetch(selectedPin.localPath)}
                          disabled={fetching}
                          title="Fetch from remote"
                        >
                          {fetching ? "Fetching..." : "Fetch"}
                        </button>
                      </>
                    )}
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
                    tentativeNodes={tentativeNodes}
                    tentativeEdges={tentativeEdges}
                    editMode={branchGraphEditMode}
                    onEdgeCreate={async (parentBranch, childBranch) => {
                      // Create a new edge from parent to child (reparent operation)
                      // This will be saved in tree_specs as a designed edge
                      if (!snapshot?.repoId || !selectedPin) return;

                      try {
                        // Get current tree spec edges (using branch names directly)
                        const currentEdges = snapshot.treeSpec?.specJson.edges ?? [];

                        // Check if this exact edge already exists
                        const edgeExists = currentEdges.some(
                          (e) => e.parent === parentBranch && e.child === childBranch
                        ) || snapshot.edges.some(
                          (e) => e.parent === parentBranch && e.child === childBranch
                        );

                        if (edgeExists) {
                          console.log("Edge already exists");
                          return;
                        }

                        // Remove any existing edges where childBranch is the child (reparent)
                        // This ensures a branch can only have one parent
                        const filteredEdges = currentEdges.filter(
                          (e) => e.child !== childBranch
                        );

                        // Add the new edge using branch names directly
                        const newEdges = [
                          ...filteredEdges,
                          { parent: parentBranch, child: childBranch },
                        ];

                        // Keep existing nodes (don't add phantom nodes for branches)
                        const currentNodes = snapshot.treeSpec?.specJson.nodes ?? [];

                        // Save tree spec
                        const updatedSpec = await api.updateTreeSpec({
                          repoId: snapshot.repoId,
                          baseBranch: snapshot.treeSpec?.baseBranch ?? snapshot.defaultBranch,
                          nodes: currentNodes,
                          edges: newEdges,
                        });

                        setSnapshot((prev) =>
                          prev ? { ...prev, treeSpec: updatedSpec } : prev
                        );

                        // Rescan to update edges display
                        const newSnapshot = await api.scan(selectedPin.localPath);
                        setSnapshot(newSnapshot);
                      } catch (err) {
                        console.error("Failed to create edge:", err);
                        setError((err as Error).message);
                      }
                    }}
                    tentativeBaseBranch={selectedPlanningSession?.baseBranch}
                    onBranchCreate={(baseBranch) => {
                      setCreateBranchBase(baseBranch);
                      setCreateBranchName("");
                    }}
                  />
                </div>
              </div>

              {/* Planning Panel - Multi-session */}
              <div className={`panel panel--planning ${planningPanelCollapsed ? "panel--planning-collapsed" : ""}`}>
                <PlanningPanel
                  repoId={snapshot.repoId}
                  branches={snapshot.branches}
                  defaultBranch={snapshot.defaultBranch}
                  onTasksChange={handlePlanningTasksChange}
                  onSessionSelect={handlePlanningSessionSelect}
                  onCollapseChange={setPlanningPanelCollapsed}
                />
              </div>{/* panel--planning */}
            </div>

            {/* Right: Details */}
            <div className="tree-view__details">
              {selectedNode && selectedPin ? (
                <TaskDetailPanel
                  key={selectedNode.branchName}
                  repoId={snapshot.repoId}
                  localPath={selectedPin.localPath}
                  branchName={selectedNode.branchName}
                  node={selectedNode}
                  defaultBranch={snapshot.defaultBranch}
                  parentBranch={snapshot.edges.find((e) => e.child === selectedNode.branchName)?.parent}
                  onClose={() => setSelectedNode(null)}
                  onWorktreeCreated={() => handleScan(selectedPin.localPath)}
                />
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
            </div>
          </div>
        )}

        {!snapshot && loading && (
          <div className="loading-state">
            <div className="loading-state__spinner">
              <div className="spinner spinner--large" />
            </div>
            <p>Loading repository...</p>
          </div>
        )}

        {!snapshot && !loading && (
          <div className="empty-state">
            <h2>No repository selected</h2>
            <p>Select a repository from the sidebar and click Scan to get started.</p>
          </div>
        )}
      </main>

      {/* Terminal Panel (floating) */}
      {showTerminal && terminalWorktreePath && snapshot && (
        <div className="terminal-panel">
          <TerminalPanel
            repoId={snapshot.repoId}
            worktreePath={terminalWorktreePath}
            onClose={handleCloseTerminal}
            taskContext={terminalTaskContext}
            autoRunClaude={terminalAutoRunClaude}
          />
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
                    <label>Default Branch</label>
                    <input
                      type="text"
                      value={settingsDefaultBranch}
                      onChange={(e) => setSettingsDefaultBranch(e.target.value)}
                      placeholder="develop"
                    />
                    <small>Task Instruction と Chat は表示されません</small>
                  </div>
                  <div className="settings-section">
                    <label>Branch Naming Pattern</label>
                    <input
                      type="text"
                      value={settingsPattern}
                      onChange={(e) => setSettingsPattern(e.target.value)}
                      placeholder="feat_{issueId}_{taskSlug}"
                    />
                    <small>Use {"{issueId}"} and {"{taskSlug}"} as placeholders</small>
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

      {/* Warnings Modal */}
      {showWarnings && snapshot && (() => {
        const WARNING_CONFIG: Record<string, { label: string; color: string }> = {
          BEHIND_PARENT: { label: "Behind Parent", color: "#f59e0b" },
          BRANCH_NAMING_VIOLATION: { label: "Branch Naming", color: "#8b5cf6" },
          DIRTY: { label: "Uncommitted Changes", color: "#ef4444" },
          CI_FAIL: { label: "CI Failed", color: "#dc2626" },
          TREE_DIVERGENCE: { label: "Tree Divergence", color: "#06b6d4" },
          ORDER_BROKEN: { label: "Order Broken", color: "#ec4899" },
        };
        const getWarningConfig = (code: string) => WARNING_CONFIG[code] || { label: code, color: "#6b7280" };

        // Get unique warning codes that exist in current warnings
        const existingCodes = [...new Set(snapshot.warnings.map((w) => w.code))];

        return (
        <div className="modal-overlay" onClick={() => setShowWarnings(false)}>
          <div className="modal modal--warnings" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>Warnings ({snapshot.warnings.length})</h2>
              <button onClick={() => setShowWarnings(false)}>×</button>
            </div>
            <div className="modal__filters">
              <button
                className={`filter-btn ${warningFilter === null ? "filter-btn--active" : ""}`}
                onClick={() => setWarningFilter(null)}
              >
                All
              </button>
              {existingCodes.map((code) => (
                <button
                  key={code}
                  className={`filter-btn ${warningFilter === code ? "filter-btn--active" : ""}`}
                  onClick={() => setWarningFilter(code)}
                >
                  {getWarningConfig(code).label}
                </button>
              ))}
            </div>
            <div className="modal__content modal__content--scrollable">
              {snapshot.warnings
                .filter((w) => warningFilter === null || w.code === warningFilter)
                .map((w, i) => {
                  const config = getWarningConfig(w.code);
                  return (
                  <div key={i} className={`warning-item warning-item--${w.severity}`}>
                    <div className="warning-item__header">
                      <span
                        className="warning-item__code"
                        style={{ background: config.color }}
                      >
                        {config.label}
                      </span>
                      <span className={`warning-item__severity warning-item__severity--${w.severity}`}>
                        {w.severity}
                      </span>
                    </div>
                    <div className="warning-item__message">{w.message}</div>
                  </div>
                  );
                })}
              {snapshot.warnings.filter((w) => warningFilter === null || w.code === warningFilter).length === 0 && (
                <div className="modal__empty">No warnings match the filter</div>
              )}
            </div>
            <div className="modal__footer">
              <button className="btn-secondary" onClick={() => setShowWarnings(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Delete Confirmation Modal */}
      {deletingPinId && (
        <div className="modal-overlay" onClick={() => setDeletingPinId(null)}>
          <div className="modal modal--small" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>プロジェクトを削除</h2>
            </div>
            <div className="modal__body">
              <p style={{ margin: 0, color: "#9ca3af" }}>
                「{repoPins.find(p => p.id === deletingPinId)?.label || repoPins.find(p => p.id === deletingPinId)?.repoId}」を削除しますか？
              </p>
              <p style={{ margin: "8px 0 0", fontSize: 13, color: "#6b7280" }}>
                ※ローカルのファイルは削除されません
              </p>
            </div>
            <div className="modal__footer">
              <button className="btn-secondary" onClick={() => setDeletingPinId(null)}>
                キャンセル
              </button>
              <button className="btn-danger" onClick={handleConfirmDeletePin}>
                削除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Branch Modal */}
      {createBranchBase && (
        <div className="modal-overlay" onClick={() => setCreateBranchBase(null)}>
          <div className="modal modal--small" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>ブランチ作成</h2>
            </div>
            <div className="modal__body">
              <p style={{ margin: "0 0 12px", color: "#9ca3af", fontSize: 13 }}>
                ベース: <code style={{ background: "#1f2937", padding: "2px 6px", borderRadius: 4 }}>{createBranchBase}</code>
              </p>
              <input
                type="text"
                value={createBranchName}
                onChange={(e) => setCreateBranchName(e.target.value)}
                placeholder="新しいブランチ名"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  background: "#1f2937",
                  border: "1px solid #374151",
                  borderRadius: 6,
                  color: "#e5e7eb",
                  fontSize: 14,
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && createBranchName.trim() && !createBranchLoading) {
                    handleCreateBranch();
                  }
                }}
                autoFocus
              />
            </div>
            <div className="modal__footer">
              <button className="btn-secondary" onClick={() => setCreateBranchBase(null)}>
                キャンセル
              </button>
              <button
                className="btn-primary"
                disabled={!createBranchName.trim() || createBranchLoading}
                onClick={handleCreateBranch}
              >
                {createBranchLoading ? "作成中..." : "作成"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .dashboard {
          min-height: 100vh;
          background: #0f172a;
        }
        .dashboard--with-sidebar {
          display: flex;
        }

        /* Sidebar styles */
        .sidebar {
          width: 280px;
          min-width: 280px;
          background: #111827;
          border-right: 1px solid #374151;
          display: flex;
          flex-direction: column;
          height: 100vh;
          position: sticky;
          top: 0;
          overflow-y: auto;
        }
        .sidebar__header {
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
        }
        .sidebar__header h1 {
          margin: 0;
          font-size: 18px;
          color: #e5e7eb;
        }
        .sidebar__back {
          background: none;
          border: none;
          color: #9ca3af;
          font-size: 13px;
          cursor: pointer;
          padding: 0;
        }
        .sidebar__back:hover {
          color: #e5e7eb;
        }
        .sidebar__project-name {
          font-weight: 600;
          font-size: 16px;
          margin-bottom: 4px;
        }
        .sidebar__section {
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
        }
        .sidebar__section h3 {
          margin: 0 0 10px;
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
          text-transform: uppercase;
        }
        .sidebar__path {
          font-size: 11px;
          color: #6b7280;
          margin-top: 8px;
          word-break: break-all;
          font-family: monospace;
        }
        .sidebar__btn {
          width: 100%;
          padding: 10px 16px;
          border: 1px solid #374151;
          border-radius: 6px;
          background: #111827;
          color: #e5e7eb;
          cursor: pointer;
          font-size: 14px;
          margin-bottom: 8px;
        }
        .sidebar__btn:hover {
          background: #0f172a;
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
          background: #4b5563;
          border-color: #4b5563;
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
        .sidebar__warnings-btn {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 12px;
          background: #422006;
          border: 1px solid #f59e0b;
          border-radius: 6px;
          color: #fbbf24;
          cursor: pointer;
          font-size: 13px;
          transition: all 0.2s;
        }
        .sidebar__warnings-btn:hover {
          background: #713f12;
        }
        .sidebar__warnings-icon {
          font-size: 14px;
        }
        .sidebar__warnings-count {
          background: #f59e0b;
          color: #422006;
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 600;
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
          flex-direction: column;
          padding: 8px 10px;
          background: #1e293b;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
          border: 1px solid transparent;
          transition: all 0.15s;
        }
        .sidebar__worktree:hover {
          background: #334155;
        }
        .sidebar__worktree--selected {
          background: #1e3a5f;
          border-color: #3b82f6;
        }
        .sidebar__worktree--active {
          background: #14532d;
          border-left: 3px solid #22c55e;
        }
        .sidebar__worktree-branch {
          font-family: monospace;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .sidebar__worktree-dirty {
          color: #f59e0b;
          font-size: 8px;
        }
        .sidebar__worktree-path {
          font-size: 10px;
          color: #9ca3af;
          margin-top: 2px;
        }
        .sidebar__worktree-terminal {
          padding: 2px 8px;
          background: #1a1b26;
          color: white;
          border: none;
          border-radius: 3px;
          font-size: 12px;
          cursor: pointer;
        }
        .sidebar__worktree-terminal:hover {
          background: #24283b;
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
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 13px;
        }
        .add-repo-form {
          margin-top: 10px;
        }
        .add-repo-form input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #374151;
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
          border: 1px solid #374151;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          background: #111827;
        }
        .add-repo-form__buttons button:first-child {
          background: #0066cc;
          color: white;
          border-color: #0066cc;
        }
        .btn-delete {
          padding: 4px 8px;
          background: #7f1d1d;
          color: #f87171;
          border: 1px solid #991b1b;
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
          background: #7f1d1d;
          color: #f87171;
          padding: 12px 16px;
          border-radius: 6px;
          margin-bottom: 16px;
        }
        .empty-state {
          text-align: center;
          padding: 60px 20px;
          color: #9ca3af;
        }
        .empty-state h2 {
          margin: 0 0 8px;
          font-size: 18px;
          color: #e5e7eb;
        }
        .empty-state p {
          margin: 0;
          font-size: 14px;
        }
        .loading-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 80px 20px;
          color: #9ca3af;
        }
        .loading-state__spinner {
          margin-bottom: 16px;
        }
        .loading-state p {
          font-size: 14px;
          margin: 0;
        }
        .spinner--large {
          width: 48px;
          height: 48px;
          border-width: 4px;
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
          transition: flex 0.2s ease;
        }
        .graph-container {
          flex: 1;
          overflow: auto;
          background: #1f2937;
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
          color: #6b7280;
        }
        .branch-graph__svg {
          display: block;
        }
        .panel {
          background: #111827;
          border: 1px solid #374151;
          border-radius: 8px;
          padding: 16px;
        }
        .panel--warnings {
          border-color: #f59e0b;
        }
        .panel--planning {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: transparent;
          border: none;
          padding: 0;
          transition: flex 0.2s ease;
        }
        .panel--planning-collapsed {
          flex: 0 0 auto;
        }
        .planning-panel__layout {
          flex: 1;
          display: flex;
          gap: 16px;
          min-height: 0;
          overflow: hidden;
        }
        .planning-panel__chat {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .planning-panel__tree {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        /* External Links */
        .external-links {
          flex-shrink: 0;
          margin-bottom: 12px;
          padding-bottom: 12px;
          border-bottom: 1px solid #374151;
        }
        .external-links__header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .external-links__title {
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
        }
        .external-links__count {
          font-size: 11px;
          background: #374151;
          padding: 1px 6px;
          border-radius: 10px;
          color: #9ca3af;
        }
        .external-links__add {
          display: flex;
          gap: 6px;
          margin-bottom: 8px;
        }
        .external-links__add input {
          flex: 1;
          padding: 6px 10px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 12px;
        }
        .external-links__add button {
          padding: 6px 12px;
          background: #2196f3;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          cursor: pointer;
        }
        .external-links__add button:disabled {
          background: #4b5563;
          cursor: not-allowed;
        }
        .external-links__list {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .external-link-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 8px;
          background: #0f172a;
          border-radius: 4px;
          font-size: 12px;
        }
        .external-link-item__type {
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          color: white;
          flex-shrink: 0;
        }
        .external-link-item__type--notion { background: #000; }
        .external-link-item__type--figma { background: #f24e1e; }
        .external-link-item__type--github_issue { background: #238636; }
        .external-link-item__type--github_pr { background: #8957e5; }
        .external-link-item__type--url { background: #666; }
        .external-link-item__title {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #e5e7eb;
          text-decoration: none;
        }
        .external-link-item__title:hover {
          text-decoration: underline;
        }
        .external-link-item__refresh,
        .external-link-item__remove {
          width: 20px;
          height: 20px;
          border: none;
          background: transparent;
          cursor: pointer;
          font-size: 12px;
          color: #6b7280;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 3px;
        }
        .external-link-item__refresh:hover {
          background: #374151;
          color: #2196f3;
        }
        .external-link-item__remove:hover {
          background: #ffebee;
          color: #f44336;
        }
        .task-tree-panel__settings {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          padding-bottom: 12px;
          border-bottom: 1px solid #374151;
        }
        .task-tree-panel__settings label {
          font-size: 13px;
          color: #9ca3af;
        }
        .task-tree-panel__settings select {
          flex: 1;
          padding: 6px 8px;
          border: 1px solid #374151;
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
          border: 1px solid #374151;
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
          background: #4b5563;
          cursor: not-allowed;
        }
        .task-tree-panel__settings,
        .task-tree-panel__add {
          flex-shrink: 0;
        }
        .task-tree-panel__content {
          flex: 1;
          display: flex;
          gap: 16px;
          min-height: 0;
          overflow: hidden;
        }
        .task-tree-panel__tree {
          flex: 2;
          padding: 12px;
          background: #1f2937;
          border: 2px dashed #374151;
          border-radius: 8px;
          overflow-y: auto;
        }
        .task-tree-panel__backlog {
          flex: 1;
          padding: 12px;
          background: #422006;
          border: 2px dashed #a16207;
          border-radius: 8px;
          overflow-y: auto;
        }
        .tree-label, .backlog-label {
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
          margin-bottom: 8px;
          padding-bottom: 6px;
          border-bottom: 1px solid #374151;
        }
        .tree-empty {
          font-size: 12px;
          color: #6b7280;
          text-align: center;
          padding: 20px;
        }
        .task-tree-panel__actions {
          flex-shrink: 0;
          display: flex;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #374151;
          align-items: center;
        }
        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          cursor: pointer;
          padding: 4px 8px;
          background: #0f172a;
          border-radius: 4px;
        }
        .checkbox-label:hover {
          background: #4b5563;
        }
        .checkbox-label input {
          cursor: pointer;
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
          background: #4b5563;
          cursor: not-allowed;
        }
        .btn-secondary {
          padding: 8px 16px;
          background: #111827;
          color: #e5e7eb;
          border: 1px solid #374151;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-secondary:hover {
          background: #0f172a;
        }
        .status-badge {
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
        }
        .status-badge--draft {
          background: #374151;
          color: #9ca3af;
        }
        .status-badge--confirmed {
          background: #422006;
          color: #fb923c;
        }
        .status-badge--generated {
          background: #14532d;
          color: #4ade80;
        }
        .panel--restart {
          background: #1e3a5f;
          border-color: #1e40af;
        }
        .panel--placeholder {
          color: #6b7280;
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
          color: #9ca3af;
        }
        .tree-list {
          font-family: monospace;
          font-size: 13px;
        }
        .tree-node {
          padding: 8px 12px;
          margin-bottom: 4px;
          background: #1f2937;
          border-radius: 4px;
          cursor: pointer;
          border-left: 3px solid transparent;
        }
        .tree-node:hover {
          background: #374151;
        }
        .tree-node--selected {
          background: #1e3a5f;
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
          color: #9ca3af;
        }
        .tree-node__stat {
          font-family: monospace;
        }
        .tree-node__changes {
          color: #28a745;
        }
        .tree-node__label {
          background: #374151;
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
          background: #422006;
        }
        .warning--error {
          background: #7f1d1d;
        }
        .detail-section {
          margin-bottom: 16px;
        }
        .detail-section h4 {
          margin: 0 0 8px;
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
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
          background: #0f172a;
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
          background: #374151;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        .restart-prompt {
          background: #111827;
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
          border: 1px solid #374151;
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
          background: #4b5563;
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
          background: #111827;
          border: 1px solid #374151;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
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
          background: #1f2937;
        }
        .chat-panel__empty {
          color: #6b7280;
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
          background: #111827;
          border: 1px solid #374151;
        }
        .chat-message--system {
          background: #fff3cd;
          border: 1px solid #ffc107;
          font-size: 12px;
        }
        .chat-message--loading {
          background: #4b5563;
          color: #9ca3af;
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
          border-top: 1px solid #374151;
          background: #111827;
          border-radius: 0 0 12px 12px;
        }
        .chat-panel__input textarea {
          flex: 1;
          padding: 10px 12px;
          border: 1px solid #374151;
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
          background: #4b5563;
          cursor: not-allowed;
        }
        .chat-panel__input button:hover:not(:disabled) {
          background: #5b4cdb;
        }
        .chat-panel__terminal-btn {
          font-size: 16px;
          margin-right: 4px;
        }
        .chat-panel__actions {
          display: flex;
          gap: 4px;
        }
        /* Planning Chat Loading */
        .planning-chat-loading,
        .planning-chat-placeholder {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: #9ca3af;
          font-size: 14px;
        }
        /* Terminal Panel */
        .terminal-panel {
          position: fixed;
          left: 20px;
          bottom: 20px;
          width: 700px;
          height: 450px;
          z-index: 1000;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
          border-radius: 8px;
          overflow: hidden;
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
          background: #111827;
          border-radius: 12px;
          width: 500px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        }
        .wizard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
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
          color: #9ca3af;
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
          color: #e5e7eb;
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
          background: #0f172a;
          border-radius: 6px;
        }
        .wizard-node__name {
          font-family: monospace;
          font-weight: 600;
        }
        .wizard-node__parent {
          font-size: 12px;
          color: #9ca3af;
        }
        .wizard-node__remove {
          margin-left: auto;
          background: #7f1d1d;
          color: #f87171;
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
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 14px;
        }
        .wizard-add-form select {
          padding: 8px 12px;
          border: 1px solid #374151;
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
          background: #4b5563;
          cursor: not-allowed;
        }
        .wizard-base-select {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #374151;
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
          background: #0f172a;
          border-radius: 8px;
          border-left: 4px solid #9e9e9e;
        }
        .wizard-task--todo {
          border-left-color: #9e9e9e;
        }
        .wizard-task--doing {
          border-left-color: #2196f3;
          background: #1e3a5f;
        }
        .wizard-task--done {
          border-left-color: #4caf50;
          background: #14532d;
        }
        .wizard-task__header {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .wizard-task__status {
          padding: 4px 8px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 12px;
          background: #111827;
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
          background: #4b5563;
          cursor: not-allowed;
        }
        .wizard-task__remove {
          background: #7f1d1d;
          color: #f87171;
          border: none;
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 14px;
        }
        .wizard-task__description {
          margin-top: 6px;
          font-size: 12px;
          color: #9ca3af;
          padding-left: 8px;
        }
        .wizard-task__meta {
          display: flex;
          gap: 12px;
          margin-top: 8px;
          font-size: 11px;
          color: #6b7280;
        }
        .wizard-task__parent {
          font-style: italic;
        }
        .wizard-task__branch {
          font-family: monospace;
          background: #374151;
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
          border: 1px solid #374151;
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
          background: #1f2937;
          border-radius: 8px;
          padding: 12px;
        }
        .tree-builder__backlog h3,
        .tree-builder__tree h3 {
          margin: 0 0 12px;
          font-size: 14px;
          color: #9ca3af;
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
          color: #6b7280;
          border: 2px dashed #374151;
          border-radius: 8px;
          font-size: 13px;
        }
        .tree-builder__add-form {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #374151;
        }
        .tree-builder__add-form input {
          flex: 1;
          padding: 8px 10px;
          border: 1px solid #374151;
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
          background: #4b5563;
          cursor: not-allowed;
        }
        .tree-builder__node {
          margin-bottom: 4px;
        }
        .tree-builder__children {
          border-left: 2px solid #374151;
          margin-left: 12px;
          padding-left: 8px;
        }

        /* Task Card styles */
        .task-card {
          background: #111827;
          border-radius: 8px;
          padding: 10px 12px;
          border-left: 4px solid #9e9e9e;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .task-card--todo {
          border-left-color: #9e9e9e;
        }
        .task-card--doing {
          border-left-color: #2196f3;
          background: #1e3a5f;
        }
        .task-card--done {
          border-left-color: #4caf50;
          background: #14532d;
        }
        .task-card--compact {
          padding: 6px 10px;
        }
        .task-card--dragging {
          background: #111827;
          padding: 10px 12px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          font-weight: 600;
        }
        .task-card__header {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .task-card__status {
          padding: 2px 6px;
          border: 1px solid #374151;
          border-radius: 4px;
          font-size: 11px;
          background: #111827;
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
          background: #4b5563;
        }
        .task-card__remove {
          background: #7f1d1d;
          color: #f87171;
          border: none;
          border-radius: 4px;
          padding: 2px 6px;
          cursor: pointer;
          font-size: 14px;
        }
        .task-card__description {
          margin-top: 6px;
          font-size: 12px;
          color: #9ca3af;
        }
        .task-card__meta {
          display: flex;
          gap: 8px;
          margin-top: 6px;
          font-size: 10px;
        }
        .task-card__branch {
          font-family: monospace;
          background: #374151;
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
        .task-card__claude {
          background: linear-gradient(135deg, #d97706 0%, #ea580c 100%);
          color: white;
          border: none;
          border-radius: 4px;
          padding: 3px 10px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 4px;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        }
        .task-card__claude:hover {
          background: linear-gradient(135deg, #b45309 0%, #c2410c 100%);
          transform: translateY(-1px);
          box-shadow: 0 2px 4px rgba(0,0,0,0.15);
        }
        .task-card__claude svg {
          flex-shrink: 0;
        }

        /* Generation logs */
        .generate-logs {
          margin: 12px 0;
          border: 1px solid #374151;
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
          color: #6b7280;
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
          color: #6b7280;
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
          border-top: 1px solid #374151;
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
          background: #422006;
          color: #fb923c;
        }
        .wizard-status--confirmed {
          background: #1e3a5f;
          color: #1565c0;
        }
        .wizard-status--generated {
          background: #14532d;
          color: #4ade80;
        }
        .wizard-locked-notice {
          background: #422006;
          color: #fb923c;
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 12px;
          text-align: center;
          margin-bottom: 12px;
        }
        .btn-secondary {
          padding: 10px 20px;
          background: #0f172a;
          color: #e5e7eb;
          border: 1px solid #374151;
          border-radius: 6px;
          cursor: pointer;
        }
        .btn-secondary:hover {
          background: #4b5563;
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
          background: #4b5563;
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
          background: #111827;
          border-radius: 12px;
          width: 500px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        }
        .modal__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
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
          color: #9ca3af;
        }
        .modal__content {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        .modal__loading {
          text-align: center;
          padding: 40px;
          color: #9ca3af;
        }
        .modal__error {
          color: #f87171;
          text-align: center;
          padding: 20px;
        }
        .modal__success {
          background: #14532d;
          color: #4ade80;
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
          border-top: 1px solid #374151;
        }
        .modal--small {
          width: 360px;
        }
        .modal--warnings {
          width: 600px;
          max-height: 80vh;
        }
        .modal__filters {
          display: flex;
          gap: 8px;
          padding: 16px 20px;
          border-bottom: 1px solid #374151;
        }
        .filter-btn {
          padding: 6px 12px;
          background: #1f2937;
          border: 1px solid #374151;
          border-radius: 4px;
          color: #9ca3af;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .filter-btn:hover {
          background: #374151;
          color: #e5e7eb;
        }
        .filter-btn--active {
          background: #3b82f6;
          border-color: #3b82f6;
          color: white;
        }
        .modal__content--scrollable {
          max-height: 400px;
          overflow-y: auto;
        }
        .modal__empty {
          padding: 40px 20px;
          text-align: center;
          color: #6b7280;
        }
        .warning-item {
          padding: 14px 20px;
          border-bottom: 1px solid #374151;
        }
        .warning-item:last-child {
          border-bottom: none;
        }
        .warning-item__header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }
        .warning-item__code {
          font-size: 13px;
          font-weight: 600;
          color: white;
          padding: 4px 12px;
          border-radius: 12px;
        }
        .warning-item__severity {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          padding: 3px 8px;
          border-radius: 4px;
        }
        .warning-item__severity--warn {
          background: #422006;
          color: #fbbf24;
        }
        .warning-item__severity--error {
          background: #450a0a;
          color: #f87171;
        }
        .warning-item__message {
          font-size: 14px;
          color: #e5e7eb;
          line-height: 1.5;
        }
        .modal__body {
          padding: 20px;
        }
        .btn-danger {
          background: #dc2626;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
        }
        .btn-danger:hover {
          background: #b91c1c;
        }

        /* Settings styles */
        .settings-section {
          margin-bottom: 20px;
        }
        .settings-section label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          color: #9ca3af;
          text-transform: uppercase;
          margin-bottom: 8px;
        }
        .settings-section input[type="text"] {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 14px;
        }
        .settings-section textarea {
          width: 100%;
          min-height: 80px;
          padding: 10px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 14px;
          font-family: inherit;
          resize: vertical;
        }
        .settings-section small {
          display: block;
          margin-top: 4px;
          font-size: 11px;
          color: #6b7280;
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
          background: #374151;
          border-radius: 4px;
          font-size: 12px;
        }
        .settings-example code {
          font-family: monospace;
        }
        .settings-example button {
          background: none;
          border: none;
          color: #f87171;
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
          border: 1px solid #374151;
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

        /* Terminal button in details panel */
        .btn-terminal {
          margin-top: 8px;
          padding: 8px 16px;
          background: #1a1b26;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
        }
        .btn-terminal:hover {
          background: #24283b;
        }

        .spinner {
          width: 24px;
          height: 24px;
          border: 3px solid #374151;
          border-top-color: #2196f3;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
