import { useState, useEffect, useRef, useCallback } from "react";
import { api, type ChatMessage } from "../lib/api";
import { extractTaskSuggestions, removeTaskTags, type TaskSuggestion } from "../lib/task-parser";

interface ChatPanelProps {
  sessionId: string;
  onTaskSuggested?: (task: TaskSuggestion) => void;
  existingTaskLabels?: string[];
  disabled?: boolean;
}

export function ChatPanel({ sessionId, onTaskSuggested, existingTaskLabels = [], disabled = false }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedTasks, setAddedTasks] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load messages
  const loadMessages = useCallback(async () => {
    try {
      const msgs = await api.getChatMessages(sessionId);
      setMessages(msgs);
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [sessionId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Auto scroll to bottom
  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages]);

  // Send message
  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    setLoading(true);
    setError(null);

    // Optimistic update
    const tempUserMsg: ChatMessage = {
      id: Date.now(),
      sessionId,
      role: "user",
      content: userMessage,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const result = await api.sendChatMessage(sessionId, userMessage);
      setMessages((prev) => [
        ...prev.slice(0, -1),
        result.userMessage,
        result.assistantMessage,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      setMessages((prev) => prev.slice(0, -1));
    } finally {
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

  const renderMessage = (msg: ChatMessage) => {
    if (msg.role !== "assistant") {
      return <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{msg.content}</p>;
    }

    const suggestions = extractTaskSuggestions(msg.content);
    const cleanContent = removeTaskTags(msg.content);

    return (
      <>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{cleanContent}</p>
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
                      <p style={{ margin: 0, fontWeight: 500, color: "#f3f4f6" }}>{task.label}</p>
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
        {messages.map((msg) => (
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
        ))}

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
      `}</style>
    </div>
  );
}
