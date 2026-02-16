import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ChatMessage } from "../lib/api";
import { extractTaskSuggestions, removeTaskTags, type TaskSuggestion } from "../lib/task-parser";
import { extractAskUserQuestion } from "../lib/ask-user-question";
import { AskUserQuestionUI } from "./AskUserQuestionUI";
import { wsClient } from "../lib/ws";
import { useIsStreaming } from "../lib/useStreamingState";
import githubIcon from "../assets/github.svg";

interface ExecuteTaskInfo {
  branchName: string;
  instruction: string | null;
}

interface ExecuteContext {
  branchName: string;
  instruction: string | null;
  taskIndex: number;
  totalTasks: number;
  allTasks: ExecuteTaskInfo[];
}

interface ChatPanelProps {
  sessionId: string;
  onTaskSuggested?: (task: TaskSuggestion) => void;
  existingTaskLabels?: string[];
  disabled?: boolean;
  executeMode?: boolean;
  executeContext?: ExecuteContext;
}

interface StreamingChunk {
  type: "thinking" | "text" | "tool_use" | "tool_result" | "thinking_delta" | "text_delta";
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export function ChatPanel({
  sessionId,
  onTaskSuggested,
  existingTaskLabels = [],
  disabled = false,
  executeMode = false,
  executeContext,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  // Use global streaming state as single source of truth
  const isStreaming = useIsStreaming(sessionId);
  // Local state for the brief period between sending and streaming.start
  const [isSending, setIsSending] = useState(false);
  // Combined loading state for UI
  const loading = isStreaming || isSending;
  const [error, setError] = useState<string | null>(null);
  const [addedTasks, setAddedTasks] = useState<Set<string>>(new Set());
  // Streaming state
  const [streamingChunks, setStreamingChunks] = useState<StreamingChunk[]>([]);
  const streamingChunksRef = useRef<StreamingChunk[]>([]);
  const hasStreamingChunksRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  // Pagination state
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const MESSAGES_PER_PAGE = 20;
  // Quick mode (use haiku for faster responses)
  const [quickMode, setQuickMode] = useState(false);
  // Context stats
  const [contextStats, setContextStats] = useState<{
    messageCount: number;
    summaryCount: number;
    artifactCount: number;
    totalRawTokens: number;
  } | null>(null);
  // Textarea height (resizable from top)
  const DEFAULT_TEXTAREA_HEIGHT = 80;
  const [textareaHeight, setTextareaHeight] = useState(() => {
    const saved = localStorage.getItem("chatPanel.textareaHeight");
    return saved ? parseInt(saved, 10) : DEFAULT_TEXTAREA_HEIGHT;
  });
  const [isResizingTextarea, setIsResizingTextarea] = useState(false);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);

  // Save textarea height to localStorage
  useEffect(() => {
    localStorage.setItem("chatPanel.textareaHeight", String(textareaHeight));
  }, [textareaHeight]);

  // Textarea resize handlers (drag from top edge)
  const handleTextareaResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingTextarea(true);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = textareaHeight;
  }, [textareaHeight]);

  useEffect(() => {
    if (!isResizingTextarea) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Dragging up increases height, dragging down decreases
      const deltaY = resizeStartY.current - e.clientY;
      const newHeight = Math.max(60, Math.min(500, resizeStartHeight.current + deltaY));
      setTextareaHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizingTextarea(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingTextarea]);

  // Refs for callbacks to avoid stale closures in WebSocket handlers
  const executeContextRef = useRef(executeContext);

  // Keep refs up to date
  useEffect(() => {
    executeContextRef.current = executeContext;
  }, [executeContext]);

  // Load messages and restore streaming state if active
  const loadMessages = useCallback(async () => {
    try {
      const [msgs, streamingState, stats] = await Promise.all([
        api.getChatMessages(sessionId, { limit: MESSAGES_PER_PAGE }),
        api.getStreamingState(sessionId),
        api.getContextStats(sessionId).catch(() => null),
      ]);
      setContextStats(stats);
      setMessages(msgs);
      setHasMoreMessages(msgs.length >= MESSAGES_PER_PAGE);

      // Check if last assistant message is still streaming
      const lastMsg = msgs[msgs.length - 1];
      let isStillStreaming = false;
      if (lastMsg?.role === "assistant") {
        try {
          const parsed = JSON.parse(lastMsg.content);
          if (parsed.streaming === true) {
            isStillStreaming = true;
          }
        } catch {
          // Not JSON, not streaming
        }
      }

      // Restore streaming chunks if there's an active stream
      // Note: streaming state (isStreaming) is managed by global useStreamingState hook
      if (streamingState.isStreaming && streamingState.chunks.length > 0) {
        const restoredChunks: StreamingChunk[] = streamingState.chunks.map((chunk) => ({
          type: chunk.type as StreamingChunk["type"],
          content: chunk.content,
          toolName: chunk.toolName,
          toolInput: chunk.toolInput as Record<string, unknown> | undefined,
        }));
        setStreamingChunks(restoredChunks);
        hasStreamingChunksRef.current = true;
      } else {
        setStreamingChunks([]);
        hasStreamingChunksRef.current = false;
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [sessionId]);

  // Load older messages (for infinite scroll)
  const loadOlderMessages = useCallback(async () => {
    if (!hasMoreMessages || loadingOlder || messages.length === 0) return;

    const oldestMessage = messages[0];
    if (!oldestMessage) return;

    setLoadingOlder(true);
    try {
      const container = messagesContainerRef.current;
      const scrollHeightBefore = container?.scrollHeight || 0;

      const olderMsgs = await api.getChatMessages(sessionId, {
        limit: MESSAGES_PER_PAGE,
        before: oldestMessage.id,
      });

      if (olderMsgs.length < MESSAGES_PER_PAGE) {
        setHasMoreMessages(false);
      }

      if (olderMsgs.length > 0) {
        setMessages((prev) => [...olderMsgs, ...prev]);

        // Maintain scroll position after prepending messages
        requestAnimationFrame(() => {
          if (container) {
            const scrollHeightAfter = container.scrollHeight;
            container.scrollTop = scrollHeightAfter - scrollHeightBefore;
          }
        });
      }
    } catch (err) {
      console.error("Failed to load older messages:", err);
    } finally {
      setLoadingOlder(false);
    }
  }, [sessionId, messages, hasMoreMessages, loadingOlder]);

  // Clear state immediately when sessionId changes (before loading new data)
  useEffect(() => {
    setMessages([]);
    setStreamingChunks([]);
    hasStreamingChunksRef.current = false;
    // Note: streaming state is managed globally via useStreamingState
    setError(null);
    setHasMoreMessages(true);
  }, [sessionId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Re-fetch streaming state when tab becomes visible (handles tab switching)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log("[ChatPanel] Tab became visible, re-fetching streaming state");
        loadMessages();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadMessages]);

  // Cancel execution on Escape key (document-level listener)
  useEffect(() => {
    const handleEscapeKey = async (e: KeyboardEvent) => {
      if (e.key === "Escape" && isStreaming) {
        e.preventDefault();
        console.log("[ChatPanel] Escape pressed, cancelling...");
        try {
          await api.cancelChat(sessionId);
          console.log("[ChatPanel] Cancel API called successfully");
        } catch (err) {
          console.error("[ChatPanel] Failed to cancel:", err);
        }
      }
    };

    document.addEventListener("keydown", handleEscapeKey);
    return () => document.removeEventListener("keydown", handleEscapeKey);
  }, [sessionId, isStreaming]);

  // Sync streamingChunksRef with streamingChunks state
  useEffect(() => {
    streamingChunksRef.current = streamingChunks;
  }, [streamingChunks]);

  // Track current runId to filter out streaming.end from old/cancelled runs
  const currentRunIdRef = useRef<number | null>(null);

  // Listen for WebSocket streaming events
  // Note: streaming state (start/end) is handled by useStreamingState hook
  // Here we only handle chunks and message updates
  useEffect(() => {
    const unsubStart = wsClient.on("chat.streaming.start", (msg) => {
      const data = msg.data as { sessionId: string; runId?: number };
      console.log(`[ChatPanel] streaming.start received, msgSessionId=${data.sessionId}, currentSessionId=${sessionId}, match=${data.sessionId === sessionId}, runId=${data.runId}`);
      if (data.sessionId === sessionId) {
        // Track runId to filter stale streaming.end events
        if (data.runId) {
          currentRunIdRef.current = data.runId;
        }
        // Clear local sending state (streaming is now tracked globally)
        setIsSending(false);
        // Clear chunks for new stream
        setStreamingChunks([]);
        streamingChunksRef.current = [];
        hasStreamingChunksRef.current = false;
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
      if (data.sessionId === sessionId && data.chunkType) {
        hasStreamingChunksRef.current = true;
        setStreamingChunks((prev) => [...prev, {
          type: data.chunkType as StreamingChunk["type"],
          content: data.content,
          toolName: data.toolName,
          toolInput: data.toolInput,
        }]);
      }
    });

    const unsubEnd = wsClient.on("chat.streaming.end", (msg) => {
      const data = msg.data as { sessionId: string; message?: ChatMessage; interrupted?: boolean; runId?: number };
      console.log(`[ChatPanel] streaming.end received, msgSessionId=${data.sessionId}, currentSessionId=${sessionId}, match=${data.sessionId === sessionId}, interrupted=${data.interrupted}, runId=${data.runId}, currentRunId=${currentRunIdRef.current}`);
      if (data.sessionId === sessionId) {
        // Ignore streaming.end from old runs (e.g., cancelled run that finished late)
        if (data.runId && currentRunIdRef.current && data.runId !== currentRunIdRef.current) {
          console.log(`[ChatPanel] streaming.end: ignoring old run (runId=${data.runId}, currentRunId=${currentRunIdRef.current})`);
          return;
        }
        console.log(`[ChatPanel] streaming.end: message=${!!data.message}, interrupted=${data.interrupted}`);

        // Add the message to messages list and clear streaming chunks
        // Note: Instruction/ToDo/Question updates are now handled via MCP tools and WebSocket broadcasts
        // Note: streaming state is managed globally by useStreamingState
        if (data.message) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === data.message!.id)) {
              return prev;
            }
            // Add message and sort by createdAt to ensure correct order
            const updated = [...prev, data.message!];
            return updated.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          });
        }
        // Clear local sending state
        setIsSending(false);
        setStreamingChunks([]);
        streamingChunksRef.current = [];
        hasStreamingChunksRef.current = false;
      }
    });

    const unsubMessage = wsClient.on("chat.message", (msg) => {
      const data = msg.data as ChatMessage | undefined;
      if (data && data.sessionId === sessionId) {
        // Skip adding assistant message - it will be added by streaming.end
        if (data.role === "assistant") {
          // Always skip assistant messages here - they are handled by streaming.end
          // This prevents race conditions where chat.message arrives and sets loading=false
          // before streaming.start can set it back to true
          return;
        }
        setMessages((prev) => {
          // Avoid duplicates
          if (prev.some((m) => m.id === data.id)) {
            return prev;
          }
          // Add message and sort by createdAt to ensure correct order
          const updated = [...prev, data];
          return updated.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        });
      }
    });

    return () => {
      unsubStart();
      unsubChunk();
      unsubEnd();
      unsubMessage();
    };
  }, [sessionId]);

  // Check if scrolled to bottom
  const checkIfAtBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const threshold = 50; // pixels from bottom to consider "at bottom"
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }, []);

  // Handle scroll events
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const atBottom = checkIfAtBottom();
    setIsAtBottom(atBottom);
    if (atBottom) {
      setHasNewMessages(false);
    }

    // Load older messages when scrolled near top
    const scrollTop = container.scrollTop;
    if (scrollTop < 100 && hasMoreMessages && !loadingOlder) {
      loadOlderMessages();
    }
  }, [checkIfAtBottom, hasMoreMessages, loadingOlder, loadOlderMessages]);

  // Auto scroll to bottom only if already at bottom
  useEffect(() => {
    if (isAtBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    } else if (messages.length > 0 || streamingChunks.length > 0) {
      setHasNewMessages(true);
    }
  }, [messages, streamingChunks, isAtBottom]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setHasNewMessages(false);
    setIsAtBottom(true);
  }, []);

  // Build execute mode context
  const buildExecuteContext = (): string | undefined => {
    if (!executeMode || !executeContext) return undefined;
    const lines = [
      `## Execute Mode - Task ${executeContext.taskIndex + 1}/${executeContext.totalTasks}`,
      "",
      "### 全タスク一覧:",
    ];

    // Add all tasks with their instructions
    executeContext.allTasks.forEach((task, i) => {
      const isCurrent = i === executeContext.taskIndex;
      const marker = isCurrent ? "→ " : "  ";
      const status = i < executeContext.taskIndex ? "[完了]" : isCurrent ? "[実行中]" : "[未実行]";
      lines.push(`${marker}${i + 1}. ${task.branchName} ${status}`);
      if (task.instruction) {
        // Add instruction preview (truncated for non-current tasks)
        const preview = isCurrent
          ? task.instruction
          : task.instruction.length > 100
            ? task.instruction.slice(0, 100) + "..."
            : task.instruction;
        if (isCurrent) {
          lines.push("", "### 現在のタスク Instruction:", preview);
        }
      }
    });

    return lines.join("\n");
  };

  // Send message (allowed during loading for interruption)
  const sendMessage = async () => {
    if (!input.trim()) return;

    const userMessage = input.trim();
    setInput("");
    const wasAlreadyStreaming = isStreaming;

    // If sending during streaming, clear chunks (backend will send streaming.end with the interrupted message)
    if (wasAlreadyStreaming && streamingChunks.length > 0) {
      setStreamingChunks([]);
      streamingChunksRef.current = [];
      hasStreamingChunksRef.current = false;
    }

    // Set local sending state (will be cleared when streaming starts)
    setIsSending(true);
    setError(null);

    // Optimistic update with temp user message
    const tempId = Date.now();
    const tempUserMsg: ChatMessage = {
      id: tempId,
      sessionId,
      role: "user",
      content: userMessage,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      // Build context for execute mode
      const context = buildExecuteContext();
      const chatMode = executeMode ? "execution" : undefined;
      // API returns immediately, assistant message comes via WebSocket
      const result = await api.sendChatMessage(sessionId, userMessage, context, chatMode, quickMode);
      // Replace temp message with real one
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? result.userMessage : m))
      );
      // If queued (sent during execution), don't change loading state
      // Loading will be set to false when assistant message arrives via WebSocket
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setIsSending(false);
      inputRef.current?.focus();
    }
  };

  // Send answer to AskUserQuestion
  const sendQuestionAnswer = async (answer: string) => {
    if (loading) return;

    setIsSending(true);
    setError(null);

    // Add user answer as a message
    const tempId = Date.now();
    const tempUserMsg: ChatMessage = {
      id: tempId,
      sessionId,
      role: "user",
      content: answer,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const context = buildExecuteContext();
      const chatMode = executeMode ? "execution" : undefined;
      const result = await api.sendChatMessage(sessionId, answer, context, chatMode, quickMode);
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? result.userMessage : m))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send answer");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setIsSending(false);
    }
  };

  // Cancel current chat execution
  const handleCancel = async () => {
    console.log("[ChatPanel] Cancel clicked");
    try {
      await api.cancelChat(sessionId);
      console.log("[ChatPanel] Cancel API called successfully");
    } catch (err) {
      console.error("[ChatPanel] Failed to cancel:", err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // ⌘+Enter / Ctrl+Enter to send (allowed during loading)
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleAddTask = (task: TaskSuggestion, index: number) => {
    const key = `${task.label}-${index}`;
    if (addedTasks.has(key)) return;
    setAddedTasks((prev) => new Set(prev).add(key));
    onTaskSuggested?.(task);
  };

  // Parse chunks from saved message content
  const parseChunks = (content: string): StreamingChunk[] | null => {
    try {
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.chunks)) {
        return parsed.chunks;
      }
    } catch {
      // Not JSON, return null
    }
    return null;
  };

  // Render a single chunk (used for both streaming and saved chunks)
  const renderChunk = (chunk: StreamingChunk, index: number, isFirst: boolean) => {
    // Hide AskUserQuestion tool_use (handled by dedicated UI)
    if (chunk.type === "tool_use" && chunk.toolName === "AskUserQuestion") {
      return null;
    }
    const isToolChunk = chunk.type === "tool_use" || chunk.type === "tool_result";
    return (
      <div key={`chunk-${index}`} style={{ display: "flex", justifyContent: "flex-start" }}>
        {isToolChunk ? (
          <div style={{ maxWidth: "90%" }}>
            {chunk.type === "tool_use" && (
              <div style={{
                background: "#1e3a5f",
                border: "1px solid #3b82f6",
                borderRadius: 8,
                padding: 10,
              }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: "#93c5fd", marginBottom: 6 }}>
                  🔧 {chunk.toolName}
                </div>
                {chunk.toolInput && (
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 13, color: "#e0f2fe" }}>
                    {(() => {
                      const input = chunk.toolInput!;
                      if (input.command) return `$ ${input.command}`;
                      if (input.pattern) return `🔍 ${input.pattern}`;
                      if (input.file_path && input.old_string !== undefined) {
                        return `📝 ${input.file_path}`;
                      }
                      if (input.file_path) return `📄 ${input.file_path}`;
                      return JSON.stringify(input, null, 2);
                    })()}
                  </pre>
                )}
              </div>
            )}
            {chunk.type === "tool_result" && (
              <div style={{
                background: "#14532d",
                border: "1px solid #22c55e",
                borderRadius: 8,
                padding: 10,
                fontSize: 13,
                color: "#bbf7d0",
              }}>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                  {chunk.content}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <div style={{
            maxWidth: "80%",
            borderRadius: 12,
            padding: 12,
            background: "#374151",
            color: "#f3f4f6",
            fontSize: 13,
            lineHeight: 1.5,
          }}>
            {isFirst && (
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 8, fontWeight: 500 }}>
                ASSISTANT
              </div>
            )}
            {(chunk.type === "thinking" || chunk.type === "thinking_delta") && (
              <div style={{ color: "#a78bfa" }}>
                <div style={{ fontWeight: 500, marginBottom: 4, fontSize: 12 }}>💭 Thinking</div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", opacity: 0.8, fontSize: 12 }}>{chunk.content}</pre>
              </div>
            )}
            {(chunk.type === "text" || chunk.type === "text_delta") && (() => {
              // Remove task tags and clean up leftover separators
              // Note: Instruction/ToDo/Question tags are no longer used (handled via MCP tools)
              const cleaned = removeTaskTags(chunk.content || "")
                .replace(/\n---\n*$/g, "") // Remove trailing ---
                .replace(/^\n*---\n/g, "") // Remove leading ---
                .trim();
              if (!cleaned) return null;
              return (
                <div className="chat-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    );
  };

  const renderMessage = (msg: ChatMessage) => {
    if (msg.role !== "assistant") {
      return <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{msg.content}</p>;
    }

    // Check if content is chunks JSON
    const chunks = parseChunks(msg.content);
    if (chunks) {
      // This will be handled separately in the messages list
      return null;
    }

    // Note: Instruction edits are now handled via MCP tools, not tag parsing
    const suggestions = extractTaskSuggestions(msg.content);
    const cleanContent = removeTaskTags(msg.content);

    return (
      <>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{cleanContent}</p>

        {/* Task Suggestions */}
        {suggestions.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {suggestions.map((task, i) => {
              const key = `${task.label}-${i}`;
              const isAlreadyExisting = existingTaskLabels.includes(task.label);
              const isAdded = addedTasks.has(key) || isAlreadyExisting;
              return (
                <div
                  key={i}
                  style={{
                    border: "1px solid #374151",
                    background: "#1f2937",
                    borderRadius: 6,
                    padding: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {task.parentLabel && (
                        <p style={{ margin: "0 0 4px", fontSize: 11, color: "#a78bfa" }}>
                          ↳ {task.parentLabel}
                        </p>
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <p style={{ margin: 0, fontWeight: 500, color: "#f3f4f6" }}>{task.label}</p>
                        {task.issueUrl && (
                          <a
                            href={task.issueUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: "flex", alignItems: "center" }}
                            title={task.issueUrl}
                          >
                            <img src={githubIcon} alt="GitHub Issue" style={{ width: 14, height: 14, opacity: 0.7 }} />
                          </a>
                        )}
                      </div>
                      {task.branchName && (
                        <p style={{ margin: "2px 0 0", fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>
                          {task.branchName}
                        </p>
                      )}
                      {task.description && (
                        <p style={{ margin: "4px 0 0", fontSize: 13, color: "#9ca3af" }}>{task.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleAddTask(task, i)}
                      disabled={isAdded}
                      style={{
                        flexShrink: 0,
                        padding: "4px 12px",
                        borderRadius: 4,
                        fontSize: 13,
                        fontWeight: 500,
                        border: "none",
                        cursor: isAdded ? "default" : "pointer",
                        background: isAdded ? "#14532d" : "#3b82f6",
                        color: isAdded ? "#4ade80" : "white",
                      }}
                    >
                      {isAdded ? "Added" : "+ Add"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  };

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      background: "#111827",
      overflow: "hidden",
      position: "relative",
    }}>
      {/* Messages */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          position: "relative",
        }}
      >
        {/* Loading indicator for older messages */}
        {loadingOlder && (
          <div style={{ textAlign: "center", padding: 8, color: "#9ca3af", fontSize: 12 }}>
            Loading older messages...
          </div>
        )}
        {!hasMoreMessages && messages.length > 0 && (
          <div style={{ textAlign: "center", padding: 8, color: "#6b7280", fontSize: 11 }}>
            — Beginning of conversation —
          </div>
        )}
        {messages.map((msg) => {
          // Check if assistant message has chunks
          if (msg.role === "assistant") {
            const chunks = parseChunks(msg.content);
            if (chunks) {
              // Extract text content from chunks for task suggestions
              // Note: Instruction edits are now handled via MCP tools, not tag parsing
              const textContent = chunks
                .filter(c => c.type === "text" || c.type === "text_delta")
                .map(c => c.content || "")
                .join("");
              const suggestions = extractTaskSuggestions(textContent);

              // Render chunks separately with task suggestions at the end
              return (
                <div key={msg.id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {chunks.map((chunk, i) => renderChunk(chunk, i, i === 0))}

                  {/* Task Suggestions from chunks */}
                  {suggestions.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {suggestions.map((task, i) => {
                        const key = `${msg.id}-${task.label}-${i}`;
                        const isAlreadyExisting = existingTaskLabels.includes(task.label);
                        const isAdded = addedTasks.has(key) || isAlreadyExisting;
                        return (
                          <div
                            key={i}
                            style={{
                              border: "1px solid #374151",
                              background: "#1f2937",
                              borderRadius: 6,
                              padding: 12,
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                {task.parentLabel && (
                                  <p style={{ margin: "0 0 4px", fontSize: 11, color: "#a78bfa" }}>
                                    ↳ {task.parentLabel}
                                  </p>
                                )}
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <p style={{ margin: 0, fontWeight: 500, color: "#f3f4f6" }}>{task.label}</p>
                                  {task.issueUrl && (
                                    <a
                                      href={task.issueUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      style={{ display: "flex", alignItems: "center" }}
                                      title={task.issueUrl}
                                    >
                                      <img src={githubIcon} alt="GitHub Issue" style={{ width: 14, height: 14, opacity: 0.7 }} />
                                    </a>
                                  )}
                                </div>
                                {task.branchName && (
                                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>
                                    {task.branchName}
                                  </p>
                                )}
                                {task.description && (
                                  <p style={{ margin: "4px 0 0", fontSize: 13, color: "#9ca3af" }}>{task.description}</p>
                                )}
                              </div>
                              <button
                                onClick={() => {
                                  if (isAdded) return;
                                  setAddedTasks((prev) => new Set(prev).add(key));
                                  onTaskSuggested?.(task);
                                }}
                                disabled={isAdded}
                                style={{
                                  flexShrink: 0,
                                  padding: "4px 12px",
                                  borderRadius: 4,
                                  fontSize: 13,
                                  fontWeight: 500,
                                  border: "none",
                                  cursor: isAdded ? "default" : "pointer",
                                  background: isAdded ? "#14532d" : "#3b82f6",
                                  color: isAdded ? "#4ade80" : "white",
                                }}
                              >
                                {isAdded ? "Added" : "+ Add"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
          }

          return (
            <div
              key={msg.id}
              style={{
                display: "flex",
                justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  maxWidth: "80%",
                  borderRadius: 12,
                  padding: 12,
                  background: msg.role === "user" ? "#3b82f6" : "#374151",
                  color: "#f3f4f6",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {renderMessage(msg)}
              </div>
            </div>
          );
        })}

        {/* Streaming chunks - each chunk as separate block */}
        {streamingChunks.map((chunk, i) => renderChunk(chunk, i, i === 0))}

        {/* Note: Instruction edits are now handled via MCP tools, not tag parsing */}

        {/* AskUserQuestion UI - only show for unanswered questions */}
        {(() => {
          // First, check streaming chunks for AskUserQuestion tool_use (only when not loading)
          if (!loading) {
            const askFromStreaming = extractAskUserQuestion(streamingChunks);
            if (askFromStreaming) {
              return (
                <AskUserQuestionUI
                  data={askFromStreaming}
                  onSubmit={sendQuestionAnswer}
                  disabled={false}
                />
              );
            }
          }

          // Find the most recent assistant message with AskUserQuestion
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === "assistant") {
              const chunks = parseChunks(msg.content);
              if (chunks) {
                const askFromMessage = extractAskUserQuestion(chunks);
                if (askFromMessage) {
                  // Check if there's a newer assistant message (meaning this question is done)
                  const hasNewerAssistant = messages.slice(i + 1).some(m => m.role === "assistant");
                  if (hasNewerAssistant) {
                    return null; // Don't show old questions
                  }
                  // Check if user has already answered (any message after this one)
                  const hasAnswered = i < messages.length - 1;
                  if (hasAnswered) {
                    return null; // Don't show answered questions
                  }
                  return (
                    <AskUserQuestionUI
                      data={askFromMessage}
                      onSubmit={sendQuestionAnswer}
                      disabled={loading}
                    />
                  );
                }
              }
            }
          }

          return null;
        })()}

        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{
              borderRadius: 12,
              padding: 12,
              background: "#374151",
              color: "#9ca3af",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}>
              <span className="chat-dots">
                <span></span><span></span><span></span>
              </span>
              <span>Thinking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to bottom button */}
      {hasNewMessages && !isAtBottom && (
        <button
          onClick={scrollToBottom}
          style={{
            position: "absolute",
            bottom: 140,
            right: 24,
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: "#3b82f6",
            border: "none",
            color: "white",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            zIndex: 10,
            fontSize: 18,
          }}
          title="Scroll to bottom"
        >
          ↓
        </button>
      )}

      {/* Error */}
      {error && (
        <div style={{
          padding: "8px 16px",
          background: "#7f1d1d",
          borderTop: "1px solid #991b1b",
          color: "#fca5a5",
          fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* Input */}
      <div style={{
        borderTop: "1px solid #374151",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}>
        {/* Quick mode toggle and context stats */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}>
          <label style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
            fontSize: 12,
            color: quickMode ? "#60a5fa" : "#9ca3af",
          }}>
            <div
              onClick={() => setQuickMode(!quickMode)}
              style={{
                width: 32,
                height: 18,
                borderRadius: 9,
                background: quickMode ? "#3b82f6" : "#4b5563",
                position: "relative",
                transition: "background 0.2s",
                cursor: "pointer",
              }}
            >
              <div style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                background: "#fff",
                position: "absolute",
                top: 2,
                left: quickMode ? 16 : 2,
                transition: "left 0.2s",
              }} />
            </div>
            Quick (Haiku)
          </label>
          {/* Context stats badge */}
          {contextStats && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: "#9ca3af",
              }}
              title={`Messages: ${contextStats.messageCount}\nSummaries: ${contextStats.summaryCount}\nArtifacts: ${contextStats.artifactCount}\nTokens: ~${contextStats.totalRawTokens.toLocaleString()}`}
            >
              <span style={{
                padding: "2px 6px",
                background: contextStats.summaryCount > 0 ? "#065f46" : "#374151",
                borderRadius: 4,
                color: contextStats.summaryCount > 0 ? "#34d399" : "#9ca3af",
              }}>
                {contextStats.summaryCount > 0 ? `${contextStats.summaryCount} summary` : "No summary"}
              </span>
              <span style={{
                padding: "2px 6px",
                background: "#374151",
                borderRadius: 4,
              }}>
                ~{Math.round(contextStats.totalRawTokens / 1000)}k tokens
              </span>
            </div>
          )}
        </div>
        {/* Resize handle at top of textarea */}
        <div
          onMouseDown={handleTextareaResizeStart}
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            height: 12,
            background: isResizingTextarea ? "#1e3a5f" : "#111827",
            cursor: "ns-resize",
            borderRadius: "4px 4px 0 0",
            border: "1px solid #374151",
            borderBottom: "none",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#1e3a5f")}
          onMouseLeave={(e) => {
            if (!isResizingTextarea) e.currentTarget.style.background = "#111827";
          }}
          title="Drag to resize"
        >
          {/* Grip indicator */}
          <div style={{
            width: 32,
            height: 4,
            borderRadius: 2,
            background: "#4b5563",
          }} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (⌘+Enter to send)"
            style={{
              flex: 1,
              resize: "none",
              border: "1px solid #374151",
              borderTop: "none",
              borderRadius: "0 0 4px 4px",
              padding: "8px 12px",
              fontSize: 14,
              fontFamily: "inherit",
              outline: "none",
              background: "#1f2937",
              color: "#f3f4f6",
              height: textareaHeight,
              minHeight: 60,
              maxHeight: 500,
            }}
            disabled={disabled}
          />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, alignSelf: "flex-end", minWidth: 52 }}>
            {loading && (
              <button
                onClick={handleCancel}
                style={{
                  fontSize: 10,
                  color: "#f87171",
                  background: "transparent",
                  border: "1px solid #f87171",
                  borderRadius: 4,
                  padding: "2px 6px",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  lineHeight: 1.2,
                }}
              >
                <span>Cancel</span>
                <span>(Esc)</span>
              </button>
            )}
            <button
              onClick={sendMessage}
              disabled={!input.trim() || disabled}
              style={{
                padding: "12px 16px",
                background: !input.trim() || disabled ? "#4b5563" : "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: !input.trim() || disabled ? "not-allowed" : "pointer",
                fontWeight: 500,
                fontSize: 13,
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .chat-dots {
          display: flex;
          gap: 4px;
        }
        .chat-dots span {
          width: 6px;
          height: 6px;
          background: #9ca3af;
          border-radius: 50%;
          animation: chat-bounce 1.4s infinite ease-in-out both;
        }
        .chat-dots span:nth-child(1) { animation-delay: -0.32s; }
        .chat-dots span:nth-child(2) { animation-delay: -0.16s; }
        @keyframes chat-bounce {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }
        .chat-markdown {
          font-size: 13px;
          line-height: 1.6;
        }
        .chat-markdown p {
          margin: 0 0 8px;
        }
        .chat-markdown p:last-child {
          margin-bottom: 0;
        }
        .chat-markdown ul, .chat-markdown ol {
          margin: 8px 0;
          padding-left: 20px;
        }
        .chat-markdown li {
          margin: 4px 0;
        }
        .chat-markdown code {
          background: #1f2937;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 12px;
        }
        .chat-markdown pre {
          background: #1f2937;
          padding: 12px;
          border-radius: 6px;
          overflow-x: auto;
          margin: 8px 0;
        }
        .chat-markdown pre code {
          background: none;
          padding: 0;
        }
        .chat-markdown table {
          border-collapse: collapse;
          margin: 8px 0;
          font-size: 12px;
        }
        .chat-markdown th, .chat-markdown td {
          border: 1px solid #4b5563;
          padding: 6px 10px;
          text-align: left;
        }
        .chat-markdown th {
          background: #1f2937;
          font-weight: 600;
        }
        .chat-markdown strong {
          font-weight: 600;
          color: #f9fafb;
        }
        .chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
          margin: 12px 0 8px;
          font-weight: 600;
        }
        .chat-markdown h1 { font-size: 18px; }
        .chat-markdown h2 { font-size: 16px; }
        .chat-markdown h3 { font-size: 14px; }
        .chat-markdown hr {
          margin: 16px 0;
          border: none;
          border-top: 1px solid #4b5563;
        }
      `}</style>
    </div>
  );
}
