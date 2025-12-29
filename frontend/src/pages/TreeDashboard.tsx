import React, { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type Plan,
  type ScanSnapshot,
  type TreeNode,
  type RepoPin,
  type AgentSession,
  type AgentOutputData,
  type ChatSession,
  type ChatMessage,
  type TreeSpecNode,
  type TreeSpecEdge,
  type TaskStatus,
} from "../lib/api";
import { wsClient } from "../lib/ws";

interface OutputLine {
  stream: "stdout" | "stderr";
  data: string;
  timestamp: string;
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

  // Agent state
  const [runningAgent, setRunningAgent] = useState<AgentSession | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentOutput, setAgentOutput] = useState<OutputLine[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);

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

  // Load agent status on mount
  useEffect(() => {
    api.aiStatus().then(({ agents }) => {
      if (agents.length > 0) {
        setRunningAgent(agents[0]);
        setShowConsole(true);
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

    const unsubAgentStarted = wsClient.on("agent.started", (msg) => {
      const data = msg.data as { sessionId: string; pid: number; startedAt: string; localPath: string; branch?: string };
      setRunningAgent({
        id: data.sessionId,
        repoId: snapshot.repoId,
        worktreePath: data.localPath,
        branch: data.branch ?? null,
        status: "running",
        pid: data.pid,
        startedAt: data.startedAt,
        lastSeenAt: data.startedAt,
        endedAt: null,
        exitCode: null,
      });
      setShowConsole(true);
    });

    const unsubAgentOutput = wsClient.on("agent.output", (msg) => {
      const data = msg.data as AgentOutputData;
      setAgentOutput((prev) => [...prev, {
        stream: data.stream,
        data: data.data,
        timestamp: data.timestamp,
      }]);
      // Auto-scroll console
      setTimeout(() => {
        if (consoleRef.current) {
          consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
        }
      }, 10);
    });

    const unsubAgentFinished = wsClient.on("agent.finished", (msg) => {
      const data = msg.data as { exitCode?: number; finishedAt: string };
      setRunningAgent((prev) => prev ? {
        ...prev,
        status: "exited",
        endedAt: data.finishedAt,
        exitCode: data.exitCode ?? null,
      } : null);
      // Auto-rescan when agent finishes
      if (selectedPin) {
        handleScan(selectedPin.localPath);
      }
    });

    const unsubAgentStopped = wsClient.on("agent.stopped", (msg) => {
      const data = msg.data as { stoppedAt: string };
      setRunningAgent((prev) => prev ? {
        ...prev,
        status: "stopped",
        endedAt: data.stoppedAt,
      } : null);
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
      unsubAgentStarted();
      unsubAgentOutput();
      unsubAgentFinished();
      unsubAgentStopped();
      unsubChatMessage();
    };
  }, [snapshot?.repoId, selectedPin?.localPath]);

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

  const handleRunClaude = async () => {
    if (!selectedPin) return;
    setAgentLoading(true);
    setError(null);
    setAgentOutput([]); // Clear previous output
    try {
      const result = await api.aiStart(selectedPin.localPath, plan?.id);
      setRunningAgent({
        id: result.sessionId,
        repoId: result.repoId,
        worktreePath: result.localPath,
        branch: result.branch ?? null,
        status: "running",
        pid: result.pid,
        startedAt: result.startedAt,
        lastSeenAt: result.startedAt,
        endedAt: null,
        exitCode: null,
      });
      setShowConsole(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAgentLoading(false);
    }
  };

  const handleStopClaude = async () => {
    if (!runningAgent?.pid) return;
    setAgentLoading(true);
    try {
      await api.aiStop(runningAgent.pid);
      setRunningAgent((prev) => prev ? { ...prev, status: "stopped" } : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAgentLoading(false);
    }
  };

  const handleClearConsole = () => {
    setAgentOutput([]);
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

  const handleSaveTreeSpec = async () => {
    if (!snapshot?.repoId) return;
    setLoading(true);
    setError(null);
    try {
      await api.updateTreeSpec({
        repoId: snapshot.repoId,
        baseBranch: wizardBaseBranch,
        nodes: wizardNodes,
        edges: wizardEdges,
      });
      setShowTreeWizard(false);
      // Rescan to update the view
      if (selectedPin) {
        await handleScan(selectedPin.localPath);
      }
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

  const getNodeChildren = (branchName: string): TreeNode[] => {
    if (!snapshot) return [];
    const childNames = snapshot.edges
      .filter((e) => e.parent === branchName)
      .map((e) => e.child);
    return snapshot.nodes.filter((n) => childNames.includes(n.branchName));
  };

  const renderNode = (node: TreeNode, depth: number = 0): React.ReactElement => {
    const children = getNodeChildren(node.branchName);
    const isSelected = selectedNode?.branchName === node.branchName;
    const edge = snapshot?.edges.find((e) => e.child === node.branchName);

    return (
      <div key={node.branchName}>
        <div
          className={`tree-node ${isSelected ? "tree-node--selected" : ""} ${
            node.worktree?.isActive ? "tree-node--active" : ""
          }`}
          style={{ marginLeft: depth * 24 }}
          onClick={() => setSelectedNode(node)}
        >
          <div className="tree-node__header">
            <span className="tree-node__name">{node.branchName}</span>
            {edge?.isDesigned && (
              <span className="tree-node__badge tree-node__badge--designed">
                設計
              </span>
            )}
            {node.worktree?.isActive && (
              <span className="tree-node__badge tree-node__badge--agent">
                {node.worktree.activeAgent || "active"}
              </span>
            )}
            {node.worktree?.dirty && (
              <span className="tree-node__badge tree-node__badge--dirty">
                dirty
              </span>
            )}
            {node.pr && (
              <span
                className={`tree-node__badge tree-node__badge--pr tree-node__badge--${node.pr.state}`}
              >
                PR#{node.pr.number}
              </span>
            )}
            {node.pr?.isDraft && (
              <span className="tree-node__badge tree-node__badge--draft">
                draft
              </span>
            )}
            {node.pr?.reviewDecision && (
              <span
                className={`tree-node__badge tree-node__badge--review tree-node__badge--${node.pr.reviewDecision.toLowerCase()}`}
              >
                {node.pr.reviewDecision === "APPROVED"
                  ? "✓"
                  : node.pr.reviewDecision === "CHANGES_REQUESTED"
                  ? "✗"
                  : "○"}
              </span>
            )}
            {node.pr?.checks && (
              <span
                className={`tree-node__badge tree-node__badge--ci tree-node__badge--${node.pr.checks.toLowerCase()}`}
              >
                CI
              </span>
            )}
          </div>
          <div className="tree-node__meta">
            {node.aheadBehind && (
              <span className="tree-node__stat">
                ↑{node.aheadBehind.ahead} ↓{node.aheadBehind.behind}
              </span>
            )}
            {node.pr && (
              <span className="tree-node__changes">
                +{node.pr.additions || 0} -{node.pr.deletions || 0}
              </span>
            )}
            {node.pr?.labels?.map((label) => (
              <span key={label} className="tree-node__label">
                {label}
              </span>
            ))}
            {node.worktree && (
              <button
                className="btn-chat-small"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenChat(node.worktree!.path);
                }}
              >
                Chat
              </button>
            )}
          </div>
        </div>
        {children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  // Find root nodes (no parent or parent is default branch)
  const getRootNodes = (): TreeNode[] => {
    if (!snapshot) return [];
    const childBranches = new Set(snapshot.edges.map((e) => e.child));
    return snapshot.nodes.filter(
      (n) =>
        !childBranches.has(n.branchName) ||
        n.branchName === snapshot.defaultBranch
    );
  };

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <h1>Vibe Tree</h1>
        <div className="dashboard__nav">
          {snapshot?.repoId && (
            <>
              <span className="dashboard__repo">{snapshot.repoId}</span>
              <Link to={`/settings?repoId=${encodeURIComponent(snapshot.repoId)}`}>Settings</Link>
            </>
          )}
        </div>
      </header>

      {error && <div className="dashboard__error">{error}</div>}

      {/* Repo Selector */}
      <div className="dashboard__controls">
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
                {pin.label || pin.repoId} ({pin.localPath})
              </option>
            ))}
            <option value="new">+ Add new repo...</option>
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

        {showAddNew && (
          <div className="add-repo-form">
            <input
              type="text"
              placeholder="Local path (e.g., ~/projects/my-repo)"
              value={newLocalPath}
              onChange={(e) => setNewLocalPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddRepoPin()}
            />
            <button onClick={handleAddRepoPin}>Add</button>
            <button onClick={() => setShowAddNew(false)}>Cancel</button>
          </div>
        )}

        <button
          onClick={() => selectedPin && handleScan(selectedPin.localPath)}
          disabled={loading || !selectedPin}
        >
          {loading ? "Scanning..." : "Scan"}
        </button>

        {/* Claude Agent Controls */}
        {selectedPin && (
          <div className="agent-controls">
            {runningAgent?.status === "running" ? (
              <button
                className="btn-stop"
                onClick={handleStopClaude}
                disabled={agentLoading}
              >
                {agentLoading ? "Stopping..." : "Stop Claude"}
              </button>
            ) : (
              <button
                className="btn-run"
                onClick={handleRunClaude}
                disabled={agentLoading || !snapshot}
              >
                {agentLoading ? "Starting..." : "Run Claude"}
              </button>
            )}
            {runningAgent && (
              <span className={`agent-status agent-status--${runningAgent.status}`}>
                {runningAgent.status === "running" && `Running (PID: ${runningAgent.pid})`}
                {runningAgent.status === "stopped" && "Stopped"}
                {runningAgent.status === "exited" && `Exited (code: ${runningAgent.exitCode ?? "?"})`}
              </span>
            )}
            <button
              className="btn-console"
              onClick={() => setShowConsole(!showConsole)}
            >
              {showConsole ? "Hide Console" : "Show Console"}
            </button>
          </div>
        )}

        {plan && (
          <span className="dashboard__plan">
            Plan: <strong>{plan.title}</strong>
            {plan.githubIssueUrl && (
              <a href={plan.githubIssueUrl} target="_blank" rel="noopener noreferrer">
                (Issue)
              </a>
            )}
          </span>
        )}
      </div>

      {/* Agent Console */}
      {showConsole && (
        <div className="agent-console">
          <div className="agent-console__header">
            <h3>Agent Console</h3>
            <div className="agent-console__actions">
              <button onClick={handleClearConsole}>Clear</button>
              <button onClick={() => setShowConsole(false)}>×</button>
            </div>
          </div>
          <div className="agent-console__output" ref={consoleRef}>
            {agentOutput.length === 0 ? (
              <div className="agent-console__empty">
                {runningAgent?.status === "running"
                  ? "Waiting for output..."
                  : "No output yet. Click \"Run Claude\" to start."}
              </div>
            ) : (
              agentOutput.map((line, i) => (
                <div
                  key={i}
                  className={`agent-console__line agent-console__line--${line.stream}`}
                >
                  {line.data}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Chat Panel */}
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

      {/* Main Content */}
      {snapshot && (
        <div className="dashboard__main">
          {/* Left: Tree */}
          <div className="dashboard__tree">
            <div className="panel">
              <div className="panel__header">
                <h3>Branch Tree</h3>
                <div className="panel__header-actions">
                  <button className="btn-wizard" onClick={handleOpenTreeWizard}>
                    Edit Design Tree
                  </button>
                  <span className="panel__count">{snapshot.nodes.length} branches</span>
                </div>
              </div>
              <div className="tree-list">
                {getRootNodes()
                  .sort((a, b) => {
                    // Default branch comes first
                    if (a.branchName === snapshot.defaultBranch) return -1;
                    if (b.branchName === snapshot.defaultBranch) return 1;
                    return 0;
                  })
                  .map((node) => renderNode(node))}
              </div>
            </div>

            {/* Warnings */}
            {snapshot.warnings.length > 0 && (
              <div className="panel panel--warnings">
                <div className="panel__header">
                  <h3>Warnings ({snapshot.warnings.length})</h3>
                </div>
                {snapshot.warnings.map((w, i) => (
                  <div
                    key={i}
                    className={`warning warning--${w.severity}`}
                  >
                    <strong>[{w.code}]</strong> {w.message}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: Details */}
          <div className="dashboard__details">
            {selectedNode ? (
              <div className="panel">
                <div className="panel__header">
                  <h3>{selectedNode.branchName}</h3>
                </div>

                {/* PR Info */}
                {selectedNode.pr && (
                  <div className="detail-section">
                    <h4>Pull Request</h4>
                    <a
                      href={selectedNode.pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      #{selectedNode.pr.number}: {selectedNode.pr.title}
                    </a>
                    <div className="detail-row">
                      <span>State: {selectedNode.pr.state}</span>
                      {selectedNode.pr.isDraft && <span>(Draft)</span>}
                    </div>
                    {selectedNode.pr.reviewDecision && (
                      <div className="detail-row">
                        Review: {selectedNode.pr.reviewDecision}
                      </div>
                    )}
                    {selectedNode.pr.checks && (
                      <div className="detail-row">CI: {selectedNode.pr.checks}</div>
                    )}
                    <div className="detail-row">
                      +{selectedNode.pr.additions} -{selectedNode.pr.deletions} (
                      {selectedNode.pr.changedFiles} files)
                    </div>
                    {selectedNode.pr.assignees && selectedNode.pr.assignees.length > 0 && (
                      <div className="detail-row">
                        Assignees: {selectedNode.pr.assignees.join(", ")}
                      </div>
                    )}
                    {selectedNode.pr.labels && selectedNode.pr.labels.length > 0 && (
                      <div className="detail-row">
                        Labels: {selectedNode.pr.labels.join(", ")}
                      </div>
                    )}
                  </div>
                )}

                {/* Worktree Info */}
                {selectedNode.worktree && (
                  <div className="detail-section">
                    <h4>Worktree</h4>
                    <code>{selectedNode.worktree.path}</code>
                    {selectedNode.worktree.isActive && (
                      <div className="detail-row">
                        Active: {selectedNode.worktree.activeAgent || "yes"}
                      </div>
                    )}
                    {selectedNode.worktree.dirty && (
                      <div className="detail-row warning--warn">Uncommitted changes</div>
                    )}
                  </div>
                )}

                {/* Ahead/Behind */}
                {selectedNode.aheadBehind && (
                  <div className="detail-section">
                    <h4>Status</h4>
                    <div className="detail-row">
                      Ahead: {selectedNode.aheadBehind.ahead}, Behind:{" "}
                      {selectedNode.aheadBehind.behind}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="panel panel--placeholder">
                <p>Select a branch to see details</p>
              </div>
            )}

            {/* Restart Panel */}
            {snapshot.restart && (
              <div className="panel panel--restart">
                <div className="panel__header">
                  <h3>Restart Session</h3>
                </div>
                <div className="detail-section">
                  <label>Terminal Command:</label>
                  <div className="copy-row">
                    <code>{snapshot.restart.cdCommand}</code>
                    <button
                      onClick={() =>
                        copyToClipboard(snapshot.restart!.cdCommand, "cd")
                      }
                    >
                      {copied === "cd" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
                <div className="detail-section">
                  <label>Restart Prompt:</label>
                  <pre className="restart-prompt">
                    {snapshot.restart.restartPromptMd}
                  </pre>
                  <button
                    onClick={() =>
                      copyToClipboard(snapshot.restart!.restartPromptMd, "prompt")
                    }
                  >
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

      <style>{`
        .dashboard {
          min-height: 100vh;
          background: #f5f5f5;
        }
        .dashboard__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 24px;
          background: white;
          border-bottom: 1px solid #ddd;
        }
        .dashboard__header h1 {
          margin: 0;
          font-size: 20px;
        }
        .dashboard__nav {
          display: flex;
          align-items: center;
          gap: 16px;
        }
        .dashboard__nav a {
          color: #0066cc;
          text-decoration: none;
        }
        .dashboard__repo {
          font-family: monospace;
          font-size: 14px;
          color: #666;
          background: #f0f0f0;
          padding: 4px 8px;
          border-radius: 4px;
        }
        .dashboard__error {
          background: #fee;
          color: #c00;
          padding: 12px 24px;
          border-bottom: 1px solid #fcc;
        }
        .dashboard__controls {
          display: flex;
          gap: 12px;
          padding: 16px 24px;
          background: white;
          border-bottom: 1px solid #ddd;
          align-items: center;
          flex-wrap: wrap;
        }
        .repo-selector {
          display: flex;
          gap: 4px;
          align-items: center;
        }
        .repo-selector select {
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 14px;
          min-width: 300px;
        }
        .add-repo-form {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .add-repo-form input {
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 14px;
          width: 300px;
        }
        .btn-delete {
          padding: 4px 8px;
          background: #fee;
          color: #c00;
          border: 1px solid #fcc;
          border-radius: 4px;
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
        }
        .agent-controls {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-left: 12px;
          padding-left: 12px;
          border-left: 1px solid #ddd;
        }
        .btn-run {
          padding: 8px 16px;
          background: #28a745;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .btn-run:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .btn-stop {
          padding: 8px 16px;
          background: #dc3545;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .btn-stop:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .btn-console {
          padding: 8px 12px;
          background: #6c757d;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .agent-status {
          font-size: 13px;
          font-weight: 500;
          padding: 4px 8px;
          border-radius: 4px;
        }
        .agent-status--running {
          color: #28a745;
          background: #e8f5e9;
        }
        .agent-status--stopped {
          color: #f57c00;
          background: #fff3e0;
        }
        .agent-status--exited {
          color: #666;
          background: #f5f5f5;
        }
        .dashboard__controls button {
          padding: 8px 16px;
          background: #0066cc;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .dashboard__controls button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .dashboard__plan {
          margin-left: auto;
          font-size: 14px;
          color: #666;
        }
        .dashboard__plan a {
          margin-left: 8px;
          color: #0066cc;
        }
        .agent-console {
          background: #1e1e1e;
          border-bottom: 1px solid #333;
        }
        .agent-console__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 16px;
          background: #2d2d2d;
          border-bottom: 1px solid #444;
        }
        .agent-console__header h3 {
          margin: 0;
          color: #ccc;
          font-size: 13px;
          font-weight: 500;
        }
        .agent-console__actions {
          display: flex;
          gap: 8px;
        }
        .agent-console__actions button {
          padding: 4px 8px;
          background: #444;
          color: #ccc;
          border: none;
          border-radius: 3px;
          cursor: pointer;
          font-size: 12px;
        }
        .agent-console__actions button:hover {
          background: #555;
        }
        .agent-console__output {
          padding: 12px 16px;
          max-height: 300px;
          overflow-y: auto;
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 12px;
          line-height: 1.5;
        }
        .agent-console__empty {
          color: #666;
          font-style: italic;
        }
        .agent-console__line {
          white-space: pre-wrap;
          word-break: break-all;
        }
        .agent-console__line--stdout {
          color: #e0e0e0;
        }
        .agent-console__line--stderr {
          color: #f44336;
        }
        .dashboard__main {
          display: grid;
          grid-template-columns: 1fr 400px;
          gap: 20px;
          padding: 20px 24px;
          max-width: 1600px;
          margin: 0 auto;
        }
        .dashboard__tree {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .dashboard__details {
          display: flex;
          flex-direction: column;
          gap: 16px;
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
      `}</style>
    </div>
  );
}
