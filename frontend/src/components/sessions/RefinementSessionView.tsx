import { useState, useEffect, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  api,
  type PlanningSession,
  type TaskNode,
  type ExternalLink,
  type BranchExternalLink,
} from "../../lib/api";
import { useIsStreaming } from "../../lib/useStreamingState";
import { ChatPanel } from "../ChatPanel";
import type { TaskSuggestion } from "../../lib/task-parser";
import { figmaIcon, githubIcon, notionIcon, linkIcon } from "../../lib/resourceIcons";

interface RefinementSessionViewProps {
  session: PlanningSession;
  repoId: string;
  isActive: boolean;
  sidebarWidth: number;
  sidebarFullscreen: boolean;
  onSidebarWidthChange: (width: number) => void;
  onSidebarFullscreenChange: (fullscreen: boolean) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  onSessionUpdate: (updates: Partial<PlanningSession>) => void;
  onSessionDelete: () => void;
  onTaskSuggested: (suggestion: TaskSuggestion) => void;
  onClaudeWorkingChange?: (sessionId: string, working: boolean) => void;
  generatingTitle: boolean;
  onGenerateTitle: () => void;
}

// Sortable task item component
function SortableTaskItem({
  task,
  index,
  isDraft,
  onRemove,
  onBranchNameChange,
  links: _links = [],
}: {
  task: TaskNode;
  index: number;
  isDraft: boolean;
  onRemove: () => void;
  onBranchNameChange: (newName: string) => void;
  links: BranchExternalLink[];
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="planning-panel__task-item"
      {...attributes}
    >
      <span className="planning-panel__task-number">{index + 1}</span>
      <span className="planning-panel__task-drag" {...listeners}>
        ⋮⋮
      </span>
      <div className="planning-panel__task-content">
        <div className="planning-panel__task-title">{task.title}</div>
        {task.description && (
          <div className="planning-panel__task-description">
            {task.description}
          </div>
        )}
        {task.branchName && (
          <input
            type="text"
            className="planning-panel__task-branch-input"
            value={task.branchName}
            onChange={(e) => onBranchNameChange(e.target.value)}
            disabled={!isDraft}
          />
        )}
      </div>
      {isDraft && (
        <button
          className="planning-panel__task-remove"
          onClick={onRemove}
          title="Remove task"
        >
          ×
        </button>
      )}
    </div>
  );
}

function getLinkTypeIcon(linkType: string) {
  switch (linkType) {
    case "figma":
      return { iconSrc: figmaIcon, className: "planning-panel__link-icon--figma" };
    case "github_issue":
    case "github_pr":
      return { iconSrc: githubIcon, className: "planning-panel__link-icon--github" };
    case "notion":
      return { iconSrc: notionIcon, className: "planning-panel__link-icon--notion" };
    default:
      return { iconSrc: linkIcon, className: "planning-panel__link-icon--other" };
  }
}

