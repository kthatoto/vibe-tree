import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ChatMessage } from "../lib/api";
import { extractTaskSuggestions, removeTaskTags, type TaskSuggestion } from "../lib/task-parser";
import { extractAskUserQuestion } from "../lib/ask-user-question";
import { AskUserQuestionUI } from "./AskUserQuestionUI";
import { wsClient } from "../lib/ws";
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedTasks, setAddedTasks] = useState<Set<string>>(new Set());
  // Streaming state
  const [streamingChunks, setStreamingChunks] = useState<StreamingChunk[]>([]);
  const streamingChunksRef = useRef<StreamingChunk[]>([]);
  const hasStreamingChunksRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Quick mode (use haiku for faster responses)
  const [quickMode, setQuickMode] = useState(false);

  // Refs for callbacks to avoid stale closures in WebSocket handlers
  const executeContextRef = useRef(executeContext);

  // Keep refs up to date
  useEffect(() => {
    executeContextRef.current = executeContext;
  }, [executeContext]);

  // Load messages and restore streaming state if active
  const loadMessages = useCallback(async () => {
    try {
      const [msgs, streamingState] = await Promise.all([
        api.getChatMessages(sessionId),
        api.getStreamingState(sessionId),
      ]);
      setMessages(msgs);

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

      // Restore streaming state if there's an active stream
      if (streamingState.isStreaming && streamingState.chunks.length > 0) {
        const restoredChunks: StreamingChunk[] = streamingState.chunks.map((chunk) => ({
          type: chunk.type as StreamingChunk["type"],
          content: chunk.content,
          toolName: chunk.toolName,
          toolInput: chunk.toolInput as Record<string, unknown> | undefined,
        }));
        setStreamingChunks(restoredChunks);
        hasStreamingChunksRef.current = true;
        setLoading(true);
      } else if (isStillStreaming) {
        // Last message has streaming flag but no active streaming state
        // This means the process crashed or was cancelled without cleanup
        // Don't set loading=true, treat as complete
        setStreamingChunks([]);
        hasStreamingChunksRef.current = false;
        setLoading(false);
      } else {
        setStreamingChunks([]);
        hasStreamingChunksRef.current = false;
        // If last message is from user and no streaming state, AI might still be starting
        if (msgs.length > 0 && msgs[msgs.length - 1].role === "user") {
          setLoading(true);
        }
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [sessionId]);

  // Clear state immediately when sessionId changes (before loading new data)
  useEffect(() => {
    setMessages([]);
    setStreamingChunks([]);
    hasStreamingChunksRef.current = false;
    setLoading(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Cancel execution on Escape key (document-level listener)
  useEffect(() => {
    const handleEscapeKey = async (e: KeyboardEvent) => {
      if (e.key === "Escape" && loading) {
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
  }, [sessionId, loading]);

  // Sync streamingChunksRef with streamingChunks state
  useEffect(() => {
    streamingChunksRef.current = streamingChunks;
  }, [streamingChunks]);

  // Listen for WebSocket streaming events
  useEffect(() => {
    const unsubStart = wsClient.on("chat.streaming.start", (msg) => {
      const data = msg.data as { sessionId: string };
      if (data.sessionId === sessionId) {
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
      const data = msg.data as { sessionId: string; message?: ChatMessage };
      console.log(`[ChatPanel] streaming.end received, msgSessionId=${data.sessionId}, currentSessionId=${sessionId}, match=${data.sessionId === sessionId}`);
      if (data.sessionId === sessionId) {
        console.log(`[ChatPanel] streaming.end: Setting loading=false, message=${!!data.message}`);

        // Add the message to messages list and clear streaming chunks
        // Note: Instruction/ToDo/Question updates are now handled via MCP tools and WebSocket broadcasts
        if (data.message) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === data.message!.id)) {
              return prev;
            }
            return [...prev, data.message!];
          });
        }
        setStreamingChunks([]);
        streamingChunksRef.current = [];
        hasStreamingChunksRef.current = false;
        setLoading(false);
      }
    });

    const unsubMessage = wsClient.on("chat.message", (msg) => {
      const data = msg.data as ChatMessage | undefined;
      if (data && data.sessionId === sessionId) {
        // Skip adding assistant message - it will be added by streaming.end
        if (data.role === "assistant" && hasStreamingChunksRef.current) {
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
          setLoading(false);
        }
      }
    });

    return () => {
      unsubStart();
      unsubChunk();
      unsubEnd();
      unsubMessage();
    };
  }, [sessionId]);

  // Auto scroll to bottom
  useEffect(() => {
    if (messages.length > 0 || streamingChunks.length > 0 || !loading) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages, streamingChunks, loading]);

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
    const wasAlreadyLoading = loading;

    // If sending during streaming, convert current streaming chunks to a message first
    if (wasAlreadyLoading && streamingChunks.length > 0) {
      // Create an interrupted assistant message from streaming chunks
      const interruptedMsg: ChatMessage = {
        id: Date.now() - 1, // Temporary ID, will be replaced by actual message from server
        sessionId,
        role: "assistant",
        content: JSON.stringify({ chunks: streamingChunks, interrupted: true }),
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, interruptedMsg]);
      setStreamingChunks([]);
      hasStreamingChunksRef.current = false;
    }

    if (!wasAlreadyLoading) {
      setLoading(true);
    }
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
      if (!wasAlreadyLoading) {
        setLoading(false);
      }
      inputRef.current?.focus();
    }
  };

  // Send answer to AskUserQuestion
  const sendQuestionAnswer = async (answer: string) => {
    if (loading) return;

    setLoading(true);
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
      setLoading(false);
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
    }}>
      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}>
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
        {/* Quick mode toggle */}
        <div style={{
          display: "flex",
          alignItems: "center",
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
              borderRadius: 4,
              padding: "8px 12px",
              fontSize: 14,
              fontFamily: "inherit",
              outline: "none",
              background: "#1f2937",
              color: "#f3f4f6",
              minHeight: 80,
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
