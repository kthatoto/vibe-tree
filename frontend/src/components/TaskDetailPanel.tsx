import { useState, useEffect, useCallback, useRef } from "react";
import { api, type TaskInstruction, type ChatMessage, type TreeNode, type InstructionEditStatus, type BranchLink, type GitHubCheck, type GitHubLabel } from "../lib/api";
import { wsClient } from "../lib/ws";
import {
  extractInstructionEdit,
  removeInstructionEditTags,
  computeSimpleDiff,
} from "../lib/instruction-parser";
import { linkifyPreContent } from "../lib/linkify";
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
  // Track instruction edit statuses (loaded from DB + local updates)
  const [editStatuses, setEditStatuses] = useState<Map<number, InstructionEditStatus>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Streaming state
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [streamingMode, setStreamingMode] = useState<"planning" | "execution" | null>(null);

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

  // Branch links state
  const [branchLinks, setBranchLinks] = useState<BranchLink[]>([]);
  const [addingLinkType, setAddingLinkType] = useState<"issue" | "pr" | null>(null);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [deletingLinkId, setDeletingLinkId] = useState<number | null>(null);
  const [addingLink, setAddingLink] = useState(false);
  const [showCIModal, setShowCIModal] = useState(false);
  const [refreshingLink, setRefreshingLink] = useState<number | null>(null);

  // The working path is either the worktree path or localPath if checked out
  const workingPath = worktreePath || (checkedOut ? localPath : null);

  // Check if PR is merged
  const isMerged = branchLinks.some((l) => l.linkType === "pr" && l.status === "merged");

  // Planning mode can work without workingPath (uses localPath), Execution requires workingPath
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

  // Load branch links and refresh from GitHub
  useEffect(() => {
    const loadBranchLinks = async () => {
      try {
        const links = await api.getBranchLinks(repoId, branchName);
        setBranchLinks(links);
        // Auto-refresh all links from GitHub when panel opens
        for (const link of links) {
          if (link.number) {
            try {
              const refreshed = await api.refreshBranchLink(link.id);
              setBranchLinks((prev) =>
                prev.map((l) => (l.id === refreshed.id ? refreshed : l))
              );
            } catch (err) {
              console.error(`Failed to refresh link ${link.id}:`, err);
            }
          }
        }
      } catch (err) {
        console.error("Failed to load branch links:", err);
      }
    };
    loadBranchLinks();
  }, [repoId, branchName]);

  // Poll CI status for PRs every 30 seconds
  useEffect(() => {
    const pr = branchLinks.find((l) => l.linkType === "pr");
    if (!pr?.number) return;

    const pollCI = async () => {
      try {
        const refreshed = await api.refreshBranchLink(pr.id);
        setBranchLinks((prev) =>
          prev.map((l) => (l.id === refreshed.id ? refreshed : l))
        );
      } catch (err) {
        console.error("Failed to poll CI:", err);
      }
    };

    const interval = setInterval(pollCI, 30000);
    return () => clearInterval(interval);
  }, [branchLinks]);

  // Subscribe to branch link updates (for auto-linked PRs from chat)
  useEffect(() => {
    const unsubCreated = wsClient.on("branchLink.created", (msg) => {
      const data = msg.data as BranchLink;
      if (data.repoId === repoId && data.branchName === branchName) {
        setBranchLinks((prev) => {
          // Avoid duplicates
          if (prev.some((l) => l.id === data.id)) return prev;
          return [data, ...prev];
        });
      }
    });

    const unsubUpdated = wsClient.on("branchLink.updated", (msg) => {
      const data = msg.data as BranchLink;
      if (data.repoId === repoId && data.branchName === branchName) {
        setBranchLinks((prev) =>
          prev.map((l) => (l.id === data.id ? data : l))
        );
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
    };
  }, [repoId, branchName]);

  // Load existing chat session for this branch
  useEffect(() => {
    const initChat = async () => {
      try {
        // Get existing sessions for this repo
        const sessions = await api.getChatSessions(repoId);
        // Find session by branchName only (branch is the key)
        const existing = sessions.find(
          (s) => s.branchName === branchName && s.status === "active"
        );

        if (existing) {
          setChatSessionId(existing.id);
          const msgs = await api.getChatMessages(existing.id);
          setMessages(msgs);
          // Load edit statuses from messages
          const statuses = new Map<number, InstructionEditStatus>();
          for (const msg of msgs) {
            if (msg.instructionEditStatus) {
              statuses.set(msg.id, msg.instructionEditStatus);
            }
          }
          setEditStatuses(statuses);
        } else {
          // Create new session for this branch
          const newSession = await api.createChatSession(repoId, effectivePath, branchName);
          setChatSessionId(newSession.id);
          setMessages([]);
          setEditStatuses(new Map());
        }
      } catch (err) {
        console.error("Failed to init chat:", err);
      }
    };
    initChat();
  }, [repoId, effectivePath, branchName]);

  // Scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    if (messages.length > 0 || streamingContent) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages, streamingContent]);

  // Subscribe to streaming events
  useEffect(() => {
    if (!chatSessionId) return;

    const unsubStart = wsClient.on("chat.streaming.start", (msg) => {
      const data = msg.data as { sessionId: string; chatMode?: string };
      if (data.sessionId === chatSessionId) {
        setStreamingContent("");
        setStreamingMode((data.chatMode as "planning" | "execution") || "planning");
      }
    });

    const unsubChunk = wsClient.on("chat.streaming.chunk", (msg) => {
      const data = msg.data as { sessionId: string; accumulated: string };
      if (data.sessionId === chatSessionId) {
        setStreamingContent(data.accumulated);
      }
    });

    const unsubEnd = wsClient.on("chat.streaming.end", (msg) => {
      const data = msg.data as { sessionId: string; message: ChatMessage };
      if (data.sessionId === chatSessionId) {
        setStreamingContent(null);
        setStreamingMode(null);
        // The message will be added when the API response returns
      }
    });

    return () => {
      unsubStart();
      unsubChunk();
      unsubEnd();
    };
  }, [chatSessionId]);

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
      // Update the task instruction
      const updated = await api.updateTaskInstruction(repoId, branchName, newContent);
      setInstruction(updated);
      // Save the commit status to DB
      await api.updateInstructionEditStatus(messageId, "committed");
      setEditStatuses((prev) => new Map(prev).set(messageId, "committed"));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRejectInstructionEdit = async (messageId: number) => {
    try {
      // Save the reject status to DB
      await api.updateInstructionEditStatus(messageId, "rejected");
      setEditStatuses((prev) => new Map(prev).set(messageId, "rejected"));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleAddBranchLink = async (linkType: "issue" | "pr") => {
    if (!newLinkUrl.trim() || addingLink) return;
    setAddingLink(true);
    try {
      const url = newLinkUrl.trim();

      // Extract number from URL
      let number: number | undefined;
      if (linkType === "pr") {
        const match = url.match(/\/pull\/(\d+)/);
        if (match) number = parseInt(match[1], 10);
      } else {
        const match = url.match(/\/issues\/(\d+)/);
        if (match) number = parseInt(match[1], 10);
      }

      await api.createBranchLink({
        repoId,
        branchName,
        linkType,
        url,
        number,
      });
      // State will be updated via WebSocket branchLink.created event
      setNewLinkUrl("");
      setAddingLinkType(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAddingLink(false);
    }
  };

  const handleDeleteBranchLink = async (id: number) => {
    try {
      await api.deleteBranchLink(id);
      setBranchLinks((prev) => prev.filter((l) => l.id !== id));
      setDeletingLinkId(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRefreshLink = async (id: number) => {
    setRefreshingLink(id);
    try {
      const refreshed = await api.refreshBranchLink(id);
      setBranchLinks((prev) =>
        prev.map((l) => (l.id === refreshed.id ? refreshed : l))
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshingLink(null);
    }
  };

  const handleSendMessage = useCallback(async () => {
    if (!chatSessionId || !chatInput.trim() || chatLoading) return;
    const userMessage = chatInput.trim();
    setChatInput("");
    setChatLoading(true);

    // Optimistically add user message
    const tempUserMsg: ChatMessage = {
      id: Date.now(),
      sessionId: chatSessionId,
      role: "user",
      content: userMessage,
      chatMode: chatMode,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      // Include task instruction as context
      const context = instruction?.instructionMd
        ? `[Task Instruction]\n${instruction.instructionMd}\n\n[Mode: ${chatMode}]`
        : `[Mode: ${chatMode}]`;
      const result = await api.sendChatMessage(chatSessionId, userMessage, context, chatMode);
      // Replace temp user message with saved one, add assistant message
      setMessages((prev) => [
        ...prev.slice(0, -1), // Remove temp user message
        result.userMessage,
        result.assistantMessage,
      ]);
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

        {error && <div className="task-detail-panel__error">{error}</div>}

        {/* Working Path Section - checkout available for default branch too */}
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
                disabled={checkingOut}
              >
                {checkingOut ? "Checking out..." : "Checkout"}
              </button>
            </div>
          )}
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

      {/* Issue Section */}
      <div className="task-detail-panel__links-section">
        <div className="task-detail-panel__links-header">
          <h4>Issue</h4>
          {addingLinkType !== "issue" && (
            <button
              className="task-detail-panel__add-link-btn"
              onClick={() => setAddingLinkType("issue")}
            >
              + Add
            </button>
          )}
        </div>
        {addingLinkType === "issue" && (
          <div className="task-detail-panel__add-link-form">
            <input
              type="text"
              className="task-detail-panel__link-input"
              value={newLinkUrl}
              onChange={(e) => setNewLinkUrl(e.target.value)}
              placeholder="Paste GitHub Issue URL..."
              disabled={addingLink}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && !addingLink) {
                  e.preventDefault();
                  handleAddBranchLink("issue");
                } else if (e.key === "Escape" && !addingLink) {
                  setAddingLinkType(null);
                  setNewLinkUrl("");
                }
              }}
              autoFocus
            />
            <div className="task-detail-panel__add-link-actions">
              <button
                className="task-detail-panel__link-save-btn"
                onClick={() => handleAddBranchLink("issue")}
                disabled={!newLinkUrl.trim() || addingLink}
              >
                {addingLink ? "Adding..." : "Add"}
              </button>
              <button
                className="task-detail-panel__link-cancel-btn"
                onClick={() => {
                  setAddingLinkType(null);
                  setNewLinkUrl("");
                }}
                disabled={addingLink}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {(() => {
          const issues = branchLinks.filter((l) => l.linkType === "issue");
          return issues.length > 0 ? (
            <div className="task-detail-panel__links-list">
              {issues.map((link) => {
                const labels = link.labels ? JSON.parse(link.labels) as string[] : [];
                return (
                  <div key={link.id} className="task-detail-panel__link-item task-detail-panel__link-item--detailed">
                    <div className="task-detail-panel__link-main">
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="task-detail-panel__link-url"
                      >
                        {link.number && <span className="task-detail-panel__link-number">#{link.number}</span>}
                        {link.title || (!link.number && link.url)}
                      </a>
                      <button
                        className="task-detail-panel__link-delete-btn"
                        onClick={() => setDeletingLinkId(link.id)}
                        title="Remove link"
                      >
                        ×
                      </button>
                    </div>
                    <div className="task-detail-panel__link-meta">
                      {link.projectStatus && (
                        <span className="task-detail-panel__link-project">{link.projectStatus}</span>
                      )}
                      {labels.length > 0 && (
                        <span className="task-detail-panel__link-labels">
                          {labels.map((l, i) => (
                            <span key={i} className="task-detail-panel__link-label">{l}</span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : addingLinkType !== "issue" ? (
            <div className="task-detail-panel__no-links">No issue linked</div>
          ) : null;
        })()}
      </div>

      {/* PR Section - Auto-linked only, no manual add/delete */}
      <div className="task-detail-panel__links-section">
        <div className="task-detail-panel__links-header">
          <h4>PR</h4>
        </div>
        {(() => {
          const pr = branchLinks.find((l) => l.linkType === "pr");
          if (!pr) {
            return <div className="task-detail-panel__no-links">No PR linked</div>;
          }
          const labels: GitHubLabel[] = pr.labels ? ((): GitHubLabel[] => { try { const parsed = JSON.parse(pr.labels!); return Array.isArray(parsed) ? parsed.map((l: string | GitHubLabel) => typeof l === 'string' ? { name: l, color: '374151' } : l) : [] } catch { return [] } })() : [];
          const reviewers = pr.reviewers ? ((): string[] => { try { return JSON.parse(pr.reviewers!) } catch { return [] } })() : [];
          const checks: GitHubCheck[] = pr.checks ? ((): GitHubCheck[] => { try { return JSON.parse(pr.checks!) } catch { return [] } })() : [];
          const passedChecks = checks.filter((c) => c.conclusion === "SUCCESS").length;
          const totalChecks = checks.length;
          // Helper to get contrasting text color
          const getTextColor = (bgColor: string) => {
            const r = parseInt(bgColor.slice(0, 2), 16);
            const g = parseInt(bgColor.slice(2, 4), 16);
            const b = parseInt(bgColor.slice(4, 6), 16);
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            return luminance > 0.5 ? '#000000' : '#ffffff';
          };
          return (
            <div className="task-detail-panel__link-item task-detail-panel__link-item--detailed">
              <div className="task-detail-panel__link-main">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="task-detail-panel__link-url"
                >
                  {pr.number && <span className="task-detail-panel__link-number">#{pr.number}</span>}
                  {pr.title || (!pr.number && pr.url)}
                </a>
                <button
                  className="task-detail-panel__refresh-btn"
                  onClick={() => handleRefreshLink(pr.id)}
                  disabled={refreshingLink === pr.id}
                  title="Refresh from GitHub"
                >
                  {refreshingLink === pr.id ? "..." : "↻"}
                </button>
              </div>
              <div className="task-detail-panel__link-meta">
                {totalChecks > 0 && (
                  <button
                    className={`task-detail-panel__ci-badge task-detail-panel__ci-badge--${pr.checksStatus}`}
                    onClick={() => setShowCIModal(true)}
                    title="View CI details"
                  >
                    <span className="task-detail-panel__ci-badge-icon">
                      {pr.checksStatus === "success" ? "✓" : pr.checksStatus === "failure" ? "✗" : "●"}
                    </span>
                    <span className="task-detail-panel__ci-badge-count">{passedChecks}/{totalChecks}</span>
                  </button>
                )}
                {pr.reviewDecision && (
                  <span className={`task-detail-panel__review-badge task-detail-panel__review-badge--${pr.reviewDecision.toLowerCase().replace('_', '-')}`}>
                    {pr.reviewDecision === "APPROVED" ? "✓ Approved" :
                     pr.reviewDecision === "CHANGES_REQUESTED" ? "⚠ Changes Requested" :
                     pr.reviewDecision === "REVIEW_REQUIRED" ? "Review Required" : pr.reviewDecision}
                  </span>
                )}
                {pr.status && pr.status !== "open" && (
                  <span className={`task-detail-panel__link-status task-detail-panel__link-status--${pr.status}`}>
                    {pr.status}
                  </span>
                )}
                {pr.projectStatus && (
                  <span className="task-detail-panel__link-project">{pr.projectStatus}</span>
                )}
                <span className="task-detail-panel__link-reviewers">
                  {reviewers.length > 0 ? (
                    reviewers.map((r, i) => (
                      <span key={i} className="task-detail-panel__link-reviewer">@{r}</span>
                    ))
                  ) : (
                    <span className="task-detail-panel__link-reviewer task-detail-panel__link-reviewer--none">No Reviewers</span>
                  )}
                </span>
              </div>
              {labels.length > 0 && (
                <div className="task-detail-panel__pr-labels">
                  {labels.map((l, i) => (
                    <span
                      key={i}
                      className="task-detail-panel__pr-label"
                      style={{ backgroundColor: `#${l.color}`, color: getTextColor(l.color) }}
                    >
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
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
              className={`task-detail-panel__mode-btn ${chatMode === "execution" ? "task-detail-panel__mode-btn--active" : ""} ${!workingPath || isMerged ? "task-detail-panel__mode-btn--locked" : ""}`}
              onClick={() => setChatMode("execution")}
              disabled={!workingPath || isMerged}
              title={isMerged ? "PR is merged - Execution mode disabled" : !workingPath ? "Checkout or create worktree to use Execution mode" : ""}
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
              const editStatus = editStatuses.get(msg.id);
              const msgMode = msg.chatMode || "planning"; // Fallback to planning for old messages

              return (
                <div
                  key={msg.id}
                  className={`task-detail-panel__message task-detail-panel__message--${msg.role}`}
                >
                  <div className="task-detail-panel__message-role">
                    {msg.role === "user" ? "USER" : "ASSISTANT"} - {msgMode === "planning" ? "Planning" : "Execution"}
                  </div>
                  <div className="task-detail-panel__message-content">
                    {displayContent && <pre>{linkifyPreContent(displayContent)}</pre>}
                    {instructionEdit && (
                      <div className={`task-detail-panel__instruction-edit-proposal ${editStatus === "rejected" ? "task-detail-panel__instruction-edit-proposal--rejected" : ""}`}>
                        <div className="task-detail-panel__diff-header">
                          <span>Task Instruction の変更提案</span>
                          {editStatus === "committed" && (
                            <span className="task-detail-panel__committed-badge">Accepted</span>
                          )}
                          {editStatus === "rejected" && (
                            <span className="task-detail-panel__rejected-badge">Rejected</span>
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
                        {!editStatus && (
                          <div className="task-detail-panel__diff-actions">
                            <button
                              className="task-detail-panel__accept-btn"
                              onClick={() => handleCommitInstructionEdit(msg.id, instructionEdit.newContent)}
                            >
                              Accept
                            </button>
                            <button
                              className="task-detail-panel__reject-btn"
                              onClick={() => handleRejectInstructionEdit(msg.id)}
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {(chatLoading || streamingContent !== null) && (
              <div className="task-detail-panel__message task-detail-panel__message--loading">
                <div className="task-detail-panel__message-role">
                  ASSISTANT - {(streamingMode || chatMode) === "planning" ? "Planning" : "Execution"}
                  {streamingContent !== null && <span className="task-detail-panel__streaming-indicator"> (Streaming...)</span>}
                </div>
                <div className="task-detail-panel__message-content">
                  {streamingContent !== null && streamingContent.length > 0 ? (
                    <pre>{linkifyPreContent(streamingContent)}</pre>
                  ) : (
                    "Thinking..."
                  )}
                </div>
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

      {/* Delete Confirmation Modal */}
      {deletingLinkId !== null && (
        <div className="task-detail-panel__modal-overlay" onClick={() => setDeletingLinkId(null)}>
          <div className="task-detail-panel__modal" onClick={(e) => e.stopPropagation()}>
            <h4>Issue を削除しますか？</h4>
            <p>この操作は取り消せません。</p>
            <div className="task-detail-panel__modal-actions">
              <button
                className="task-detail-panel__modal-cancel"
                onClick={() => setDeletingLinkId(null)}
              >
                キャンセル
              </button>
              <button
                className="task-detail-panel__modal-confirm"
                onClick={() => handleDeleteBranchLink(deletingLinkId)}
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CI Details Modal */}
      {showCIModal && (() => {
        const pr = branchLinks.find((l) => l.linkType === "pr");
        const checks: GitHubCheck[] = pr?.checks ? ((): GitHubCheck[] => { try { return JSON.parse(pr.checks!) } catch { return [] } })() : [];
        return (
          <div className="task-detail-panel__modal-overlay" onClick={() => setShowCIModal(false)}>
            <div className="task-detail-panel__modal task-detail-panel__modal--ci" onClick={(e) => e.stopPropagation()}>
              <div className="task-detail-panel__modal-header">
                <h4>CI Status</h4>
                <button className="task-detail-panel__modal-close" onClick={() => setShowCIModal(false)}>×</button>
              </div>
              <div className="task-detail-panel__ci-list">
                {checks.length === 0 ? (
                  <p className="task-detail-panel__ci-empty">No checks found</p>
                ) : (
                  checks.map((check, i) => (
                    check.detailsUrl ? (
                      <a
                        key={i}
                        href={check.detailsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="task-detail-panel__ci-item task-detail-panel__ci-item--link"
                      >
                        <span className={`task-detail-panel__ci-status task-detail-panel__ci-status--${check.conclusion?.toLowerCase() || "pending"}`}>
                          {check.conclusion === "SUCCESS" ? "✓" : check.conclusion === "FAILURE" || check.conclusion === "ERROR" ? "✗" : "●"}
                        </span>
                        <span className="task-detail-panel__ci-name">{check.name}</span>
                        <span className="task-detail-panel__ci-link-icon">↗</span>
                      </a>
                    ) : (
                      <div key={i} className="task-detail-panel__ci-item">
                        <span className={`task-detail-panel__ci-status task-detail-panel__ci-status--${check.conclusion?.toLowerCase() || "pending"}`}>
                          {check.conclusion === "SUCCESS" ? "✓" : check.conclusion === "FAILURE" || check.conclusion === "ERROR" ? "✗" : "●"}
                        </span>
                        <span className="task-detail-panel__ci-name">{check.name}</span>
                      </div>
                    )
                  ))
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
