import { useState, useEffect, useCallback, useRef } from "react";
import { api, type TaskInstruction, type ChatMessage, type TreeNode } from "../lib/api";
import {
  extractInstructionEdit,
  removeInstructionEditTags,
  computeSimpleDiff,
  type DiffLine,
} from "../lib/instruction-parser";
import "./TaskDetailPanel.css";

interface TaskDetailPanelProps {
  repoId: string;
  localPath: string;
  branchName: string;
  node: TreeNode | null;
  defaultBranch?: string;
  onClose: () => void;
  onWorktreeCreated?: () => void;
}

export function TaskDetailPanel({
  repoId,
  localPath,
  branchName,
  node,
  defaultBranch,
  onClose,
  onWorktreeCreated,
}: TaskDetailPanelProps) {
  const isDefaultBranch = branchName === defaultBranch;
  const [instruction, setInstruction] = useState<TaskInstruction | null>(null);
  const [editingInstruction, setEditingInstruction] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chat state
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMode, setChatMode] = useState<"execution" | "planning">("planning");
  const [committedEdits, setCommittedEdits] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Worktree state
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const worktreePath = node?.worktree?.path;

  // Resizable instruction section
  const DEFAULT_INSTRUCTION_HEIGHT = 120;
  const [instructionHeight, setInstructionHeight] = useState(DEFAULT_INSTRUCTION_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);

  // Checkout state - track if we checked out to this branch
  const [checkedOut, setCheckedOut] = useState(false);

  // The working path is either the worktree path or localPath if checked out
  const workingPath = worktreePath || (checkedOut ? localPath : null);

  // Planning mode can work without workingPath (uses localPath), Execution requires workingPath
  const canSendMessage = chatMode === "planning" || !!workingPath;
  const effectivePath = workingPath || localPath; // For Planning mode, use localPath as fallback

  // Load task instruction
  useEffect(() => {
    const loadInstruction = async () => {
      setLoading(true);
      setError(null);
      try {
        const instr = await api.getTaskInstruction(repoId, branchName);
        setInstruction(instr);
        setInstructionDraft(instr.instructionMd);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };
    loadInstruction();
  }, [repoId, branchName]);

  // Load existing chat session for this branch (always, even without workingPath)
  useEffect(() => {
    const initChat = async () => {
      try {
        // Get existing sessions for this repo
        const sessions = await api.getChatSessions(repoId);
        // Find session by branchName (primary) or effectivePath (fallback)
        const existing = sessions.find(
          (s) => s.branchName === branchName && s.status === "active"
        ) || sessions.find(
          (s) => s.worktreePath === effectivePath && s.status === "active"
        );

        if (existing) {
          setChatSessionId(existing.id);
          const msgs = await api.getChatMessages(existing.id);
          setMessages(msgs);
        } else {
          // Create new session using effectivePath (always available)
          const newSession = await api.createChatSession(repoId, effectivePath);
          setChatSessionId(newSession.id);
          setMessages([]);
        }
      } catch (err) {
        console.error("Failed to init chat:", err);
      }
    };
    initChat();
  }, [repoId, effectivePath, branchName]);

  // Track if we should auto-scroll (only for new messages, not initial load)
  const shouldAutoScroll = useRef(false);

  // Scroll to bottom only when a new message is added (not initial load)
  useEffect(() => {
    if (shouldAutoScroll.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Handle resize drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = instructionHeight;
  }, [instructionHeight]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - resizeStartY.current;
      // Min 20px, no max limit (will be constrained by container)
      const newHeight = Math.max(20, resizeStartHeight.current + delta);
      setInstructionHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  const handleSaveInstruction = async () => {
    if (!instructionDraft.trim()) return;
    try {
      const updated = await api.updateTaskInstruction(repoId, branchName, instructionDraft);
      setInstruction(updated);
      setEditingInstruction(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCreateWorktree = async () => {
    setCreatingWorktree(true);
    setError(null);
    try {
      await api.createWorktree(localPath, branchName);
      onWorktreeCreated?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingWorktree(false);
    }
  };

  const [checkingOut, setCheckingOut] = useState(false);

  const handleCheckout = async () => {
    setCheckingOut(true);
    setError(null);
    try {
      await api.checkout(localPath, branchName);
      setCheckedOut(true); // Enable chat section
      onWorktreeCreated?.(); // Rescan to update
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCheckingOut(false);
    }
  };

  const handleCommitInstructionEdit = async (messageId: number, newContent: string) => {
    try {
      const updated = await api.updateTaskInstruction(repoId, branchName, newContent);
      setInstruction(updated);
      setCommittedEdits((prev) => new Set(prev).add(messageId));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSendMessage = useCallback(async () => {
    if (!chatSessionId || !chatInput.trim() || chatLoading) return;
    const userMessage = chatInput.trim();
    setChatInput("");
    setChatLoading(true);
    shouldAutoScroll.current = true; // Enable auto-scroll for new messages

    // Optimistically add user message
    const tempUserMsg: ChatMessage = {
      id: Date.now(),
      sessionId: chatSessionId,
      role: "user",
      content: userMessage,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      // Include task instruction as context
      const context = instruction?.instructionMd
        ? `[Task Instruction]\n${instruction.instructionMd}\n\n[Mode: ${chatMode}]`
        : `[Mode: ${chatMode}]`;
      const { assistantMessage } = await api.sendChatMessage(chatSessionId, userMessage, context);
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChatLoading(false);
    }
  }, [chatSessionId, chatInput, chatLoading, instruction, chatMode]);

  if (loading && !isDefaultBranch) {
    return (
      <div className="task-detail-panel">
        <div className="task-detail-panel__header">
          <h3>{branchName}</h3>
          <button onClick={onClose} className="task-detail-panel__close">x</button>
        </div>
        <div className="task-detail-panel__loading">Loading...</div>
      </div>
    );
  }

  // Default branch: show simplified view without Planning/Execution
  if (isDefaultBranch) {
    return (
      <div className="task-detail-panel">
        <div className="task-detail-panel__header">
          <h3>{branchName}</h3>
          <button onClick={onClose} className="task-detail-panel__close">x</button>
        </div>
        <div className="task-detail-panel__default-branch">
          <span className="task-detail-panel__default-branch-badge">Default Branch</span>
          <p>This is the default branch. Task planning and execution are not available here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="task-detail-panel">
      <div className="task-detail-panel__header">
        <h3>{branchName}</h3>
        <button onClick={onClose} className="task-detail-panel__close">x</button>
      </div>

      {error && <div className="task-detail-panel__error">{error}</div>}

      {/* Working Path Section */}
      <div className="task-detail-panel__worktree-section">
        {worktreePath ? (
          <div className="task-detail-panel__worktree-info">
            <span className="task-detail-panel__worktree-badge">Active</span>
          </div>
        ) : checkedOut ? (
          <div className="task-detail-panel__worktree-info">
            <span className="task-detail-panel__worktree-badge task-detail-panel__worktree-badge--checkout">Checked Out</span>
          </div>
        ) : (
          <div className="task-detail-panel__branch-actions">
            <button
              className="task-detail-panel__checkout-btn"
              onClick={handleCheckout}
              disabled={checkingOut || creatingWorktree}
            >
              {checkingOut ? "Checking out..." : "Checkout"}
            </button>
            <button
              className="task-detail-panel__create-worktree-btn"
              onClick={handleCreateWorktree}
              disabled={creatingWorktree || checkingOut}
            >
              {creatingWorktree ? "Creating..." : "Create Worktree"}
            </button>
          </div>
        )}
      </div>

      {/* Instruction Section */}
      <div className="task-detail-panel__instruction-section">
        <div className="task-detail-panel__instruction-header">
          <h4>Task Instruction</h4>
          {!editingInstruction ? (
            <button
              className="task-detail-panel__edit-btn"
              onClick={() => {
                setInstructionDraft(instruction?.instructionMd || "");
                setEditingInstruction(true);
              }}
            >
              Edit
            </button>
          ) : (
            <div className="task-detail-panel__instruction-actions">
              <button onClick={handleSaveInstruction}>Save</button>
              <button onClick={() => {
                setEditingInstruction(false);
                setInstructionDraft(instruction?.instructionMd || "");
              }}>Cancel</button>
            </div>
          )}
        </div>
        <div
          className="task-detail-panel__instruction-content"
          style={{ height: instructionHeight }}
        >
          <textarea
            className="task-detail-panel__instruction-textarea"
            value={editingInstruction ? instructionDraft : (instruction?.instructionMd || "")}
            onChange={(e) => setInstructionDraft(e.target.value)}
            readOnly={!editingInstruction}
            placeholder="No instructions yet..."
          />
        </div>
      </div>

      {/* Resize Handle */}
      <div
        className={`task-detail-panel__resize-handle ${isResizing ? "task-detail-panel__resize-handle--active" : ""}`}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setInstructionHeight(DEFAULT_INSTRUCTION_HEIGHT)}
      >
        <div className="task-detail-panel__resize-bar" />
      </div>

      {/* Chat Section - Always show */}
      <div className="task-detail-panel__chat-section">
        <div className="task-detail-panel__chat-header">
          <h4>Chat</h4>
          <div className="task-detail-panel__chat-mode-toggle">
            <button
              className={`task-detail-panel__mode-btn ${chatMode === "planning" ? "task-detail-panel__mode-btn--active" : ""}`}
              onClick={() => setChatMode("planning")}
            >
              Planning
            </button>
            <button
              className={`task-detail-panel__mode-btn ${chatMode === "execution" ? "task-detail-panel__mode-btn--active" : ""} ${!workingPath ? "task-detail-panel__mode-btn--locked" : ""}`}
              onClick={() => setChatMode("execution")}
              disabled={!workingPath}
              title={!workingPath ? "Checkout or create worktree to use Execution mode" : ""}
            >
              Execution
            </button>
          </div>
        </div>
          <div className="task-detail-panel__messages">
            {messages.length === 0 && (
              <div className="task-detail-panel__no-messages">
                Start a conversation to refine this task or get implementation help.
              </div>
            )}
            {messages.map((msg) => {
              const instructionEdit = msg.role === "assistant" ? extractInstructionEdit(msg.content) : null;
              const displayContent = instructionEdit ? removeInstructionEditTags(msg.content) : msg.content;
              const isCommitted = committedEdits.has(msg.id);

              return (
                <div
                  key={msg.id}
                  className={`task-detail-panel__message task-detail-panel__message--${msg.role}`}
                >
                  <div className="task-detail-panel__message-role">
                    {msg.role === "user" ? "USER" : "ASSISTANT"} - {chatMode === "planning" ? "Planning" : "Execution"}
                  </div>
                  <div className="task-detail-panel__message-content">
                    {displayContent && <pre>{displayContent}</pre>}
                    {instructionEdit && (
                      <div className="task-detail-panel__instruction-edit-proposal">
                        <div className="task-detail-panel__diff-header">
                          <span>Task Instruction の変更提案</span>
                          {isCommitted ? (
                            <span className="task-detail-panel__committed-badge">Committed</span>
                          ) : (
                            <button
                              className="task-detail-panel__commit-btn"
                              onClick={() => handleCommitInstructionEdit(msg.id, instructionEdit.newContent)}
                            >
                              Commit
                            </button>
                          )}
                        </div>
                        <div className="task-detail-panel__diff-content">
                          {computeSimpleDiff(
                            instruction?.instructionMd || "",
                            instructionEdit.newContent
                          ).map((line, i) => (
                            <div
                              key={i}
                              className={`task-detail-panel__diff-line task-detail-panel__diff-line--${line.type}`}
                            >
                              <span className="task-detail-panel__diff-prefix">
                                {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                              </span>
                              <span>{line.content || " "}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {chatLoading && (
              <div className="task-detail-panel__message task-detail-panel__message--loading">
                <div className="task-detail-panel__message-role">
                  ASSISTANT - {chatMode === "planning" ? "Planning" : "Execution"}
                </div>
                <div className="task-detail-panel__message-content">Thinking...</div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          <div className="task-detail-panel__chat-input">
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder="Ask about the task or request implementation... (⌘+Enter to send)"
            />
            <button
              onClick={handleSendMessage}
              disabled={!chatInput.trim() || chatLoading}
            >
              Send
            </button>
          </div>
        </div>
    </div>
  );
}
