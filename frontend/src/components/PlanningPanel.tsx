import { useState, useEffect, useCallback } from "react";
import {
  api,
  type PlanningSession,
  type TaskNode,
  type TaskEdge,
  type ExternalLink,
  type ChatMessage,
} from "../lib/api";
import { wsClient } from "../lib/ws";
import { ChatPanel } from "./ChatPanel";
import type { TaskSuggestion } from "../lib/task-parser";
import "./PlanningPanel.css";

interface PlanningPanelProps {
  repoId: string;
  branches: string[];
  defaultBranch: string;
  onTasksChange?: (nodes: TaskNode[], edges: TaskEdge[]) => void;
  onSessionSelect?: (session: PlanningSession | null) => void;
}

export function PlanningPanel({
  repoId,
  branches,
  defaultBranch,
  onTasksChange,
  onSessionSelect,
}: PlanningPanelProps) {
  const [sessions, setSessions] = useState<PlanningSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<PlanningSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New session form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBaseBranch, setNewBaseBranch] = useState(defaultBranch);

  // External links for selected session
  const [externalLinks, setExternalLinks] = useState<ExternalLink[]>([]);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [addingLink, setAddingLink] = useState(false);

  // Chat messages for selected session
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  // Load sessions
  useEffect(() => {
    if (!repoId) return;
    setLoading(true);
    api.getPlanningSessions(repoId)
      .then((data) => {
        setSessions(data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repoId]);

  // WebSocket updates
  useEffect(() => {
    if (!repoId) return;

    const unsubCreated = wsClient.on("planning.created", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const newSession = msg.data as PlanningSession;
        // Check for duplicates before adding
        setSessions((prev) => {
          if (prev.some((s) => s.id === newSession.id)) {
            return prev;
          }
          return [newSession, ...prev];
        });
      }
    });

    const unsubUpdated = wsClient.on("planning.updated", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const updated = msg.data as PlanningSession;
        setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        if (selectedSession?.id === updated.id) {
          setSelectedSession(updated);
          onSessionSelect?.(updated);
          onTasksChange?.(updated.nodes, updated.edges);
        }
      }
    });

    const unsubDeleted = wsClient.on("planning.deleted", (msg) => {
      if (msg.data && typeof msg.data === "object" && "id" in msg.data) {
        const deleted = msg.data as { id: string };
        setSessions((prev) => prev.filter((s) => s.id !== deleted.id));
        if (selectedSession?.id === deleted.id) {
          setSelectedSession(null);
          onSessionSelect?.(null);
        }
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
    };
  }, [repoId, selectedSession?.id]);

  // Load external links when session changes
  useEffect(() => {
    if (!selectedSession) {
      setExternalLinks([]);
      return;
    }
    api.getExternalLinks(selectedSession.id)
      .then(setExternalLinks)
      .catch(console.error);
  }, [selectedSession?.id]);

  // Load chat messages when session changes
  useEffect(() => {
    if (!selectedSession?.chatSessionId) {
      setMessages([]);
      return;
    }
    setMessagesLoading(true);
    api.getChatMessages(selectedSession.chatSessionId)
      .then(setMessages)
      .catch(console.error)
      .finally(() => setMessagesLoading(false));
  }, [selectedSession?.chatSessionId]);

  // Notify parent of task changes
  useEffect(() => {
    if (selectedSession) {
      onTasksChange?.(selectedSession.nodes, selectedSession.edges);
    }
  }, [selectedSession?.nodes, selectedSession?.edges]);

  const handleCreateSession = async () => {
    if (!newBaseBranch.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const session = await api.createPlanningSession(
        repoId,
        newBaseBranch.trim(),
        newTitle.trim() || undefined
      );
      setSessions((prev) => [session, ...prev]);
      setSelectedSession(session);
      onSessionSelect?.(session);
      setShowNewForm(false);
      setNewTitle("");
      setNewBaseBranch(defaultBranch);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleSelectSession = (session: PlanningSession) => {
    setSelectedSession(session);
    onSessionSelect?.(session);
  };

  const handleUpdateTitle = async (title: string) => {
    if (!selectedSession) return;
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, { title });
      setSelectedSession(updated);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      console.error("Failed to update title:", err);
    }
  };

  const handleUpdateBaseBranch = async (baseBranch: string) => {
    if (!selectedSession) return;
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, { baseBranch });
      setSelectedSession(updated);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      console.error("Failed to update base branch:", err);
    }
  };

  const handleConfirm = async () => {
    if (!selectedSession) return;
    if (selectedSession.nodes.length === 0) {
      setError("No tasks to confirm");
      return;
    }
    setLoading(true);
    try {
      const updated = await api.confirmPlanningSession(selectedSession.id);
      setSelectedSession(updated);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onSessionSelect?.(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDiscard = async () => {
    if (!selectedSession) return;
    if (!confirm("Discard this planning session?")) return;
    setLoading(true);
    try {
      await api.discardPlanningSession(selectedSession.id);
      setSelectedSession(null);
      onSessionSelect?.(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedSession) return;
    if (!confirm("Delete this planning session permanently?")) return;
    setLoading(true);
    try {
      await api.deletePlanningSession(selectedSession.id);
      setSelectedSession(null);
      onSessionSelect?.(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // External link handlers
  const handleAddLink = async () => {
    if (!newLinkUrl.trim() || !selectedSession || addingLink) return;
    setAddingLink(true);
    try {
      const link = await api.addExternalLink(selectedSession.id, newLinkUrl.trim());
      setExternalLinks((prev) => [...prev, link]);
      setNewLinkUrl("");
    } catch (err) {
      console.error("Failed to add link:", err);
    } finally {
      setAddingLink(false);
    }
  };

  const handleRemoveLink = async (id: number) => {
    try {
      await api.deleteExternalLink(id);
      setExternalLinks((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      console.error("Failed to remove link:", err);
    }
  };

  // Task suggestion from chat
  const handleTaskSuggested = useCallback(async (suggestion: TaskSuggestion) => {
    if (!selectedSession) return;
    const newNode: TaskNode = {
      id: crypto.randomUUID(),
      title: suggestion.label,
      description: suggestion.description,
    };
    const updatedNodes = [...selectedSession.nodes, newNode];
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, {
        nodes: updatedNodes,
      });
      setSelectedSession(updated);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onTasksChange?.(updated.nodes, updated.edges);
    } catch (err) {
      console.error("Failed to add task:", err);
    }
  }, [selectedSession]);

  // Task removal
  const handleRemoveTask = async (taskId: string) => {
    if (!selectedSession) return;
    const updatedNodes = selectedSession.nodes.filter((n) => n.id !== taskId);
    const updatedEdges = selectedSession.edges.filter(
      (e) => e.parent !== taskId && e.child !== taskId
    );
    try {
      const updated = await api.updatePlanningSession(selectedSession.id, {
        nodes: updatedNodes,
        edges: updatedEdges,
      });
      setSelectedSession(updated);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      onTasksChange?.(updated.nodes, updated.edges);
    } catch (err) {
      console.error("Failed to remove task:", err);
    }
  };

  const getLinkTypeIcon = (type: string) => {
    switch (type) {
      case "notion": return "N";
      case "figma": return "F";
      case "github_issue": return "#";
      case "github_pr": return "PR";
      default: return "URL";
    }
  };

  if (loading && sessions.length === 0) {
    return (
      <div className="planning-panel planning-panel--loading">
        <div className="planning-panel__spinner" />
        Loading...
      </div>
    );
  }

  // Session list view
  if (!selectedSession) {
    return (
      <div className="planning-panel">
        <div className="planning-panel__header">
          <h3>Planning Sessions</h3>
          <button
            className="planning-panel__new-btn"
            onClick={() => setShowNewForm(true)}
          >
            + New Planning
          </button>
        </div>

        {error && <div className="planning-panel__error">{error}</div>}

        {showNewForm && (
          <div className="planning-panel__new-form">
            <input
              type="text"
              placeholder="Title (optional)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="planning-panel__input"
            />
            <select
              value={newBaseBranch}
              onChange={(e) => setNewBaseBranch(e.target.value)}
              className="planning-panel__select"
            >
              {branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            <div className="planning-panel__form-actions">
              <button onClick={handleCreateSession} disabled={creating}>
                {creating ? "Creating..." : "Create"}
              </button>
              <button onClick={() => setShowNewForm(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="planning-panel__list">
          {sessions.length === 0 ? (
            <div className="planning-panel__empty">
              No planning sessions yet. Create one to start!
            </div>
          ) : (
            sessions.map((session) => (
              <div
                key={session.id}
                className={`planning-panel__session-item planning-panel__session-item--${session.status}`}
                onClick={() => handleSelectSession(session)}
              >
                <div className="planning-panel__session-title">
                  {session.title}
                </div>
                <div className="planning-panel__session-meta">
                  <span className="planning-panel__session-base">
                    {session.baseBranch}
                  </span>
                  <span className={`planning-panel__session-status planning-panel__session-status--${session.status}`}>
                    {session.status}
                  </span>
                  <span className="planning-panel__session-tasks">
                    {session.nodes.length} tasks
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // Session detail view
  return (
    <div className="planning-panel planning-panel--detail">
      <div className="planning-panel__header">
        <button
          className="planning-panel__back-btn"
          onClick={() => {
            setSelectedSession(null);
            onSessionSelect?.(null);
          }}
        >
          &larr; Back
        </button>
        <input
          type="text"
          value={selectedSession.title}
          onChange={(e) => handleUpdateTitle(e.target.value)}
          className="planning-panel__title-input"
          placeholder="Untitled Planning"
          disabled={selectedSession.status !== "draft"}
        />
        <select
          value={selectedSession.baseBranch}
          onChange={(e) => handleUpdateBaseBranch(e.target.value)}
          className="planning-panel__branch-select"
          disabled={selectedSession.status !== "draft"}
        >
          {branches.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>

      {error && <div className="planning-panel__error">{error}</div>}

      <div className="planning-panel__content">
        {/* Chat section */}
        <div className="planning-panel__chat">
          {selectedSession.chatSessionId && (
            <ChatPanel
              sessionId={selectedSession.chatSessionId}
              onTaskSuggested={handleTaskSuggested}
              disabled={selectedSession.status !== "draft"}
            />
          )}
        </div>

        {/* Sidebar: Links + Tasks */}
        <div className="planning-panel__sidebar">
          {/* External Links */}
          <div className="planning-panel__links">
            <h4>Links</h4>
            {externalLinks.map((link) => (
              <div key={link.id} className="planning-panel__link-item">
                <span className="planning-panel__link-type">
                  {getLinkTypeIcon(link.linkType)}
                </span>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.title || link.url}
                </a>
                {selectedSession.status === "draft" && (
                  <button
                    className="planning-panel__link-remove"
                    onClick={() => handleRemoveLink(link.id)}
                  >
                    x
                  </button>
                )}
              </div>
            ))}
            {selectedSession.status === "draft" && (
              <div className="planning-panel__link-add">
                <input
                  type="text"
                  placeholder="Paste URL..."
                  value={newLinkUrl}
                  onChange={(e) => setNewLinkUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddLink()}
                />
                <button onClick={handleAddLink} disabled={addingLink}>
                  {addingLink ? "..." : "+"}
                </button>
              </div>
            )}
          </div>

          {/* Task list */}
          <div className="planning-panel__tasks">
            <h4>Tasks ({selectedSession.nodes.length})</h4>
            {selectedSession.nodes.map((task) => (
              <div key={task.id} className="planning-panel__task-item">
                <div className="planning-panel__task-title">{task.title}</div>
                {task.description && (
                  <div className="planning-panel__task-desc">{task.description}</div>
                )}
                {selectedSession.status === "draft" && (
                  <button
                    className="planning-panel__task-remove"
                    onClick={() => handleRemoveTask(task.id)}
                  >
                    x
                  </button>
                )}
              </div>
            ))}
            {selectedSession.nodes.length === 0 && (
              <div className="planning-panel__tasks-empty">
                Chat with AI to suggest tasks
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      {selectedSession.status === "draft" && (
        <div className="planning-panel__actions">
          <button
            className="planning-panel__confirm-btn"
            onClick={handleConfirm}
            disabled={loading || selectedSession.nodes.length === 0}
          >
            Confirm & Create Branches
          </button>
          <button
            className="planning-panel__discard-btn"
            onClick={handleDiscard}
            disabled={loading}
          >
            Discard
          </button>
        </div>
      )}

      {selectedSession.status === "confirmed" && (
        <div className="planning-panel__status-banner planning-panel__status-banner--confirmed">
          Planning confirmed. Branches will be created.
        </div>
      )}

      {selectedSession.status === "discarded" && (
        <div className="planning-panel__status-banner planning-panel__status-banner--discarded">
          Planning discarded.
          <button onClick={handleDelete} className="planning-panel__delete-btn">
            Delete permanently
          </button>
        </div>
      )}
    </div>
  );
}
