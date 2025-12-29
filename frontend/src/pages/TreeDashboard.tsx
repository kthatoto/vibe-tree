import { useState, useEffect, useCallback, useRef } from "react";
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
  type BranchNamingRule,
} from "../lib/api";
import { wsClient } from "../lib/ws";
import BranchGraph from "../components/BranchGraph";

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

  // Tree Spec wizard state (Task-based)
  const [showTreeWizard, setShowTreeWizard] = useState(false);
  const [wizardBaseBranch, setWizardBaseBranch] = useState<string>("main");
  const [wizardNodes, setWizardNodes] = useState<TreeSpecNode[]>([]);
  const [wizardEdges, setWizardEdges] = useState<TreeSpecEdge[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [newTaskParent, setNewTaskParent] = useState("");

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [settingsRule, setSettingsRule] = useState<BranchNamingRule | null>(null);
  const [settingsPattern, setSettingsPattern] = useState("");
  const [settingsDescription, setSettingsDescription] = useState("");
  const [settingsExamples, setSettingsExamples] = useState<string[]>([]);
  const [settingsNewExample, setSettingsNewExample] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Load repo pins on mount
  useEffect(() => {
    api.getRepoPins().then((pins) => {
      setRepoPins(pins);
      // Auto-select the most recently used one
      if (pins.length > 0 && !selectedPinId) {
        setSelectedPinId(pins[0].id);
      }
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

  // Tree Spec wizard functions (Task-based)
  const handleOpenTreeWizard = () => {
    // Initialize with existing tree spec if available
    if (snapshot?.treeSpec) {
      setWizardBaseBranch(snapshot.treeSpec.baseBranch);
      setWizardNodes(snapshot.treeSpec.specJson.nodes);
      setWizardEdges(snapshot.treeSpec.specJson.edges);
    } else {
      // Start fresh with detected default branch
      const baseBranch = snapshot?.defaultBranch ?? "main";
      setWizardBaseBranch(baseBranch);
      setWizardNodes([]);
      setWizardEdges([]);
    }
    setShowTreeWizard(true);
  };

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

  const handleRemoveWizardTask = (taskId: string) => {
    setWizardNodes((prev) => prev.filter((n) => n.id !== taskId));
    setWizardEdges((prev) => prev.filter((e) => e.parent !== taskId && e.child !== taskId));
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
      setShowTreeWizard(false);
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

  return (
    <div className="dashboard dashboard--with-sidebar">
      {/* Left Sidebar */}
      <aside className="sidebar">
        <div className="sidebar__header">
          <h1>Vibe Tree</h1>
        </div>

        {/* Repo Selection */}
        <div className="sidebar__section">
          <h3>Repository</h3>
          <div className="repo-selector">
            <select
              value={selectedPinId ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "new") {
                  setShowAddNew(true);
                } else if (val) {
                  handleSelectPin(Number(val));
                }
              }}
            >
              <option value="">Select a repo...</option>
              {repoPins.map((pin) => (
                <option key={pin.id} value={pin.id}>
                  {pin.label || pin.repoId}
                </option>
              ))}
              <option value="new">+ Add new...</option>
            </select>
            {selectedPin && (
              <button
                className="btn-delete"
                onClick={() => handleDeletePin(selectedPin.id)}
                title="Remove from list"
              >
                ×
              </button>
            )}
          </div>
          {selectedPin && (
            <div className="sidebar__path">{selectedPin.localPath}</div>
          )}

          {showAddNew && (
            <div className="add-repo-form">
              <input
                type="text"
                placeholder="Local path..."
                value={newLocalPath}
                onChange={(e) => setNewLocalPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddRepoPin()}
              />
              <div className="add-repo-form__buttons">
                <button onClick={handleAddRepoPin}>Add</button>
                <button onClick={() => setShowAddNew(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="sidebar__section">
          <button
            className="sidebar__btn sidebar__btn--primary"
            onClick={() => selectedPin && handleScan(selectedPin.localPath)}
            disabled={loading || !selectedPin}
          >
            {loading ? "Scanning..." : "Scan"}
          </button>
          {snapshot && (
            <button
              className="sidebar__btn"
              onClick={handleOpenSettings}
            >
              Settings
            </button>
          )}
        </div>

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
                    <button className="btn-wizard" onClick={handleOpenTreeWizard}>
                      Edit Task Tree
                    </button>
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

      {/* Task Tree Wizard Modal */}
      {showTreeWizard && (
        <div className="wizard-overlay">
          <div className="wizard-modal">
            <div className="wizard-header">
              <h2>Task Strategy Tree</h2>
              <button onClick={() => setShowTreeWizard(false)}>×</button>
            </div>
            <div className="wizard-content">
              {/* Base Branch Selection */}
              <div className="wizard-section">
                <h3>Base Branch</h3>
                <select
                  value={wizardBaseBranch}
                  onChange={(e) => setWizardBaseBranch(e.target.value)}
                  className="wizard-base-select"
                >
                  {snapshot?.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </div>

              {/* Task List */}
              <div className="wizard-section">
                <h3>Tasks ({wizardNodes.length})</h3>
                <div className="wizard-tasks">
                  {wizardNodes.map((task) => {
                    const parentEdge = wizardEdges.find((e) => e.child === task.id);
                    const parentTask = parentEdge
                      ? wizardNodes.find((n) => n.id === parentEdge.parent)
                      : null;
                    return (
                      <div key={task.id} className={`wizard-task wizard-task--${task.status}`}>
                        <div className="wizard-task__header">
                          <select
                            value={task.status}
                            onChange={(e) => handleUpdateTaskStatus(task.id, e.target.value as TaskStatus)}
                            className="wizard-task__status"
                          >
                            <option value="todo">Todo</option>
                            <option value="doing">Doing</option>
                            <option value="done">Done</option>
                          </select>
                          <span className="wizard-task__title">{task.title}</span>
                          {!task.branchName && task.status === "todo" && (
                            <button
                              className="wizard-task__start"
                              onClick={() => handleStartTask(task.id)}
                              disabled={loading}
                            >
                              Start
                            </button>
                          )}
                          <button
                            className="wizard-task__remove"
                            onClick={() => handleRemoveWizardTask(task.id)}
                          >
                            ×
                          </button>
                        </div>
                        {task.description && (
                          <div className="wizard-task__description">{task.description}</div>
                        )}
                        <div className="wizard-task__meta">
                          {parentTask && (
                            <span className="wizard-task__parent">depends on: {parentTask.title}</span>
                          )}
                          {task.branchName && (
                            <span className="wizard-task__branch">branch: {task.branchName}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {wizardNodes.length === 0 && (
                    <div className="wizard-empty">No tasks yet. Add one below.</div>
                  )}
                </div>
              </div>

              {/* Add Task Form */}
              <div className="wizard-section">
                <h3>Add Task</h3>
                <div className="wizard-add-form wizard-add-form--vertical">
                  <input
                    type="text"
                    placeholder="Task title"
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Description (optional)"
                    value={newTaskDescription}
                    onChange={(e) => setNewTaskDescription(e.target.value)}
                  />
                  <div className="wizard-add-row">
                    <select
                      value={newTaskParent}
                      onChange={(e) => setNewTaskParent(e.target.value)}
                    >
                      <option value="">No dependency (root task)</option>
                      {wizardNodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.title}
                        </option>
                      ))}
                    </select>
                    <button onClick={handleAddWizardTask} disabled={!newTaskTitle.trim()}>
                      Add Task
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="wizard-footer">
              <button className="btn-secondary" onClick={() => setShowTreeWizard(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleSaveTreeSpec} disabled={loading}>
                {loading ? "Saving..." : "Save Task Tree"}
              </button>
            </div>
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
          justify-content: flex-end;
          gap: 12px;
          padding: 16px 20px;
          border-top: 1px solid #e0e0e0;
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
