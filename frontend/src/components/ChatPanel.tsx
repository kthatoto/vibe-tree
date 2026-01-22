import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ChatMessage } from "../lib/api";
import { extractTaskSuggestions, removeTaskTags, type TaskSuggestion } from "../lib/task-parser";
import {
  extractInstructionEdit,
  removeInstructionEditTags,
  computeSimpleDiff,
} from "../lib/instruction-parser";
import { wsClient } from "../lib/ws";
import githubIcon from "../assets/github.svg";

interface ExecuteContext {
  branchName: string;
  instruction: string | null;
  taskIndex: number;
  totalTasks: number;
}

interface ChatPanelProps {
  sessionId: string;
  onTaskSuggested?: (task: TaskSuggestion) => void;
  existingTaskLabels?: string[];
  disabled?: boolean;
  currentInstruction?: string;
  onInstructionUpdated?: (newContent: string) => void;
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
  currentInstruction = "",
  onInstructionUpdated,
  executeMode = false,
  executeContext,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedTasks, setAddedTasks] = useState<Set<string>>(new Set());
  // Track accepted instruction edits by message ID
  const [acceptedInstructions, setAcceptedInstructions] = useState<Set<number>>(new Set());
  // Streaming state
  const [streamingChunks, setStreamingChunks] = useState<StreamingChunk[]>([]);
  const hasStreamingChunksRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load messages
  const loadMessages = useCallback(async () => {
    try {
      const msgs = await api.getChatMessages(sessionId);
      setMessages(msgs);
      setStreamingChunks([]);
      hasStreamingChunksRef.current = false;
      // If last message is from user, AI is still generating response
      if (msgs.length > 0 && msgs[msgs.length - 1].role === "user") {
        setLoading(true);
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [sessionId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Listen for WebSocket streaming events
  useEffect(() => {
    const unsubStart = wsClient.on("chat.streaming.start", (msg) => {
      const data = msg.data as { sessionId: string };
      if (data.sessionId === sessionId) {
        setStreamingChunks([]);
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
      if (data.sessionId === sessionId) {
        // Add the message to messages list and clear streaming chunks
        if (data.message) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === data.message!.id)) {
              return prev;
            }
            return [...prev, data.message!];
          });
        }
        setStreamingChunks([]);
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
    if (messages.length > 0 || streamingChunks.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages, streamingChunks]);

  // Build execute mode context
  const buildExecuteContext = (): string | undefined => {
    if (!executeMode || !executeContext) return undefined;
    const lines = [
      `## Execute Mode - Task ${executeContext.taskIndex + 1}/${executeContext.totalTasks}`,
      `**Branch:** ${executeContext.branchName}`,
    ];
    if (executeContext.instruction) {
      lines.push("", "### Task Instruction:", executeContext.instruction);
    }
    return lines.join("\n");
  };

  // Send message
  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    setLoading(true);
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
      const result = await api.sendChatMessage(sessionId, userMessage, context, chatMode);
      // Replace temp message with real one
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? result.userMessage : m))
      );
      // Loading will be set to false when assistant message arrives via WebSocket
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

  const handleAcceptInstruction = (msgId: number, newContent: string) => {
    if (acceptedInstructions.has(msgId)) return;
    setAcceptedInstructions((prev) => new Set(prev).add(msgId));
    onInstructionUpdated?.(newContent);
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

    const suggestions = extractTaskSuggestions(msg.content);
    const instructionEdit = extractInstructionEdit(msg.content);
    let cleanContent = removeTaskTags(msg.content);
    if (instructionEdit) {
      cleanContent = removeInstructionEditTags(cleanContent);
    }

    const isInstructionAccepted = acceptedInstructions.has(msg.id);

    return (
      <>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{cleanContent}</p>

        {/* Instruction Edit Proposal */}
        {instructionEdit && (
          <div style={{
            marginTop: 12,
            border: "1px solid #374151",
            background: "#1f2937",
            borderRadius: 6,
            overflow: "hidden",
          }}>
            <div style={{
              padding: "8px 12px",
              background: "#0f172a",
              borderBottom: "1px solid #374151",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "#9ca3af" }}>
                Task Instruction の変更提案
              </span>
              {isInstructionAccepted && (
                <span style={{ fontSize: 11, padding: "2px 8px", background: "#14532d", color: "#4ade80", borderRadius: 3 }}>
                  Accepted
                </span>
              )}
            </div>
            <div style={{ padding: 12, fontSize: 12, fontFamily: "monospace" }}>
              {computeSimpleDiff(currentInstruction, instructionEdit.newContent).map((line, i) => (
                <div
                  key={i}
                  style={{
                    padding: "1px 4px",
                    background: line.type === "added" ? "rgba(34, 197, 94, 0.15)" :
                               line.type === "removed" ? "rgba(239, 68, 68, 0.15)" : "transparent",
                    color: line.type === "added" ? "#4ade80" :
                           line.type === "removed" ? "#f87171" : "#9ca3af",
                  }}
                >
                  <span style={{ display: "inline-block", width: 16, opacity: 0.6 }}>
                    {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                  </span>
                  {line.content || " "}
                </div>
              ))}
            </div>
            {!isInstructionAccepted && (
              <div style={{
                padding: "8px 12px",
                borderTop: "1px solid #374151",
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}>
                <button
                  onClick={() => handleAcceptInstruction(msg.id, instructionEdit.newContent)}
                  style={{
                    padding: "4px 12px",
                    background: "#22c55e",
                    color: "#fff",
                    border: "none",
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  Accept
                </button>
              </div>
            )}
          </div>
        )}

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
        gap: 8,
      }}>
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
        <button
          onClick={sendMessage}
          disabled={!input.trim() || loading || disabled}
          style={{
            padding: "12px 16px",
            background: !input.trim() || loading || disabled ? "#4b5563" : "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: 4,
            cursor: !input.trim() || loading || disabled ? "not-allowed" : "pointer",
            fontWeight: 500,
            fontSize: 13,
            alignSelf: "flex-end",
          }}
        >
          Send
        </button>
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
      `}</style>
    </div>
  );
}
