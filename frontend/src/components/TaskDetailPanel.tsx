import { useState, useEffect, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type TaskInstruction, type ChatMessage, type TreeNode, type BranchLink, type GitHubCheck, type GitHubLabel, type BranchDescription, type RepoCollaborator } from "../lib/api";
import { wsClient } from "../lib/ws";
import { computeSimpleDiff, type DiffLine } from "../lib/diff";
import { linkifyPreContent } from "../lib/linkify";
import { ReviewBadge, CIBadge, LabelChip, UserChip, TeamChip } from "./atoms/Chips";
import "./TaskDetailPanel.css";

// Helper to parse saved chunk content
interface SavedChunk {
  type: "thinking" | "text" | "tool_use" | "tool_result";
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

function parseChunkedContent(content: string): SavedChunk[] | null {
  try {
    if (!content.startsWith('{"chunks":')) return null;
    const parsed = JSON.parse(content);
    if (parsed.chunks && Array.isArray(parsed.chunks)) {
      return parsed.chunks as SavedChunk[];
    }
  } catch {
    // Not JSON or invalid format
  }
  return null;
}

// Expandable diff component for Edit tool
function ExpandableDiff({ filePath, oldString, newString }: { filePath: string; oldString: string; newString: string }) {
  const [expanded, setExpanded] = useState(false);
  const MAX_VISIBLE_LINES = 8;

  const diffLines = computeSimpleDiff(oldString, newString);
  // Filter to only show changed lines and some context
  const changedLines: Array<DiffLine & { index: number }> = [];

  diffLines.forEach((line, i) => {
    if (line.type !== "unchanged") {
      changedLines.push({ ...line, index: i });
    }
  });

  // If all lines are unchanged (no diff), show a message
  if (changedLines.length === 0) {
    return (
      <div className="task-detail-panel__tool-input">
        <div style={{ color: "#9ca3af", marginBottom: 4 }}>📝 {filePath}</div>
        <div style={{ color: "#6b7280", fontStyle: "italic" }}>No changes</div>
      </div>
    );
  }

  // Build display lines: changed lines with 1 line of context
  const displaySet = new Set<number>();
  changedLines.forEach(({ index }) => {
    if (index > 0) displaySet.add(index - 1);
    displaySet.add(index);
    if (index < diffLines.length - 1) displaySet.add(index + 1);
  });

  const displayIndices = Array.from(displaySet).sort((a, b) => a - b);
  const visibleLines = expanded ? displayIndices : displayIndices.slice(0, MAX_VISIBLE_LINES);
  const hasMore = displayIndices.length > MAX_VISIBLE_LINES;

  return (
    <div className="task-detail-panel__tool-input">
      <div style={{ color: "#9ca3af", marginBottom: 4 }}>📝 {filePath}</div>
      <div className="task-detail-panel__diff">
        {visibleLines.map((idx, i) => {
          const line = diffLines[idx];
          const prevIdx = visibleLines[i - 1];
          const showEllipsis = i > 0 && idx - prevIdx > 1;
          return (
            <div key={idx}>
              {showEllipsis && <div style={{ color: "#6b7280", padding: "2px 12px" }}>...</div>}
              <div className={`task-detail-panel__diff-line task-detail-panel__diff-line--${line.type}`}>
                <span className="task-detail-panel__diff-prefix">
                  {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                </span>
                <span>{line.content || " "}</span>
              </div>
            </div>
          );
        })}
        {hasMore && !expanded && (
          <button
            className="task-detail-panel__diff-expand-btn"
            onClick={() => setExpanded(true)}
          >
            Show {displayIndices.length - MAX_VISIBLE_LINES} more lines
          </button>
        )}
        {hasMore && expanded && (
          <button
            className="task-detail-panel__diff-expand-btn"
            onClick={() => setExpanded(false)}
          >
            Collapse
          </button>
        )}
      </div>
    </div>
  );
}

// Helper to render tool_use content with proper formatting
function RenderToolUseContent({ toolName, input }: { toolName: string; input: Record<string, unknown> }): React.ReactNode {
  // Bash command
  if (input.command) {
    return <pre className="task-detail-panel__tool-input">$ {String(input.command)}</pre>;
  }

  // Grep/search pattern
  if (input.pattern) {
    return <pre className="task-detail-panel__tool-input">🔍 {String(input.pattern)}{input.path ? ` in ${input.path}` : ""}</pre>;
  }

  // Edit with diff
  if (input.file_path && input.old_string !== undefined) {
    return (
      <ExpandableDiff
        filePath={String(input.file_path)}
        oldString={String(input.old_string)}
        newString={String(input.new_string || "")}
      />
    );
  }

  // Read file
  if (input.file_path) {
    return <pre className="task-detail-panel__tool-input">📄 {String(input.file_path)}</pre>;
  }

  // Glob pattern
  if (toolName === "Glob") {
    return <pre className="task-detail-panel__tool-input">📁 {String(input.pattern || input.path || JSON.stringify(input))}</pre>;
  }

  // Write file
  if (toolName === "Write" && input.file_path) {
    const contentPreview = input.content ? String(input.content).slice(0, 200) : "";
    return (
      <div className="task-detail-panel__tool-input">
        <div style={{ color: "#9ca3af", marginBottom: 4 }}>✏️ {String(input.file_path)}</div>
        {contentPreview && <pre style={{ color: "#4ade80" }}>{contentPreview}{String(input.content || "").length > 200 ? "..." : ""}</pre>}
      </div>
    );
  }

  // Default: show JSON
  return <pre className="task-detail-panel__tool-input">{JSON.stringify(input, null, 2)}</pre>;
}

// Type for ahead/behind status update
interface BranchStatusUpdate {
  aheadBehind?: { ahead: number; behind: number };
  remoteAheadBehind?: { ahead: number; behind: number };
}

interface TaskDetailPanelProps {
  repoId: string;
  localPath: string;
  branchName: string;
  node: TreeNode | null;
  defaultBranch?: string;
  parentBranch?: string;
  onClose: () => void;
  onWorktreeCreated?: () => void | Promise<void>;
  onStartPlanning?: (branchName: string, instruction: string | null) => void;
  activePlanningBranch?: string | null; // Hide instruction section when this matches branchName
  // Instruction from parent (cached)
  instruction?: TaskInstruction | null;
  instructionLoading?: boolean;
  onInstructionUpdate?: (instruction: TaskInstruction) => void;
  // Description from parent (single source of truth)
  description?: string;
  onDescriptionChange?: (branchName: string, description: string) => void;
  // BranchLinks from parent (single source of truth for PR/CI status)
  branchLinksFromParent?: BranchLink[];
  onBranchLinksChange?: (branchName: string, links: BranchLink[]) => void;
  // Callback when branch is deleted (for immediate UI update)
  onBranchDeleted?: (branchName: string) => void;
  // For partial status refresh (instead of full scan)
  edges?: { parent: string; child: string }[];
  onBranchStatusRefresh?: (updates: Record<string, BranchStatusUpdate>) => void;
  onBranchStatusRefreshStart?: (branches: string[]) => void;
  onBranchStatusRefreshEnd?: (branches: string[]) => void;
  // PR quick actions (from project settings)
  prQuickLabels?: string[];
  prQuickReviewers?: string[];
  allRepoLabels?: Array<{ name: string; color: string; description: string }>;
  repoCollaborators?: RepoCollaborator[];
}

export function TaskDetailPanel({
  repoId,
  localPath,
  branchName,
  node,
  defaultBranch,
  parentBranch,
  onClose,
  onWorktreeCreated,
  onStartPlanning,
  activePlanningBranch,
  instruction,
  instructionLoading = false,
  onInstructionUpdate,
  description: descriptionFromParent,
  onDescriptionChange,
  branchLinksFromParent,
  onBranchLinksChange,
  onBranchDeleted,
  edges,
  onBranchStatusRefresh,
  onBranchStatusRefreshStart,
  onBranchStatusRefreshEnd,
  prQuickLabels = [],
  prQuickReviewers = [],
  allRepoLabels = [],
  repoCollaborators = [],
}: TaskDetailPanelProps) {
  const isDefaultBranch = branchName === defaultBranch;

  // Flag to disable chat section (code kept for reuse in Claude Code Sessions later)
  const CHAT_ENABLED = false;

  const [editingInstruction, setEditingInstruction] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Popup state for Labels/Reviewers
  const [showLabelPopup, setShowLabelPopup] = useState<number | null>(null); // PR id
  const [showReviewerPopup, setShowReviewerPopup] = useState<number | null>(null); // PR id
  const labelPopupRef = useRef<HTMLDivElement>(null);
  const reviewerPopupRef = useRef<HTMLDivElement>(null);

  // Get suggested parent from Branch Graph edges
  const suggestedParent = edges?.find((e) => e.child === branchName)?.parent || null;

  // Close popups when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showLabelPopup !== null && labelPopupRef.current && !labelPopupRef.current.contains(e.target as Node)) {
        setShowLabelPopup(null);
      }
      if (showReviewerPopup !== null && reviewerPopupRef.current && !reviewerPopupRef.current.contains(e.target as Node)) {
        setShowReviewerPopup(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showLabelPopup, showReviewerPopup]);

  // Copilot as a fixed reviewer option
  const COPILOT_REVIEWER: RepoCollaborator = {
    login: "copilot-pull-request-reviewer[bot]",
    name: "Copilot",
    avatarUrl: "https://avatars.githubusercontent.com/in/946600?v=4",
    role: "bot",
  };

  // Chat state
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMode, setChatMode] = useState<"execution" | "planning">("planning");
  // Note: Instruction edit statuses and permission grants are now handled via MCP tools
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Streaming state
  interface StreamingChunk {
    type: "thinking" | "text" | "tool_use" | "tool_result" | "thinking_delta" | "text_delta";
    content?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
  }
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [streamingChunks, setStreamingChunks] = useState<StreamingChunk[]>([]);
  const [streamingMode, setStreamingMode] = useState<"planning" | "execution" | null>(null);
  const [canCancel, setCanCancel] = useState(false);
  const hasStreamingChunksRef = useRef(false);