export function RefinementSessionView({
  session,
  repoId,
  isActive: _isActive,
  sidebarWidth,
  onResizeStart,
  onSessionUpdate,
  onSessionDelete,
  onTaskSuggested,
  onClaudeWorkingChange,
  generatingTitle,
  onGenerateTitle,
}: RefinementSessionViewProps) {
  // Session-specific state
  // Use global streaming state as single source of truth
  const claudeWorking = useIsStreaming(session.chatSessionId);
  const [loading, setLoading] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [externalLinks, setExternalLinks] = useState<ExternalLink[]>([]);
  const [taskBranchLinksMap, setTaskBranchLinksMap] = useState<Record<string, BranchExternalLink[]>>({});
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [addingLinkCount, setAddingLinkCount] = useState(0);
  const [linksCopied, setLinksCopied] = useState(false);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Notify parent of claude working state
  useEffect(() => {
    onClaudeWorkingChange?.(session.id, claudeWorking);
  }, [session.id, claudeWorking, onClaudeWorkingChange]);

  // Load external links
  useEffect(() => {
    let cancelled = false;
    api.getExternalLinks(session.id, undefined)
      .then((links) => {
        if (!cancelled) {
          setExternalLinks(links);
        }
      })
      .catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [session.id]);

  // Load task branch links
  useEffect(() => {
    const branchNames = session.nodes
      .map((n) => n.branchName)
      .filter((b): b is string => !!b);

    if (branchNames.length === 0) {
      setTaskBranchLinksMap({});
      return;
    }

    let cancelled = false;
    const loadLinks = async () => {
      const linksMap: Record<string, BranchExternalLink[]> = {};
      await Promise.all(
        branchNames.map(async (branch) => {
          try {
            const links = await api.getBranchExternalLinks(repoId, branch);
            linksMap[branch] = links;
          } catch {
            linksMap[branch] = [];
          }
        })
      );
      if (!cancelled) {
        setTaskBranchLinksMap(linksMap);
      }
    };
    loadLinks();

    return () => {
      cancelled = true;
    };
  }, [session.id, session.nodes, repoId]);

  // Handlers
  const handleTaskSuggestedInternal = useCallback((suggestion: TaskSuggestion) => {
    onTaskSuggested(suggestion);
  }, [onTaskSuggested]);

  const handleRemoveTask = async (taskId: string) => {
    const updatedNodes = session.nodes.filter((n) => n.id !== taskId);
    onSessionUpdate({ nodes: updatedNodes });
  };

  const handleBranchNameChange = (taskId: string, newName: string) => {
    const updatedNodes = session.nodes.map((n) =>
      n.id === taskId ? { ...n, branchName: newName } : n
    );
    onSessionUpdate({ nodes: updatedNodes });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = session.nodes.findIndex((n) => n.id === active.id);
    const newIndex = session.nodes.findIndex((n) => n.id === over.id);
    const reorderedNodes = arrayMove(session.nodes, oldIndex, newIndex);
    onSessionUpdate({ nodes: reorderedNodes });
  };

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await api.confirmPlanningSession(session.id);
    } catch (err) {
      console.error("Failed to confirm session:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDiscard = async () => {
    setLoading(true);
    try {
      await api.discardPlanningSession(session.id);
    } catch (err) {
      console.error("Failed to discard session:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleUnconfirm = async () => {
    setLoading(true);
    try {
      await api.unconfirmPlanningSession(session.id);
    } catch (err) {
      console.error("Failed to unconfirm session:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddLink = async () => {
    if (!newLinkUrl.trim()) return;
    const urls = newLinkUrl.split("\n").map((u) => u.trim()).filter((u) => u);
    setAddingLinkCount(urls.length);
    setNewLinkUrl("");

    for (const url of urls) {
      try {
        const link = await api.addExternalLink(session.id, url);
        setExternalLinks((prev) => [...prev, link]);
      } catch (err) {
        console.error("Failed to add link:", err);
      }
    }
    setAddingLinkCount(0);
  };

  const handleRemoveLink = async (linkId: number) => {
    try {
      await api.deleteExternalLink(linkId);
      setExternalLinks((prev) => prev.filter((l) => l.id !== linkId));
    } catch (err) {
      console.error("Failed to remove link:", err);
    }
  };

  const handleCopyAllLinks = () => {
    const urls = externalLinks.map((l) => l.url).join("\n");
    navigator.clipboard.writeText(urls);
    setLinksCopied(true);
    setTimeout(() => setLinksCopied(false), 2000);
  };

  const refinementStatus = session.status === "confirmed" ? "confirmed" : "draft";
  const refinementStatusLabel = session.status === "confirmed" ? "Confirmed" : "Draft";

  return (
    <div className="planning-panel__detail-content">
      {/* Header */}
      <div className="planning-panel__header">
        <span className="planning-panel__session-type planning-panel__session-type--refinement">
          <span className="planning-panel__session-type-icon">💭</span>
          Refinement
        </span>
        <span className={`planning-panel__execute-status planning-panel__execute-status--${refinementStatus}`}>
          {refinementStatusLabel}
        </span>
        <span className={`planning-panel__header-title${!session.title ? " planning-panel__header-title--untitled" : ""}`}>
          {session.title || "Untitled Session"}
          <button
            className={`planning-panel__generate-title-btn${generatingTitle ? " planning-panel__generate-title-btn--loading" : ""}`}
            onClick={onGenerateTitle}
            disabled={generatingTitle}
            title="Generate title from conversation"
          >
            ↻
          </button>
        </span>
        <button
          className="planning-panel__delete-btn"
          onClick={onSessionDelete}
          title="Delete this session"
        >
          Delete
        </button>
      </div>

      {/* Main content */}
      <div className="planning-panel__detail-main">
        {/* Chat section */}
        <div className="planning-panel__chat">
          {session.chatSessionId && (
            <ChatPanel
              sessionId={session.chatSessionId}
              onTaskSuggested={handleTaskSuggestedInternal}
              existingTaskLabels={session.nodes.map((n) => n.title)}
              disabled={session.status !== "draft"}
            />
          )}
        </div>

        {/* Resizer */}
        <div
          className="planning-panel__resizer"
          onMouseDown={onResizeStart}
        />

        {/* Sidebar */}
        <div className="planning-panel__sidebar" style={{ width: sidebarWidth }}>
          {/* External Links */}
          <div className="planning-panel__links">
            <div className="planning-panel__links-header">
              <h4>Links</h4>
              {externalLinks.length > 0 && (
                <button
                  className={`planning-panel__links-copy-btn${linksCopied ? ' planning-panel__links-copy-btn--copied' : ''}`}
                  onClick={handleCopyAllLinks}
                  title="Copy all links"
                >
                  {linksCopied ? 'Copied!' : 'Copy All'}
                </button>
              )}
            </div>
            <div className="planning-panel__links-list">
              {externalLinks.map((link) => {
                const { iconSrc, className } = getLinkTypeIcon(link.linkType);
                const isSessionLevel = link.branchName === null;
                const subIssueMatch = link.contentCache?.match(/## Sub-Issues \((\d+)件\)/);
                const subIssueCount = subIssueMatch ? parseInt(subIssueMatch[1], 10) : 0;
                const linkTitle = link.branchName
                  ? `${link.title || link.url} (Branch: ${link.branchName})${subIssueCount > 0 ? ` - ${subIssueCount} sub-issues` : ''}`
                  : `${link.title || link.url}${subIssueCount > 0 ? ` - ${subIssueCount} sub-issues` : ''}`;
                return (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`planning-panel__link-icon ${className}${isSessionLevel ? ' planning-panel__link-icon--session' : ''}`}
                    title={linkTitle}
                  >
                    <img src={iconSrc} alt={link.linkType} />
                    {subIssueCount > 0 && (
                      <span className="planning-panel__link-sub-badge">{subIssueCount}</span>
                    )}
                    {session.status === "draft" && (
                      <span
                        className="planning-panel__link-remove-overlay"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleRemoveLink(link.id);
                        }}
                      >
                        ×
                      </span>
                    )}
                  </a>
                );
              })}
              {addingLinkCount > 0 && (
                Array.from({ length: addingLinkCount }).map((_, i) => (
                  <div key={`skeleton-${i}`} className="planning-panel__link-icon planning-panel__link-icon--loading">
                    <div className="planning-panel__link-skeleton" />
                  </div>
                ))
              )}
              {session.status === "draft" && addingLinkCount === 0 && (
                <button
                  className="planning-panel__link-add-icon"
                  onClick={() => setShowLinkInput(!showLinkInput)}
                  title="Add link"
                >
                  +
                </button>
              )}
            </div>
            {showLinkInput && session.status === "draft" && (
              <div className="planning-panel__link-add-container">
                <textarea
                  className="planning-panel__link-add-input"
                  placeholder="Paste URLs (one per line)..."
                  value={newLinkUrl}
                  onChange={(e) => setNewLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      handleAddLink();
                      setShowLinkInput(false);
                    } else if (e.key === "Escape") {
                      setShowLinkInput(false);
                      setNewLinkUrl("");
                    }
                  }}
                  autoFocus
                />
                <button
                  className="planning-panel__link-add-submit"
                  onClick={() => {
                    handleAddLink();
                    setShowLinkInput(false);
                  }}
                  disabled={!newLinkUrl.trim()}
                >
                  Add (⌘+Enter)
                </button>
              </div>
            )}
          </div>

          {/* Task list */}
          <div className="planning-panel__tasks">
            <h4>Tasks ({session.nodes.length})</h4>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={session.nodes.map((n) => n.id)}
                strategy={verticalListSortingStrategy}
              >
                {session.nodes.map((task, index) => (
                  <SortableTaskItem
                    key={task.id}
                    task={task}
                    index={index}
                    isDraft={session.status === "draft"}
                    onRemove={() => handleRemoveTask(task.id)}
                    onBranchNameChange={(newName) => handleBranchNameChange(task.id, newName)}
                    links={task.branchName ? taskBranchLinksMap[task.branchName] : []}
                  />
                ))}
              </SortableContext>
              <DragOverlay>
                {activeDragId && (
                  <div className="planning-panel__task-item planning-panel__task-item--dragging">
                    {session.nodes.find((t) => t.id === activeDragId)?.title}
                  </div>
                )}
              </DragOverlay>
            </DndContext>
            {session.nodes.length === 0 && (
              <div className="planning-panel__tasks-empty">
                Chat with AI to suggest tasks
              </div>
            )}
          </div>

          {/* Actions */}
          {session.status === "draft" && (
            <div className="planning-panel__actions">
              <button
                className="planning-panel__discard-btn"
                onClick={handleDiscard}
                disabled={loading}
              >
                Discard
              </button>
              <button
                className="planning-panel__confirm-btn"
                onClick={handleConfirm}
                disabled={loading || session.nodes.length === 0}
              >
                Confirm
              </button>
            </div>
          )}

          {session.status === "confirmed" && (
            <div className="planning-panel__status-banner planning-panel__status-banner--confirmed">
              Confirmed
              <button onClick={handleUnconfirm} className="planning-panel__unconfirm-btn">
                Unconfirm
              </button>
              <button onClick={onSessionDelete} className="planning-panel__delete-btn">
                Delete
              </button>
            </div>
          )}

          {session.status === "discarded" && (
            <div className="planning-panel__status-banner planning-panel__status-banner--discarded">
              Discarded
              <button onClick={onSessionDelete} className="planning-panel__delete-btn">
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default RefinementSessionView;