  // Worktree state
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const worktreePath = node?.worktree?.path;

  // Resizable instruction section (persisted in localStorage)
  const DEFAULT_INSTRUCTION_HEIGHT = 120;
  const [instructionHeight, setInstructionHeight] = useState(() => {
    const saved = localStorage.getItem("taskDetail.instructionHeight");
    return saved ? parseInt(saved, 10) : DEFAULT_INSTRUCTION_HEIGHT;
  });
  useEffect(() => {
    localStorage.setItem("taskDetail.instructionHeight", String(instructionHeight));
  }, [instructionHeight]);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);

  // Checkout state - track if we checked out to this branch
  const [checkedOut, setCheckedOut] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [availableWorktrees, setAvailableWorktrees] = useState<{ path: string; branch: string | null }[]>([]);

  // Reset checkout state when branch changes
  useEffect(() => {
    setCheckedOut(false);
  }, [branchName]);

  // Branch links - use parent's data as single source of truth
  const branchLinks = branchLinksFromParent || [];
  const [addingLinkType, setAddingLinkType] = useState<"issue" | "pr" | null>(null);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [deletingLinkId, setDeletingLinkId] = useState<number | null>(null);
  const [addingLink, setAddingLink] = useState(false);
  const [showCIModal, setShowCIModal] = useState(false);
  const [refreshingLink, setRefreshingLink] = useState<number | null>(null);
  const [showDeleteBranchModal, setShowDeleteBranchModal] = useState(false);
  const [showCreateWorktreeModal, setShowCreateWorktreeModal] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [showPushModal, setShowPushModal] = useState(false);
  const [showClearChatModal, setShowClearChatModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [clearingChat, setClearingChat] = useState(false);
  const [checkingPR, setCheckingPR] = useState(false);

  // Deletable branch check (no commits + not on remote)
  const [isDeletable, setIsDeletable] = useState(false);

  // Branch description state (descriptionFromParent is the single source of truth)
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionSaved, setDescriptionSaved] = useState(false);
  const descriptionInputRef = useRef<HTMLInputElement>(null);

  // Repo-level label colors cache
  const [repoLabels, setRepoLabels] = useState<Record<string, string>>({});

  // The working path is either the worktree path or localPath if checked out
  const workingPath = worktreePath || (checkedOut ? localPath : null);

  // Check if PR is merged
  const isMerged = branchLinks.some((l) => l.linkType === "pr" && l.status === "merged");


  // Planning mode can work without workingPath (uses localPath), Execution requires workingPath
  const effectivePath = workingPath || localPath; // For Planning mode, use localPath as fallback

  // Update instruction draft when instruction changes (from parent cache)
  useEffect(() => {
    if (instruction) {
      setInstructionDraft(instruction.instructionMd);
    }
  }, [instruction]);

  // Auto-link PR from node.pr if not already linked (notify parent to update)
  useEffect(() => {
    const autoLinkPR = async () => {
      const hasPRLink = branchLinks.some((l) => l.linkType === "pr");
      if (!hasPRLink && node?.pr?.url && node.pr.number) {
        try {
          const newLink = await api.createBranchLink({
            repoId,
            branchName,
            linkType: "pr",
            url: node.pr.url,
            number: node.pr.number,
          });
          // Notify parent to update branchLinks
          onBranchLinksChange?.(branchName, [...branchLinks, newLink]);
        } catch (err) {
          console.error("Failed to auto-link PR:", err);
        }
      }
    };
    autoLinkPR();
  }, [repoId, branchName, node?.pr?.url, node?.pr?.number, branchLinks, onBranchLinksChange]);

  // Check if branch is deletable (no commits + not on remote)
  useEffect(() => {
    const checkDeletable = async () => {
      if (isDefaultBranch) {
        setIsDeletable(false);
        return;
      }
      try {
        const result = await api.checkBranchDeletable(localPath, branchName, parentBranch);
        setIsDeletable(result.deletable);
      } catch (err) {
        console.error("Failed to check branch deletable:", err);
        setIsDeletable(false);
      }
    };
    checkDeletable();
  }, [localPath, branchName, parentBranch, isDefaultBranch]);

  // Sync description draft with parent's description (single source of truth)
  useEffect(() => {
    setDescriptionDraft(descriptionFromParent || "");
  }, [descriptionFromParent]);

  // Load repo-level label colors
  useEffect(() => {
    const loadRepoLabels = async () => {
      try {
        const labels = await api.getRepoLabels(repoId);
        const labelMap: Record<string, string> = {};
        for (const label of labels) {
          labelMap[label.name] = label.color;
        }
        setRepoLabels(labelMap);
      } catch (err) {
        console.error("Failed to load repo labels:", err);
      }
    };
    loadRepoLabels();
  }, [repoId]);

  // Note: WebSocket updates for branchLinks are handled by parent (TreeDashboard)
  // TaskDetailPanel receives updates via branchLinksFromParent prop

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
          // Note: Instruction edit statuses are now handled via MCP tools
          // Check if there's a running chat to restore Thinking state
          try {
            const { isRunning } = await api.checkChatRunning(existing.id);
            if (isRunning) {
              setChatLoading(true);
            }
          } catch (err) {
            console.error("Failed to check running chat:", err);
          }
        } else {
          // Create new session for this branch
          const newSession = await api.createChatSession(repoId, effectivePath, branchName);
          setChatSessionId(newSession.id);
          setMessages([]);
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

  // Enable cancel button after 5 seconds of loading
  useEffect(() => {
    if (chatLoading) {
      setCanCancel(false);
      const timer = setTimeout(() => setCanCancel(true), 5000);
      return () => clearTimeout(timer);
    } else {
      setCanCancel(false);
    }
  }, [chatLoading]);

  // Subscribe to streaming events and chat messages
  useEffect(() => {
    if (!chatSessionId) return;

    const unsubStart = wsClient.on("chat.streaming.start", (msg) => {
      const data = msg.data as { sessionId: string; chatMode?: string };
      if (data.sessionId === chatSessionId) {
        setStreamingContent("");
        setStreamingChunks([]);
        hasStreamingChunksRef.current = false;
        setStreamingMode((data.chatMode as "planning" | "execution") || "planning");
      }
    });

    const unsubChunk = wsClient.on("chat.streaming.chunk", (msg) => {
      const data = msg.data as {
        sessionId: string;
        chunkType?: string;
        content?: string;
        toolName?: string;
        toolInput?: Record<string, unknown>;
      };
      if (data.sessionId === chatSessionId && data.chunkType) {
        hasStreamingChunksRef.current = true;
        setStreamingContent("streaming");
        setStreamingChunks((prev) => [...prev, {
          type: data.chunkType as StreamingChunk["type"],
          content: data.content,
          toolName: data.toolName,
          toolInput: data.toolInput,
        }]);
      }
    });

    const unsubEnd = wsClient.on("chat.streaming.end", (msg) => {
      const data = msg.data as { sessionId: string; message: ChatMessage };
      if (data.sessionId === chatSessionId) {
        setStreamingContent(null);
        // Keep chunks visible, don't clear them
        setStreamingMode(null);
      }
    });

    // Listen for chat messages (async response from Claude)
    const unsubMessage = wsClient.on("chat.message", (msg) => {
      const data = msg.data as ChatMessage | undefined;
      if (data && data.sessionId === chatSessionId) {
        // Skip adding assistant message if we have streaming chunks (chunks already show full content)
        if (data.role === "assistant" && hasStreamingChunksRef.current) {
          // Don't add to messages, chunks are already showing
          setChatLoading(false);
          return;
        }
        setMessages((prev) => {
          // Avoid duplicates
          if (prev.some((m) => m.id === data.id)) {
            return prev;
          }
          return [...prev, data];
        });
        // Stop loading when we receive an assistant message
        if (data.role === "assistant") {
          setChatLoading(false);
        }
      }
    });

    return () => {
      unsubStart();
      unsubChunk();
      unsubEnd();
      unsubMessage();
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
      onInstructionUpdate?.(updated);
      setEditingInstruction(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSaveDescription = async () => {
    setEditingDescription(false);
    descriptionInputRef.current?.blur();
    // Only save if changed (compare with parent's value - single source of truth)
    if (descriptionDraft === (descriptionFromParent || "")) return;
    setSavingDescription(true);
    try {
      await api.updateBranchDescription(repoId, branchName, descriptionDraft);
      // Notify parent to update the single source of truth
      onDescriptionChange?.(branchName, descriptionDraft);
      // Show saved feedback
      setDescriptionSaved(true);
      setTimeout(() => setDescriptionSaved(false), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingDescription(false);
    }
  };

  const handleCreateWorktree = async () => {
    setShowCreateWorktreeModal(false);
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
  const [pulling, setPulling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Helper to get affected branches (current branch + descendants)
  const getAffectedBranches = useCallback((targetBranch: string): string[] => {
    const affected = new Set<string>([targetBranch]);
    if (!edges) return [targetBranch];

    // Find all descendants
    const findDescendants = (branch: string) => {
      for (const edge of edges) {
        if (edge.parent === branch && !affected.has(edge.child)) {
          affected.add(edge.child);
          findDescendants(edge.child);
        }
      }
    };
    findDescendants(targetBranch);

    return Array.from(affected);
  }, [edges]);

  // Helper to refresh status for affected branches
  const refreshAffectedBranches = useCallback(async (targetBranch: string) => {
    if (!onBranchStatusRefresh || !edges || !defaultBranch) return;

    const branches = getAffectedBranches(targetBranch);

    // Notify start of refresh (for loading UI)
    onBranchStatusRefreshStart?.(branches);

    try {
      const updates = await api.refreshBranchStatus({
        localPath,
        branches,
        edges,
        defaultBranch,
      });
      onBranchStatusRefresh(updates);
    } catch (err) {
      console.error("Failed to refresh branch status:", err);
    } finally {
      // Notify end of refresh
      onBranchStatusRefreshEnd?.(branches);
    }
  }, [localPath, edges, defaultBranch, getAffectedBranches, onBranchStatusRefresh, onBranchStatusRefreshStart, onBranchStatusRefreshEnd]);

  const handlePull = async () => {
    setPulling(true);
    setError(null);
    try {
      await api.pull(localPath, branchName, worktreePath);
      // Refresh status for affected branches instead of full scan
      if (onBranchStatusRefresh && edges && defaultBranch) {
        await refreshAffectedBranches(branchName);
      } else {
        await onWorktreeCreated?.();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPulling(false);
    }
  };

  const handleDelete = async () => {
    setShowDeleteBranchModal(false);
    setDeleting(true);
    setError(null);
    try {
      await api.deleteBranch(localPath, branchName);
      onBranchDeleted?.(branchName); // Immediately remove from graph
      onClose(); // Close panel
      onWorktreeCreated?.(); // Rescan to sync
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  const handleOpenCheckoutModal = async () => {
    setError(null);
    try {
      const result = await api.getWorktreesByRepo(repoId);
      // Build list: main repo + all worktrees
      const list: { path: string; branch: string | null }[] = [
        { path: result.localPath, branch: null }, // main repo - will fetch current branch
      ];
      for (const wt of result.worktrees) {
        if (wt.path !== result.localPath) {
          list.push({ path: wt.path, branch: wt.branch });
        }
      }
      setAvailableWorktrees(list);
      setShowCheckoutModal(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCheckoutTo = async (targetPath: string) => {
    setShowCheckoutModal(false);
    setError(null);

    // Optimistic update: immediately show as checked out
    setCheckedOut(true);

    // API request in background
    try {
      await api.checkout(targetPath, branchName);
      // Refresh status for this branch instead of full scan
      if (onBranchStatusRefresh && edges && defaultBranch) {
        await refreshAffectedBranches(branchName);
      } else {
        onWorktreeCreated?.();
      }
    } catch (err) {
      // Rollback on failure
      setCheckedOut(false);
      setError((err as Error).message);
    }
  };

  const handleRebase = async () => {
    if (!parentBranch) return;
    setShowSyncModal(false);
    setSyncing(true);
    setError(null);
    try {
      await api.rebase(localPath, branchName, parentBranch, worktreePath);
      // Refresh status for affected branches instead of full scan
      if (onBranchStatusRefresh && edges && defaultBranch) {
        await refreshAffectedBranches(branchName);
      } else {
        await onWorktreeCreated?.();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const handleMergeParent = async () => {
    if (!parentBranch) return;
    setShowSyncModal(false);
    setSyncing(true);
    setError(null);
    try {
      await api.mergeParent(localPath, branchName, parentBranch, worktreePath);
      // Refresh status for affected branches instead of full scan
      if (onBranchStatusRefresh && edges && defaultBranch) {
        await refreshAffectedBranches(branchName);
      } else {
        await onWorktreeCreated?.();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const handlePush = async (force?: boolean) => {
    setShowPushModal(false);
    setPushing(true);
    setError(null);
    try {
      await api.push(localPath, branchName, worktreePath, force);
      // Refresh status for this branch (push only affects remote ahead/behind)
      if (onBranchStatusRefresh && edges && defaultBranch) {
        await refreshAffectedBranches(branchName);
      } else {
        await onWorktreeCreated?.();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPushing(false);
    }
  };

  // Note: Instruction edit handlers removed - now handled via MCP tools

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
      // Notify parent to update branchLinks
      onBranchLinksChange?.(branchName, branchLinks.filter((l) => l.id !== id));
      setDeletingLinkId(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRefreshLink = async (id: number) => {
    setRefreshingLink(id);
    try {
      const refreshed = await api.refreshBranchLink(id);
      // Notify parent to update branchLinks
      onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === refreshed.id ? refreshed : l)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshingLink(null);
    }
  };

  // Toggle a label on/off for a PR (optimistic update)
  const handleToggleLabel = async (linkId: number, labelName: string, currentLabels: Array<{ name: string; color: string }>) => {
    const hasLabel = currentLabels.some((l) => l.name === labelName);
    const labelInfo = allRepoLabels.find((l) => l.name === labelName);
    const labelColor = labelInfo?.color || "6b7280";

    // Optimistically update UI immediately
    const optimisticLabels = hasLabel
      ? currentLabels.filter((l) => l.name !== labelName)
      : [...currentLabels, { name: labelName, color: labelColor }];
    const optimisticLink = branchLinks.find((l) => l.id === linkId);
    if (optimisticLink) {
      const updatedLink = { ...optimisticLink, labels: JSON.stringify(optimisticLabels) };
      onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === linkId ? updatedLink : l)));
    }

    // Call API in background
    try {
      if (hasLabel) {
        await api.removePrLabel(linkId, labelName);
      } else {
        await api.addPrLabel(linkId, labelName);
      }
      // Refresh to sync with server state
      const refreshed = await api.refreshBranchLink(linkId);
      onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === refreshed.id ? refreshed : l)));
    } catch (err) {
      // Revert on error
      if (optimisticLink) {
        onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === linkId ? optimisticLink : l)));
      }
      setError((err as Error).message);
    }
  };

  // Toggle a reviewer on/off for a PR (optimistic update)
  const handleToggleReviewer = async (linkId: number, reviewer: string, currentReviewers: string[]) => {
    const hasReviewer = currentReviewers.includes(reviewer);

    // Optimistically update UI immediately
    const optimisticReviewers = hasReviewer
      ? currentReviewers.filter((r) => r !== reviewer)
      : [...currentReviewers, reviewer];
    const optimisticLink = branchLinks.find((l) => l.id === linkId);
    if (optimisticLink) {
      const updatedLink = { ...optimisticLink, reviewers: JSON.stringify(optimisticReviewers) };
      onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === linkId ? updatedLink : l)));
    }

    // Call API in background
    try {
      if (hasReviewer) {
        await api.removePrReviewer(linkId, reviewer);
      } else {
        await api.addPrReviewer(linkId, reviewer);
      }
      // Refresh to sync with server state
      const refreshed = await api.refreshBranchLink(linkId);
      onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === refreshed.id ? refreshed : l)));
    } catch (err) {
      // Revert on error
      if (optimisticLink) {
        onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === linkId ? optimisticLink : l)));
      }
      setError((err as Error).message);
    }
  };

  const handleChangeBaseBranch = async (linkId: number, newBaseBranch: string) => {
    setShowBaseBranchPopup(null);

    // Optimistically update UI
    const optimisticLink = branchLinks.find((l) => l.id === linkId);
    if (optimisticLink) {
      const updatedLink = { ...optimisticLink, baseBranch: newBaseBranch };
      onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === linkId ? updatedLink : l)));
    }

    try {
      await api.changePrBaseBranch(linkId, newBaseBranch);
      // Refresh to sync with server state
      const refreshed = await api.refreshBranchLink(linkId);
      onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === refreshed.id ? refreshed : l)));
    } catch (err) {
      // Revert on error
      if (optimisticLink) {
        onBranchLinksChange?.(branchName, branchLinks.map((l) => (l.id === linkId ? optimisticLink : l)));
      }
      setError((err as Error).message);
    }
  };

  const handleSendMessage = useCallback(async () => {
    if (!chatSessionId || !chatInput.trim() || chatLoading) return;
    const userMessage = chatInput.trim();
    setChatInput("");
    setChatLoading(true);

    // Optimistically add user message
    const tempId = Date.now();
    const tempUserMsg: ChatMessage = {
      id: tempId,
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
      // API returns immediately, assistant message comes via WebSocket
      const result = await api.sendChatMessage(chatSessionId, userMessage, context, chatMode);
      // Replace temp user message with saved one
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? result.userMessage : m))
      );
      // Loading will be set to false when assistant message arrives via WebSocket
    } catch (err) {
      setError((err as Error).message);
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setChatLoading(false);
    }
  }, [chatSessionId, chatInput, chatLoading, instruction, chatMode]);

  const handleClearChat = useCallback(async () => {
    if (!chatSessionId || clearingChat) return;
    setClearingChat(true);
    setShowClearChatModal(false);
    try {
      // Archive current session
      await api.archiveChatSession(chatSessionId);
      // Create new session for this branch
      const newSession = await api.createChatSession(repoId, effectivePath, branchName);
      setChatSessionId(newSession.id);
      setMessages([]);
      setStreamingChunks([]);
      setStreamingContent(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearingChat(false);
    }
  }, [chatSessionId, clearingChat, repoId, effectivePath, branchName]);

  // Check if any loading is happening
  const isRefetching = instructionLoading || checkingPR;

  // Default branch: show simplified view without Planning/Execution
  if (isDefaultBranch) {
    return (
      <div className="task-detail-panel">
        <div className="task-detail-panel__header">
          <h3>
            {branchName}
            {isRefetching && <span className="task-detail-panel__spinner" title="Refreshing..." />}
          </h3>
          <button onClick={onClose} className="task-detail-panel__close">x</button>
        </div>

        {error && <div className="task-detail-panel__error">{error}</div>}

        {/* Working Path Section - checkout available for default branch too */}
        <div className="task-detail-panel__worktree-section">
          {(worktreePath || checkedOut) ? (
            <div className="task-detail-panel__worktree-info">
              <span className="task-detail-panel__active-badge">Active</span>
              {node?.remoteAheadBehind && node.remoteAheadBehind.behind > 0 && (
                <button
                  className="task-detail-panel__pull-btn"
                  onClick={handlePull}
                  disabled={pulling}
                >
                  {pulling ? "Pulling..." : `Pull (↓${node.remoteAheadBehind.behind})`}
                </button>
              )}
            </div>
          ) : (
            <div className="task-detail-panel__branch-actions">
              <button
                className="task-detail-panel__checkout-btn"
                onClick={handleOpenCheckoutModal}
                disabled={checkingOut}
              >
                {checkingOut ? "Checking out..." : "Checkout"}
              </button>
              {node?.remoteAheadBehind && node.remoteAheadBehind.behind > 0 && (
                <button
                  className="task-detail-panel__pull-btn"
                  onClick={handlePull}
                  disabled={pulling}
                >
                  {pulling ? "Pulling..." : `Pull (↓${node.remoteAheadBehind.behind})`}
                </button>
              )}
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
      {/* Deleting overlay */}
      {deleting && (
        <div className="task-detail-panel__deleting-overlay">
          <div className="task-detail-panel__deleting-content">
            <span>Deleting branch...</span>
          </div>
        </div>
      )}

      <div className="task-detail-panel__header">
        <h3>
          {branchName}
          {isRefetching && <span className="task-detail-panel__spinner" title="Refreshing..." />}
        </h3>
        <button onClick={onClose} className="task-detail-panel__close">x</button>
      </div>

      {error && <div className="task-detail-panel__error">{error}</div>}

      {/* Description Section - inline single line */}
      <div className="task-detail-panel__description-row">
        <label>Description:</label>
        {editingDescription ? (
          <input
            ref={descriptionInputRef}
            type="text"
            className="task-detail-panel__description-input"
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            onBlur={handleSaveDescription}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSaveDescription();
              } else if (e.key === "Escape") {
                setDescriptionDraft(descriptionFromParent || "");
                setEditingDescription(false);
              }
            }}
            placeholder="Branch description..."
            autoFocus
          />
        ) : (
          <span
            className={`task-detail-panel__description-text ${!descriptionDraft ? "task-detail-panel__description-text--empty" : ""}`}
            onClick={() => setEditingDescription(true)}
          >
            {descriptionDraft || "Click to add..."}
          </span>
        )}
        {savingDescription && <span className="task-detail-panel__spinner" />}
        {descriptionSaved && <span className="task-detail-panel__saved-check">✓</span>}
      </div>

      {/* Working Path Section */}
      <div className="task-detail-panel__worktree-section">
        {(worktreePath || checkedOut) ? (
          <div className="task-detail-panel__worktree-info">
            <span className="task-detail-panel__active-badge">Active</span>
            <div className="task-detail-panel__branch-actions">
              {/* Behind parent - show Sync button */}
              {node?.aheadBehind && node.aheadBehind.behind > 0 && parentBranch && (
                <button
                  className="task-detail-panel__sync-btn"
                  onClick={() => setShowSyncModal(true)}
                  disabled={syncing}
                >
                  {syncing ? "Syncing..." : `Sync ↓${node.aheadBehind.behind}`}
                </button>
              )}
              {/* Behind remote - show Pull button */}
              {node?.remoteAheadBehind && node.remoteAheadBehind.behind > 0 && (
                <button
                  className="task-detail-panel__pull-btn"
                  onClick={handlePull}
                  disabled={pulling}
                >
                  {pulling ? "Pulling..." : `Pull (↓${node.remoteAheadBehind.behind})`}
                </button>
              )}
              {/* Ahead of remote - show Push button */}
              {node?.remoteAheadBehind && node.remoteAheadBehind.ahead > 0 && (
                <button
                  className="task-detail-panel__push-btn"
                  onClick={() => setShowPushModal(true)}
                  disabled={pushing}
                >
                  {pushing ? "Pushing..." : `Push (↑${node.remoteAheadBehind.ahead})`}
                </button>
              )}
              {isMerged && (
                <span className="task-detail-panel__tooltip-wrapper" data-tooltip="Checkout another branch first">
                  <button
                    className="task-detail-panel__delete-btn"
                    disabled
                  >
                    Delete Branch
                  </button>
                </span>
              )}
              {isDeletable && !isMerged && (
                <span className="task-detail-panel__tooltip-wrapper" data-tooltip="Checkout another branch first">
                  <button
                    className="task-detail-panel__delete-btn"
                    disabled
                  >
                    Delete Branch
                  </button>
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="task-detail-panel__branch-actions">
            <button
              className="task-detail-panel__checkout-btn"
              onClick={handleOpenCheckoutModal}
              disabled={checkingOut}
            >
              {checkingOut ? "Checking out..." : "Checkout"}
            </button>
            {node?.remoteAheadBehind && node.remoteAheadBehind.behind > 0 && (
              <button
                className="task-detail-panel__pull-btn"
                onClick={handlePull}
                disabled={pulling}
              >
                {pulling ? "Pulling..." : `Pull (↓${node.remoteAheadBehind.behind})`}
              </button>
            )}
            {isMerged && (
              <button
                className="task-detail-panel__delete-btn"
                onClick={() => setShowDeleteBranchModal(true)}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete Branch"}
              </button>
            )}
            {isDeletable && !isMerged && (
              <button
                className="task-detail-panel__delete-btn task-detail-panel__delete-btn--empty"
                onClick={() => setShowDeleteBranchModal(true)}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete Branch"}
              </button>
            )}
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
                    {(link.projectStatus || labels.length > 0) && (
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
                    )}
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
            return (
              <div className="task-detail-panel__no-links" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>No PR linked</span>
                <button
                  className="task-detail-panel__refresh-btn"
                  onClick={async () => {
                    setCheckingPR(true);
                    try {
                      // Trigger rescan to check for new PRs
                      await onWorktreeCreated?.();
                    } finally {
                      setCheckingPR(false);
                    }
                  }}
                  disabled={checkingPR}
                  title="Check for PR"
                  style={{ padding: "2px 6px", fontSize: 12 }}
                >
                  {checkingPR ? "..." : "↻"}
                </button>
              </div>
            );
          }
          const labels: GitHubLabel[] = pr.labels ? ((): GitHubLabel[] => { try { const parsed = JSON.parse(pr.labels!); return Array.isArray(parsed) ? parsed.map((l: string | GitHubLabel) => typeof l === 'string' ? { name: l, color: repoLabels[l] || '374151' } : l) : [] } catch { return [] } })() : [];
          const reviewers = pr.reviewers ? ((): string[] => { try { return JSON.parse(pr.reviewers!) } catch { return [] } })() : [];
          const checks: GitHubCheck[] = pr.checks ? ((): GitHubCheck[] => { try { return JSON.parse(pr.checks!) } catch { return [] } })() : [];
          const passedChecks = checks.filter((c) => c.conclusion === "SUCCESS" || c.conclusion === "SKIPPED").length;
          const totalChecks = checks.length;
          // Use checksStatus field directly (scan.ts calculates correct status from latest checks)
          // The checks array in DB may contain stale check results, so checksStatus is more reliable
          const computedChecksStatus = pr.checksStatus ?? null;
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
                {(totalChecks > 0 || computedChecksStatus) && (
                  <CIBadge
                    status={computedChecksStatus as "success" | "failure" | "pending" | "unknown"}
                    passed={totalChecks > 0 ? passedChecks : undefined}
                    total={totalChecks > 0 ? totalChecks : undefined}
                    onClick={totalChecks > 0 ? () => setShowCIModal(true) : undefined}
                  />
                )}
                {(pr.reviewDecision || reviewers.length > 0) && (
                  <ReviewBadge
                    status={
                      pr.reviewDecision === "APPROVED" ? "approved" :
                      pr.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" :
                      "review_required"
                    }
                  />
                )}
                {pr.status && pr.status !== "open" && (
                  <span className={`task-detail-panel__link-status task-detail-panel__link-status--${pr.status}`}>
                    {pr.status}
                  </span>
                )}
                {pr.projectStatus && (
                  <span className="task-detail-panel__link-project">{pr.projectStatus}</span>
                )}
              </div>
              {/* Base Branch Row */}
              {pr.baseBranch && (
                <div className="task-detail-panel__pr-row">
                  <span className="task-detail-panel__pr-row-label">Base:</span>
                  <div className="task-detail-panel__pr-row-items">
                    <span style={{ color: "#e5e7eb", fontSize: 12 }}>{pr.baseBranch}</span>
                    {pr.status === "open" && suggestedParent && pr.baseBranch !== suggestedParent && (
                      <button
                        className="task-detail-panel__pr-add-btn"
                        onClick={() => handleChangeBaseBranch(pr.id, suggestedParent)}
                        title={`Change to ${suggestedParent} (from Branch Graph)`}
                        style={{ color: "#f59e0b" }}
                      >
                        → {suggestedParent}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {/* Labels Row */}
              <div className="task-detail-panel__pr-row">
                <span className="task-detail-panel__pr-row-label">Labels:</span>
                <div className="task-detail-panel__pr-row-items">
                  {labels.map((l, i) => (
                    <LabelChip key={i} name={l.name} color={l.color} />
                  ))}
                  <button
                    className="task-detail-panel__pr-add-btn"
                    onClick={() => setShowLabelPopup(showLabelPopup === pr.id ? null : pr.id)}
                    title="Add/remove labels"
                  >
                    + Add
                  </button>
                </div>
                {/* Label Popup */}
                {showLabelPopup === pr.id && (
                  <div className="task-detail-panel__pr-popup" ref={labelPopupRef}>
                    <div className="task-detail-panel__pr-popup-header">
                      <span>Toggle Labels</span>
                      <button onClick={() => setShowLabelPopup(null)}>×</button>
                    </div>
                    <div className="task-detail-panel__pr-popup-items">
                      {prQuickLabels.map((labelName) => {
                        const hasLabel = labels.some((l) => l.name === labelName);
                        const labelInfo = allRepoLabels.find((l) => l.name === labelName);
                        const color = labelInfo?.color || "374151";
                        return (
                          <button
                            key={labelName}
                            className={`task-detail-panel__pr-popup-item ${hasLabel ? "task-detail-panel__pr-popup-item--active" : ""}`}
                            onClick={() => handleToggleLabel(pr.id, labelName, labels)}
                          >
                            <span
                              className="task-detail-panel__pr-popup-color"
                              style={{ backgroundColor: `#${color}` }}
                            />
                            <span className="task-detail-panel__pr-popup-name">{labelName}</span>
                            {hasLabel && <span className="task-detail-panel__pr-popup-check">✓</span>}
                          </button>
                        );
                      })}
                      {prQuickLabels.length === 0 && (
                        <div className="task-detail-panel__pr-popup-empty">
                          No labels configured. Add labels in Settings &gt; PR &gt; Labels.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {/* Reviewers Row */}
              <div className="task-detail-panel__pr-row">
                <span className="task-detail-panel__pr-row-label">Reviewers:</span>
                <div className="task-detail-panel__pr-row-items">
                  {reviewers.map((r, i) => {
                    const isTeam = r.startsWith("team/");
                    if (isTeam) {
                      return <TeamChip key={i} slug={r.replace("team/", "")} />;
                    }
                    return <UserChip key={i} login={r} />;
                  })}
                  <button
                    className="task-detail-panel__pr-add-btn"
                    onClick={() => setShowReviewerPopup(showReviewerPopup === pr.id ? null : pr.id)}
                    title="Add/remove reviewers"
                  >
                    + Add
                  </button>
                </div>
                {/* Reviewer Popup */}
                {showReviewerPopup === pr.id && (
                  <div className="task-detail-panel__pr-popup" ref={reviewerPopupRef}>
                    <div className="task-detail-panel__pr-popup-header">
                      <span>Toggle Reviewers</span>
                      <button onClick={() => setShowReviewerPopup(null)}>×</button>
                    </div>
                    <div className="task-detail-panel__pr-popup-items">
                      {/* Copilot - always first */}
                      {(() => {
                        const hasCopilot = reviewers.some((r) => r.toLowerCase().includes("copilot"));
                        return (
                          <button
                            key="copilot"
                            className={`task-detail-panel__pr-popup-item ${hasCopilot ? "task-detail-panel__pr-popup-item--active" : ""}`}
                            onClick={() => handleToggleReviewer(pr.id, COPILOT_REVIEWER.login, reviewers)}
                          >
                            <img
                              src={COPILOT_REVIEWER.avatarUrl || ""}
                              alt="Copilot"
                              className="task-detail-panel__pr-popup-avatar"
                            />
                            <span className="task-detail-panel__pr-popup-name">Copilot</span>
                            {hasCopilot && <span className="task-detail-panel__pr-popup-check">✓</span>}
                          </button>
                        );
                      })()}
                      {/* Quick Reviewers from settings */}
                      {prQuickReviewers.map((reviewer) => {
                        // Skip copilot if already shown above
                        if (reviewer === "copilot-pull-request-reviewer[bot]" || reviewer === "copilot") return null;
                        const isTeam = reviewer.startsWith("team/");
                        const displayName = isTeam ? reviewer.replace("team/", "") : reviewer;
                        const hasReviewer = reviewers.includes(reviewer);
                        const collaborator = !isTeam ? repoCollaborators.find((c) => c.login === reviewer) : null;
                        return (
                          <button
                            key={reviewer}
                            className={`task-detail-panel__pr-popup-item ${hasReviewer ? "task-detail-panel__pr-popup-item--active" : ""}`}
                            onClick={() => handleToggleReviewer(pr.id, reviewer, reviewers)}
                          >
                            <img
                              src={isTeam
                                ? `https://github.com/identicons/${displayName}.png`
                                : (collaborator?.avatarUrl || `https://github.com/${reviewer}.png?size=32`)}
                              alt={isTeam ? displayName : reviewer}
                              className="task-detail-panel__pr-popup-avatar"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.style.display = "none";
                                const placeholder = document.createElement("span");
                                placeholder.className = "task-detail-panel__pr-popup-placeholder";
                                placeholder.textContent = (isTeam ? displayName : (collaborator?.name || reviewer)).charAt(0).toUpperCase();
                                target.parentElement?.insertBefore(placeholder, target);
                              }}
                            />
                            <span className="task-detail-panel__pr-popup-name">
                              {isTeam ? displayName : (collaborator?.name || reviewer)}
                            </span>
                            {hasReviewer && <span className="task-detail-panel__pr-popup-check">✓</span>}
                          </button>
                        );
                      })}
                      {prQuickReviewers.length === 0 && (
                        <div className="task-detail-panel__pr-popup-empty">
                          No reviewers configured. Add reviewers in Settings &gt; PR &gt; Reviewers.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Instruction Section - hidden when Planning session is open for this branch */}
      {activePlanningBranch === branchName ? (
        <div className="task-detail-panel__instruction-hidden">
          <span className="task-detail-panel__instruction-hidden-icon">📝</span>
          <span>Editing in Planning Session below</span>
        </div>
      ) : instructionLoading ? (
        <div className="task-detail-panel__instruction-section task-detail-panel__instruction-section--loading">
          <div className="task-detail-panel__instruction-header">
            <h4>Task Instruction</h4>
            <span className="task-detail-panel__spinner" />
          </div>
          <div className="task-detail-panel__instruction-loading">
            Loading...
          </div>
        </div>
      ) : (
        <div className="task-detail-panel__instruction-section">
          <div className="task-detail-panel__instruction-header">
            <h4>Task Instruction</h4>
            <div className="task-detail-panel__instruction-actions">
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
                <>
                  <button onClick={handleSaveInstruction}>Save</button>
                  <button onClick={() => {
                    setEditingInstruction(false);
                    setInstructionDraft(instruction?.instructionMd || "");
                  }}>Cancel</button>
                </>
              )}
            </div>
          </div>
          <div
            className="task-detail-panel__instruction-content"
            style={{ height: instructionHeight }}
          >
            {editingInstruction ? (
              <textarea
                className="task-detail-panel__instruction-textarea"
                value={instructionDraft}
                onChange={(e) => setInstructionDraft(e.target.value)}
                placeholder="No instructions yet..."
              />
            ) : instruction?.instructionMd ? (
              <div className="task-detail-panel__instruction-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {instruction.instructionMd}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="task-detail-panel__instruction-empty">
                No instructions yet...
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resize Handle - Hidden since chat section is disabled */}
      {CHAT_ENABLED && (
        <div
          className={`task-detail-panel__resize-handle ${isResizing ? "task-detail-panel__resize-handle--active" : ""}`}
          onMouseDown={handleResizeStart}
          onDoubleClick={() => setInstructionHeight(DEFAULT_INSTRUCTION_HEIGHT)}
        >
          <div className="task-detail-panel__resize-bar" />
        </div>
      )}

      {/* Chat Section - Hidden for now, will be moved to Claude Code Sessions */}
      {CHAT_ENABLED && <div className="task-detail-panel__chat-section">
        <div className="task-detail-panel__chat-header">
          <h4>Chat</h4>
          <div className="task-detail-panel__chat-header-actions">
            <div className="task-detail-panel__chat-mode-toggle">
              <button
                className={`task-detail-panel__mode-btn ${chatMode === "planning" ? "task-detail-panel__mode-btn--active" : ""}`}
                onClick={() => setChatMode("planning")}
              >
                Planning
              </button>
              <span
                className={(!workingPath || isMerged) ? "task-detail-panel__tooltip-wrapper" : ""}
                data-tooltip={isMerged ? "PR is merged" : !workingPath ? "Checkout or Worktree required" : undefined}
              >
                <button
                  className={`task-detail-panel__mode-btn ${chatMode === "execution" ? "task-detail-panel__mode-btn--active" : ""} ${!workingPath || isMerged ? "task-detail-panel__mode-btn--locked" : ""}`}
                  onClick={() => setChatMode("execution")}
                  disabled={!workingPath || isMerged}
                >
                  Execution
                </button>
              </span>
            </div>
            <button
              className="task-detail-panel__clear-chat-btn"
              onClick={() => setShowClearChatModal(true)}
              disabled={clearingChat || chatLoading || messages.length === 0}
              title="Clear chat history"
            >
              {clearingChat ? "..." : "Clear"}
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
              // Check if content is saved chunks (JSON format)
              const savedChunks = msg.role === "assistant" ? parseChunkedContent(msg.content) : null;

              // Note: Instruction edits and permission requests are now handled via MCP tools
              const displayContent = savedChunks ? null : msg.content;
              const msgMode = msg.chatMode || "planning"; // Fallback to planning for old messages

              // Render saved chunks
              if (savedChunks && savedChunks.length > 0) {
                return (
                  <div key={msg.id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {savedChunks.map((chunk, i) => (
                      <div key={`${msg.id}-chunk-${i}`} className={`task-detail-panel__message task-detail-panel__message--assistant task-detail-panel__chunk--${chunk.type}`}>
                        {i === 0 && (
                          <div className="task-detail-panel__message-role">
                            ASSISTANT - {msgMode === "planning" ? "Planning" : "Execution"}
                          </div>
                        )}
                        <div className="task-detail-panel__message-content">
                          {chunk.type === "thinking" && (
                            <div className="task-detail-panel__thinking">
                              <div className="task-detail-panel__thinking-header">💭 Thinking</div>
                              <pre>{chunk.content}</pre>
                            </div>
                          )}
                          {chunk.type === "text" && (
                            <pre>{linkifyPreContent(chunk.content || "")}</pre>
                          )}
                          {chunk.type === "tool_use" && (
                            <div className="task-detail-panel__tool-use">
                              <div className="task-detail-panel__tool-header">🔧 {chunk.toolName}</div>
                              {chunk.toolInput && <RenderToolUseContent toolName={chunk.toolName || ""} input={chunk.toolInput} />}
                            </div>
                          )}
                          {chunk.type === "tool_result" && (
                            <div className="task-detail-panel__tool-result">
                              <pre>{chunk.content?.slice(0, 500)}{(chunk.content?.length || 0) > 500 ? "..." : ""}</pre>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              }

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
                    {/* Note: Permission requests and instruction edits are now handled via MCP tools */}
                  </div>
                </div>
              );
            })}
            {streamingChunks.map((chunk, i) => (
              <div key={`stream-${i}`} className={`task-detail-panel__message task-detail-panel__message--assistant task-detail-panel__chunk--${chunk.type}`}>
                {i === 0 && (
                  <div className="task-detail-panel__message-role">
                    ASSISTANT - {(streamingMode || chatMode) === "planning" ? "Planning" : "Execution"}
                  </div>
                )}
                <div className="task-detail-panel__message-content">
                  {(chunk.type === "thinking" || chunk.type === "thinking_delta") && (
                    <div className="task-detail-panel__thinking">
                      <div className="task-detail-panel__thinking-header">💭 Thinking</div>
                      <pre>{chunk.content}</pre>
                    </div>
                  )}
                  {(chunk.type === "text" || chunk.type === "text_delta") && (
                    <pre>{linkifyPreContent(chunk.content || "")}</pre>
                  )}
                  {chunk.type === "tool_use" && (
                    <div className="task-detail-panel__tool-use">
                      <div className="task-detail-panel__tool-header">🔧 {chunk.toolName}</div>
                      {chunk.toolInput && <RenderToolUseContent toolName={chunk.toolName || ""} input={chunk.toolInput} />}
                    </div>
                  )}
                  {chunk.type === "tool_result" && (
                    <div className="task-detail-panel__tool-result">
                      <pre>{chunk.content?.slice(0, 500)}{(chunk.content?.length || 0) > 500 ? "..." : ""}</pre>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {(chatLoading || streamingContent !== null) && streamingChunks.length === 0 && (
              <div className="task-detail-panel__message task-detail-panel__message--loading">
                <div className="task-detail-panel__message-role">
                  ASSISTANT - {(streamingMode || chatMode) === "planning" ? "Planning" : "Execution"}
                </div>
                <div className="task-detail-panel__message-content">
                  Thinking...
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
            {canCancel ? (
              <button
                className="task-detail-panel__cancel-btn"
                onClick={async () => {
                  if (chatSessionId) {
                    try {
                      await api.cancelChat(chatSessionId);
                      setChatLoading(false);
                      setStreamingContent(null);
                      setStreamingChunks([]);
                    } catch (err) {
                      console.error("Failed to cancel:", err);
                    }
                  }
                }}
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={handleSendMessage}
                disabled={!chatInput.trim() || chatLoading}
              >
                {chatLoading ? "..." : "Send"}
              </button>
            )}
          </div>
        </div>}

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
                          {check.conclusion === "SUCCESS" ? "✓" : check.conclusion === "FAILURE" || check.conclusion === "ERROR" ? "✗" : check.conclusion === "SKIPPED" ? "⊘" : "●"}
                        </span>
                        <span className="task-detail-panel__ci-name">{check.name}</span>
                        <span className="task-detail-panel__ci-link-icon">↗</span>
                      </a>
                    ) : (
                      <div key={i} className="task-detail-panel__ci-item">
                        <span className={`task-detail-panel__ci-status task-detail-panel__ci-status--${check.conclusion?.toLowerCase() || "pending"}`}>
                          {check.conclusion === "SUCCESS" ? "✓" : check.conclusion === "FAILURE" || check.conclusion === "ERROR" ? "✗" : check.conclusion === "SKIPPED" ? "⊘" : "●"}
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

      {/* Checkout Target Selection Modal */}
      {showCheckoutModal && (
        <div className="task-detail-panel__modal-overlay" onClick={() => setShowCheckoutModal(false)}>
          <div className="task-detail-panel__modal" onClick={(e) => e.stopPropagation()}>
            <h4>Checkout先を選択</h4>
            <div className="task-detail-panel__checkout-list">
              {availableWorktrees.map((wt, i) => (
                <button
                  key={wt.path}
                  className="task-detail-panel__checkout-option"
                  onClick={() => handleCheckoutTo(wt.path)}
                >
                  <span className="task-detail-panel__checkout-option-name">
                    {i === 0 ? "Main" : wt.path.split("/").pop()}
                  </span>
                  {wt.branch && (
                    <span className="task-detail-panel__checkout-option-branch">
                      {wt.branch}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="task-detail-panel__modal-actions">
              <button
                className="task-detail-panel__modal-cancel"
                onClick={() => setShowCheckoutModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Branch Confirmation Modal */}
      {showDeleteBranchModal && (
        <div className="task-detail-panel__modal-overlay" onClick={() => setShowDeleteBranchModal(false)}>
          <div className="task-detail-panel__modal task-detail-panel__modal--delete" onClick={(e) => e.stopPropagation()}>
            <h4>ブランチを削除しますか？</h4>
            <p className="task-detail-panel__modal-branch-name">{branchName}</p>
            {isDeletable && !isMerged ? (
              <p className="task-detail-panel__modal-info">このブランチにはコミットがなく、リモートにもプッシュされていません。</p>
            ) : (
              <p className="task-detail-panel__modal-warning">ローカルとリモートの両方から削除されます。この操作は取り消せません。</p>
            )}
            <div className="task-detail-panel__modal-actions">
              <button
                className="task-detail-panel__modal-cancel"
                onClick={() => setShowDeleteBranchModal(false)}
              >
                キャンセル
              </button>
              <button
                className="task-detail-panel__modal-confirm task-detail-panel__modal-confirm--danger"
                onClick={handleDelete}
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sync Modal - Choose Rebase or Merge */}
      {showSyncModal && parentBranch && (
        <div className="task-detail-panel__modal-overlay" onClick={() => setShowSyncModal(false)}>
          <div className="task-detail-panel__modal task-detail-panel__modal--sync" onClick={(e) => e.stopPropagation()}>
            <h4>Sync with Parent</h4>
            <p className="task-detail-panel__modal-branch-name" style={{ color: "#4ade80" }}>{parentBranch}</p>
            <p className="task-detail-panel__modal-info">
              {node?.aheadBehind && `${node.aheadBehind.behind} commit${node.aheadBehind.behind > 1 ? "s" : ""} behind`}
            </p>
            <div className="task-detail-panel__sync-options">
              <button
                className="task-detail-panel__sync-option"
                onClick={handleRebase}
              >
                <span className="task-detail-panel__sync-option-title">Rebase</span>
                <span className="task-detail-panel__sync-option-desc">Keep history clean (recommended)</span>
              </button>
              <button
                className="task-detail-panel__sync-option"
                onClick={handleMergeParent}
              >
                <span className="task-detail-panel__sync-option-title">Merge</span>
                <span className="task-detail-panel__sync-option-desc">Create a merge commit</span>
              </button>
            </div>
            <div className="task-detail-panel__modal-actions">
              <button
                className="task-detail-panel__modal-cancel"
                onClick={() => setShowSyncModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Push Modal - Choose Push or Force Push */}
      {showPushModal && (
        <div className="task-detail-panel__modal-overlay" onClick={() => setShowPushModal(false)}>
          <div className="task-detail-panel__modal task-detail-panel__modal--sync" onClick={(e) => e.stopPropagation()}>
            <h4>Push to Remote</h4>
            <p className="task-detail-panel__modal-info">
              {node?.remoteAheadBehind && `${node.remoteAheadBehind.ahead} commit${node.remoteAheadBehind.ahead > 1 ? "s" : ""} ahead`}
            </p>
            <div className="task-detail-panel__sync-options">
              <button
                className="task-detail-panel__sync-option"
                onClick={() => handlePush(false)}
              >
                <span className="task-detail-panel__sync-option-title">Push</span>
                <span className="task-detail-panel__sync-option-desc">Normal push (recommended)</span>
              </button>
              <button
                className="task-detail-panel__sync-option task-detail-panel__sync-option--danger"
                onClick={() => handlePush(true)}
              >
                <span className="task-detail-panel__sync-option-title">Force Push</span>
                <span className="task-detail-panel__sync-option-desc">Overwrite remote history (use with caution)</span>
              </button>
            </div>
            <div className="task-detail-panel__modal-actions">
              <button
                className="task-detail-panel__modal-cancel"
                onClick={() => setShowPushModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear Chat Confirmation Modal */}
      {showClearChatModal && (
        <div className="task-detail-panel__modal-overlay" onClick={() => setShowClearChatModal(false)}>
          <div className="task-detail-panel__modal" onClick={(e) => e.stopPropagation()}>
            <h4>チャット履歴をクリアしますか？</h4>
            <p>現在のチャット履歴は保存されますが、新しいセッションが開始されます。</p>
            <div className="task-detail-panel__modal-actions">
              <button
                className="task-detail-panel__modal-cancel"
                onClick={() => setShowClearChatModal(false)}
              >
                キャンセル
              </button>
              <button
                className="task-detail-panel__modal-confirm"
                onClick={handleClearChat}
              >
                クリア
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
