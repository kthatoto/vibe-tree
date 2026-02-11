import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type TaskTodo, type PlanningQuestion, type BranchLink, type BranchExternalLink, type BranchFile, type TaskInstruction, type GitHubLabel, type GitHubCheck, type InstructionConfirmationStatus } from "../lib/api";
import { wsClient } from "../lib/ws";
import { getResourceIcon } from "../lib/resourceIcons";
import ExecuteBranchTree from "./ExecuteBranchTree";
import ExecuteTodoList from "./ExecuteTodoList";
import PlanningQuestionsPanel from "./PlanningQuestionsPanel";
import "./ExecuteSidebar.css";

interface ExecuteSidebarProps {
  repoId: string;
  executeBranches: string[];
  currentExecuteIndex: number;
  planningSessionId?: string;
  onManualBranchSwitch?: (branchIndex: number) => void;
  onBranchCompleted?: (branchName: string) => void;
  workingBranch?: string | null;
  onExpandToggle?: () => void;
  isExpanded?: boolean;
  sessionType?: "execute" | "planning";
}

export function ExecuteSidebar({
  repoId,
  executeBranches,
  currentExecuteIndex,
  planningSessionId,
  onManualBranchSwitch: _onManualBranchSwitch,
  onBranchCompleted,
  workingBranch,
  onExpandToggle,
  isExpanded = false,
  sessionType = "execute",
}: ExecuteSidebarProps) {
  // Preview branch (clicked but not switched to)
  const [previewBranch, setPreviewBranch] = useState<string | null>(null);

  // Active tab: "info", "instruction", "todo", "questions", or "resources"
  // Planning sessions default to "instruction", execute sessions default to "info"
  const [activeTab, setActiveTab] = useState<"info" | "instruction" | "todo" | "questions" | "resources">(
    sessionType === "planning" ? "instruction" : "info"
  );

  // All todos for all branches (for completion tracking)
  const [allTodos, setAllTodos] = useState<Map<string, TaskTodo[]>>(new Map());

  // All questions for all branches (for badge counts)
  const [allQuestions, setAllQuestions] = useState<PlanningQuestion[]>([]);

  // All branch links for all branches (for PR status in tree)
  const [allBranchLinks, setAllBranchLinks] = useState<Map<string, BranchLink[]>>(new Map());

  // All branch resource counts (for tree badges)
  const [allResourceCounts, setAllResourceCounts] = useState<Map<string, { figma: number; githubIssue: number; notion: number; other: number; files: number }>>(new Map());

  // All instruction confirmation statuses (for tree badges)
  const [allInstructionStatuses, setAllInstructionStatuses] = useState<Map<string, InstructionConfirmationStatus>>(new Map());

  // Branch links and instruction for display branch
  const [branchLinks, setBranchLinks] = useState<BranchLink[]>([]);
  const [externalLinks, setExternalLinks] = useState<BranchExternalLink[]>([]);
  const [branchFiles, setBranchFiles] = useState<BranchFile[]>([]);
  const [instruction, setInstruction] = useState<TaskInstruction | null>(null);
  const [instructionLoading, setInstructionLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Instruction editing state (for planning sessions)
  const [instructionEditing, setInstructionEditing] = useState(false);
  const [editingInstructionText, setEditingInstructionText] = useState("");
  const [instructionDirty, setInstructionDirty] = useState(false);
  const [instructionSaving, setInstructionSaving] = useState(false);

  // Refresh state
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Copy feedback state
  const [copied, setCopied] = useState(false);

  // Current branch (actual execution target)
  const currentBranch = executeBranches[currentExecuteIndex] || null;

  // Display branch (preview if set, otherwise current)
  const displayBranch = previewBranch || currentBranch;

  // Reset preview when current branch changes
  useEffect(() => {
    setPreviewBranch(null);
  }, [currentExecuteIndex]);

  // Load branch links, external links, files, and instruction for display branch
  useEffect(() => {
    if (!repoId || !displayBranch) {
      setBranchLinks([]);
      setExternalLinks([]);
      setBranchFiles([]);
      setInstruction(null);
      return;
    }
    setInstructionLoading(true);
    Promise.all([
      api.getBranchLinks(repoId, displayBranch).catch(() => []),
      api.getBranchExternalLinks(repoId, displayBranch).catch(() => []),
      api.getBranchFiles(repoId, displayBranch).catch(() => []),
      api.getTaskInstruction(repoId, displayBranch).catch(() => null),
    ])
      .then(async ([links, extLinks, files, inst]) => {
        // If no PR link found, try to detect one
        if (!links.some((l) => l.linkType === "pr")) {
          try {
            const result = await api.detectPr(repoId, displayBranch);
            if (result.found && result.link) {
              links = [result.link, ...links];
            }
          } catch {
            // Ignore detection errors
          }
        }
        setBranchLinks(links);
        setExternalLinks(extLinks);
        setBranchFiles(files);
        setInstruction(inst);
      })
      .finally(() => setInstructionLoading(false));
  }, [repoId, displayBranch]);

  // Load all todos for all branches
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const loadAllTodos = async () => {
      const todosMap = new Map<string, TaskTodo[]>();
      await Promise.all(
        executeBranches.map(async (branch) => {
          try {
            const todos = await api.getTodos(repoId, branch);
            todosMap.set(branch, todos);
          } catch {
            todosMap.set(branch, []);
          }
        })
      );
      setAllTodos(todosMap);
    };

    loadAllTodos();
  }, [repoId, executeBranches]);

  // Load all branch links for all branches (with PR auto-detection)
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const loadAllBranchLinks = async () => {
      try {
        // Use batch API for single request
        const batchResult = await api.getBranchLinksBatch(repoId, executeBranches);
        const linksMap = new Map<string, BranchLink[]>();

        // Find branches without PR links - detect in parallel
        const branchesNeedingDetection: string[] = [];
        for (const branch of executeBranches) {
          const links = batchResult[branch] || [];
          linksMap.set(branch, links);
          if (!links.some((l) => l.linkType === "pr")) {
            branchesNeedingDetection.push(branch);
          }
        }

        // Detect PRs in parallel for branches that need it
        if (branchesNeedingDetection.length > 0) {
          const detectionResults = await Promise.allSettled(
            branchesNeedingDetection.map((branch) => api.detectPr(repoId, branch))
          );

          detectionResults.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value.found && result.value.link) {
              const branch = branchesNeedingDetection[index];
              const currentLinks = linksMap.get(branch) || [];
              linksMap.set(branch, [result.value.link, ...currentLinks]);
            }
          });
        }

        setAllBranchLinks(linksMap);
      } catch {
        // Fallback: set empty map
        const linksMap = new Map<string, BranchLink[]>();
        executeBranches.forEach((branch) => linksMap.set(branch, []));
        setAllBranchLinks(linksMap);
      }
    };

    loadAllBranchLinks();
  }, [repoId, executeBranches]);

  // Load all resource counts for all branches (for tree badges)
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    Promise.all([
      api.getBranchExternalLinksBatch(repoId, executeBranches).catch(() => ({})),
      api.getBranchFilesBatch(repoId, executeBranches).catch(() => ({})),
    ]).then(([extLinksMap, filesMap]) => {
      const countsMap = new Map<string, { figma: number; githubIssue: number; notion: number; other: number; files: number }>();
      for (const branch of executeBranches) {
        const extLinks = (extLinksMap as Record<string, BranchExternalLink[]>)[branch] || [];
        const files = (filesMap as Record<string, BranchFile[]>)[branch] || [];
        countsMap.set(branch, {
          figma: extLinks.filter((l: BranchExternalLink) => l.linkType === "figma").length,
          githubIssue: extLinks.filter((l: BranchExternalLink) => l.linkType === "github_issue").length,
          notion: extLinks.filter((l: BranchExternalLink) => l.linkType === "notion").length,
          other: extLinks.filter((l: BranchExternalLink) => l.linkType !== "figma" && l.linkType !== "github_issue" && l.linkType !== "notion").length,
          files: files.length,
        });
      }
      setAllResourceCounts(countsMap);
    });
  }, [repoId, executeBranches]);

  // Load instruction confirmation statuses for all branches
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const loadStatuses = async () => {
      const statusMap = new Map<string, InstructionConfirmationStatus>();
      await Promise.all(
        executeBranches.map(async (branch) => {
          try {
            const inst = await api.getTaskInstruction(repoId, branch);
            if (inst && inst.instructionMd) {
              statusMap.set(branch, inst.confirmationStatus);
            }
          } catch {
            // Ignore errors
          }
        })
      );
      setAllInstructionStatuses(statusMap);
    };

    loadStatuses();
  }, [repoId, executeBranches]);

  // WebSocket updates for branch links
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const unsubCreated = wsClient.on("branchLink.created", (msg) => {
      const data = msg.data as BranchLink;
      if (data.repoId === repoId && executeBranches.includes(data.branchName)) {
        setAllBranchLinks((prev) => {
          const newMap = new Map(prev);
          const current = newMap.get(data.branchName) || [];
          if (!current.some((l) => l.id === data.id)) {
            newMap.set(data.branchName, [data, ...current]);
          }
          return newMap;
        });
      }
    });

    const unsubUpdated = wsClient.on("branchLink.updated", (msg) => {
      const data = msg.data as BranchLink;
      if (data.repoId === repoId && executeBranches.includes(data.branchName)) {
        setAllBranchLinks((prev) => {
          const newMap = new Map(prev);
          const current = newMap.get(data.branchName) || [];
          newMap.set(data.branchName, current.map((l) => (l.id === data.id ? data : l)));
          return newMap;
        });
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
    };
  }, [repoId, executeBranches]);

  // WebSocket updates for instruction confirmation
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const updateInstructionStatus = (data: TaskInstruction & { confirmationStatus: InstructionConfirmationStatus }) => {
      if (data.branchName && executeBranches.includes(data.branchName)) {
        setAllInstructionStatuses((prev) => {
          const newMap = new Map(prev);
          newMap.set(data.branchName!, data.confirmationStatus);
          return newMap;
        });
        // Also update local instruction if this is the display branch
        if (data.branchName === displayBranch) {
          setInstruction(data);
        }
      }
    };

    const unsubConfirmed = wsClient.on("taskInstruction.confirmed", (msg) => {
      updateInstructionStatus(msg.data as TaskInstruction & { confirmationStatus: InstructionConfirmationStatus });
    });

    const unsubUnconfirmed = wsClient.on("taskInstruction.unconfirmed", (msg) => {
      updateInstructionStatus(msg.data as TaskInstruction & { confirmationStatus: InstructionConfirmationStatus });
    });

    const unsubUpdated = wsClient.on("taskInstruction.updated", (msg) => {
      updateInstructionStatus(msg.data as TaskInstruction & { confirmationStatus: InstructionConfirmationStatus });
    });

    return () => {
      unsubConfirmed();
      unsubUnconfirmed();
      unsubUpdated();
    };
  }, [repoId, executeBranches, displayBranch]);

  // WebSocket updates for todos
  useEffect(() => {
    const updateTodosForBranch = (branchName: string, updater: (todos: TaskTodo[]) => TaskTodo[]) => {
      setAllTodos((prev) => {
        const newMap = new Map(prev);
        const current = newMap.get(branchName) || [];
        newMap.set(branchName, updater(current));
        return newMap;
      });
    };

    const unsubCreated = wsClient.on("todo.created", (msg) => {
      const todo = msg.data as TaskTodo;
      if (executeBranches.includes(todo.branchName)) {
        updateTodosForBranch(todo.branchName, (todos) =>
          [...todos, todo].sort((a, b) => a.orderIndex - b.orderIndex)
        );
      }
    });

    const unsubUpdated = wsClient.on("todo.updated", (msg) => {
      const todo = msg.data as TaskTodo;
      if (executeBranches.includes(todo.branchName)) {
        updateTodosForBranch(todo.branchName, (todos) =>
          todos.map((t) => (t.id === todo.id ? todo : t)).sort((a, b) => a.orderIndex - b.orderIndex)
        );
      }
    });

    const unsubDeleted = wsClient.on("todo.deleted", (msg) => {
      const data = msg.data as { id: number; branchName: string };
      if (executeBranches.includes(data.branchName)) {
        updateTodosForBranch(data.branchName, (todos) =>
          todos.filter((t) => t.id !== data.id)
        );
      }
    });

    const unsubReordered = wsClient.on("todo.reordered", (msg) => {
      const data = msg.data as { branchName: string; todos: TaskTodo[] };
      if (executeBranches.includes(data.branchName)) {
        setAllTodos((prev) => {
          const newMap = new Map(prev);
          newMap.set(data.branchName, data.todos);
          return newMap;
        });
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
      unsubReordered();
    };
  }, [executeBranches]);

  // Load questions
  useEffect(() => {
    if (!planningSessionId) return;
    api.getQuestions(planningSessionId)
      .then(setAllQuestions)
      .catch(console.error);
  }, [planningSessionId]);

  // WebSocket updates for questions
  useEffect(() => {
    if (!planningSessionId) return;

    const unsubQCreated = wsClient.on("question.created", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setAllQuestions((prev) => [...prev, q].sort((a, b) => a.orderIndex - b.orderIndex));
      }
    });

    const unsubQUpdated = wsClient.on("question.updated", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setAllQuestions((prev) => prev.map((item) => (item.id === q.id ? q : item)));
      }
    });

    const unsubQAnswered = wsClient.on("question.answered", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setAllQuestions((prev) => prev.map((item) => (item.id === q.id ? q : item)));
      }
    });

    const unsubQDeleted = wsClient.on("question.deleted", (msg) => {
      const data = msg.data as { id: number; planningSessionId: string };
      if (data.planningSessionId === planningSessionId) {
        setAllQuestions((prev) => prev.filter((q) => q.id !== data.id));
      }
    });

    return () => {
      unsubQCreated();
      unsubQUpdated();
      unsubQAnswered();
      unsubQDeleted();
    };
  }, [planningSessionId]);

  // Compute completed branches (all todos completed)
  const completedBranches = useMemo(() => {
    const completed = new Set<string>();
    allTodos.forEach((todos, branchName) => {
      if (todos.length > 0 && todos.every((t) => t.status === "completed")) {
        completed.add(branchName);
      }
    });
    return completed;
  }, [allTodos]);

  // Track previously completed branches to avoid duplicate callbacks
  const prevCompletedRef = useRef<Set<string>>(new Set());

  // Notify when current branch is completed
  useEffect(() => {
    if (!currentBranch || !onBranchCompleted) return;

    // Check if current branch just became completed
    const isNowCompleted = completedBranches.has(currentBranch);
    const wasCompleted = prevCompletedRef.current.has(currentBranch);

    if (isNowCompleted && !wasCompleted) {
      // Branch just completed - notify parent
      onBranchCompleted(currentBranch);
    }

    // Update prev ref
    prevCompletedRef.current = new Set(completedBranches);
  }, [completedBranches, currentBranch, onBranchCompleted]);

  // Compute todo counts per branch
  const branchTodoCounts = useMemo(() => {
    const counts = new Map<string, { total: number; completed: number }>();
    allTodos.forEach((todos, branchName) => {
      counts.set(branchName, {
        total: todos.length,
        completed: todos.filter((t) => t.status === "completed").length,
      });
    });
    return counts;
  }, [allTodos]);

  // Compute question counts per branch
  const branchQuestionCounts = useMemo(() => {
    const counts = new Map<string, { total: number; pending: number; answered: number; acknowledged: number }>();
    executeBranches.forEach((branch) => {
      const branchQuestions = allQuestions.filter((q) => q.branchName === branch);
      counts.set(branch, {
        total: branchQuestions.length,
        pending: branchQuestions.filter((q) => q.status === "pending").length,
        answered: branchQuestions.filter((q) => q.status === "answered" && !q.acknowledged).length,
        acknowledged: branchQuestions.filter((q) => q.status === "answered" && q.acknowledged).length,
      });
    });
    return counts;
  }, [allQuestions, executeBranches]);

  // Count pending questions for display branch
  const displayBranchQuestionCount = useMemo(() => {
    if (!displayBranch) return { total: 0, pending: 0, answered: 0 };
    const branchQuestions = allQuestions.filter((q) => q.branchName === displayBranch);
    return {
      total: branchQuestions.length,
      pending: branchQuestions.filter((q) => q.status === "pending").length,
      answered: branchQuestions.filter((q) => q.status === "answered" && !q.acknowledged).length,
    };
  }, [allQuestions, displayBranch]);

  // Handle preview branch selection
  const handlePreviewBranch = useCallback((branch: string) => {
    setPreviewBranch(branch === previewBranch ? null : branch);
  }, [previewBranch]);

  // Handle confirm/unconfirm toggle
  const handleConfirmToggle = useCallback(async () => {
    if (!instruction || !instruction.instructionMd || !displayBranch || confirming) return;

    setConfirming(true);
    try {
      if (instruction.confirmationStatus === "confirmed") {
        // Unconfirm
        const updated = await api.unconfirmTaskInstruction(repoId, displayBranch);
        setInstruction(updated);
        setAllInstructionStatuses((prev) => {
          const newMap = new Map(prev);
          newMap.set(displayBranch, updated.confirmationStatus);
          return newMap;
        });
      } else {
        // Confirm (both unconfirmed and changed states)
        const updated = await api.confirmTaskInstruction(repoId, displayBranch);
        setInstruction(updated);
        setAllInstructionStatuses((prev) => {
          const newMap = new Map(prev);
          newMap.set(displayBranch, updated.confirmationStatus);
          return newMap;
        });
      }
    } catch (err) {
      console.error("Failed to toggle instruction confirmation:", err);
    } finally {
      setConfirming(false);
    }
  }, [instruction, confirming, repoId, displayBranch]);

  // Handle starting instruction edit
  const handleStartInstructionEdit = useCallback(() => {
    setEditingInstructionText(instruction?.instructionMd || "");
    setInstructionEditing(true);
    setInstructionDirty(false);
  }, [instruction]);

  // Handle canceling instruction edit
  const handleCancelInstructionEdit = useCallback(() => {
    setInstructionEditing(false);
    setEditingInstructionText("");
    setInstructionDirty(false);
  }, []);

  // Handle saving instruction
  const handleSaveInstruction = useCallback(async () => {
    if (!displayBranch || instructionSaving) return;

    setInstructionSaving(true);
    try {
      const updated = await api.updateTaskInstruction(repoId, displayBranch, editingInstructionText);
      setInstruction(updated);
      setInstructionDirty(false);
      // Don't close edit mode, let user continue editing if they want
    } catch (err) {
      console.error("Failed to save instruction:", err);
    } finally {
      setInstructionSaving(false);
    }
  }, [repoId, displayBranch, editingInstructionText, instructionSaving]);

  // Reset editing state when branch changes
  useEffect(() => {
    setInstructionEditing(false);
    setEditingInstructionText("");
    setInstructionDirty(false);
  }, [displayBranch]);

  // Handle refresh all branch links
  const handleRefreshAll = useCallback(async () => {
    if (!repoId || executeBranches.length === 0 || isRefreshing) return;
    setIsRefreshing(true);
    try {
      // Find all PR links that have IDs
      const prLinksToRefresh: { branchName: string; linkId: number }[] = [];
      allBranchLinks.forEach((links, branchName) => {
        const prLink = links.find((l) => l.linkType === "pr" && l.id);
        if (prLink) {
          prLinksToRefresh.push({ branchName, linkId: prLink.id });
        }
      });

      // Refresh all PR links in parallel
      await Promise.allSettled(
        prLinksToRefresh.map(({ linkId }) => api.refreshBranchLink(linkId))
      );

      // Reload all branch links
      const batchResult = await api.getBranchLinksBatch(repoId, executeBranches);
      const linksMap = new Map<string, BranchLink[]>();
      for (const branch of executeBranches) {
        linksMap.set(branch, batchResult[branch] || []);
      }
      setAllBranchLinks(linksMap);
    } catch (err) {
      console.error("Failed to refresh branch links:", err);
    } finally {
      setIsRefreshing(false);
    }
  }, [repoId, executeBranches, allBranchLinks, isRefreshing]);

  if (!displayBranch) {
    return (
      <div className="execute-sidebar execute-sidebar--empty">
        <p>No branches selected</p>
      </div>
    );
  }

  const isCurrent = displayBranch === currentBranch;
  const prLink = branchLinks.find((l) => l.linkType === "pr");
  const issueLink = branchLinks.find((l) => l.linkType === "issue");

  return (
    <div className="execute-sidebar">
      {/* Branch Tree (compact) with refresh button */}
      <div className="execute-sidebar__branches">
        <ExecuteBranchTree
          branches={executeBranches}
          selectedBranchIndex={previewBranch ? executeBranches.indexOf(previewBranch) : currentExecuteIndex}
          aiBranchIndex={workingBranch ? executeBranches.indexOf(workingBranch) : null}
          onBranchSelect={(_branch, index) => handlePreviewBranch(executeBranches[index])}
          completedBranches={completedBranches}
          branchTodoCounts={branchTodoCounts}
          branchQuestionCounts={branchQuestionCounts}
          branchLinks={allBranchLinks}
          branchResourceCounts={allResourceCounts}
          branchInstructionStatus={allInstructionStatuses}
          onRefresh={handleRefreshAll}
          isRefreshing={isRefreshing}
          onExpandToggle={onExpandToggle}
          isExpanded={isExpanded}
        />
      </div>

      {/* Tabs - using planning-panel classes for consistent styling */}
      <div className="planning-panel__sidebar-tabs">
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "info" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("info")}
        >
          Info
        </button>
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "instruction" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("instruction")}
        >
          Instruction
        </button>
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "todo" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("todo")}
        >
          ToDo
        </button>
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "questions" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("questions")}
        >
          Questions
          {(displayBranchQuestionCount.pending > 0 || displayBranchQuestionCount.answered > 0) && (
            <span className="execute-sidebar__tab-badge">
              {displayBranchQuestionCount.pending + displayBranchQuestionCount.answered}
            </span>
          )}
        </button>
        <button
          className={`planning-panel__sidebar-tab ${activeTab === "resources" ? "planning-panel__sidebar-tab--active" : ""}`}
          onClick={() => setActiveTab("resources")}
        >
          Resources
          {(externalLinks.length > 0 || branchFiles.length > 0) && (
            <span className="execute-sidebar__tab-badge">
              {externalLinks.length + branchFiles.length}
            </span>
          )}
        </button>
      </div>

      {/* Common Header - shown on all tabs */}
      <div className="execute-sidebar__instruction-header">
        <div className="execute-sidebar__branch-nav">
          <span className="execute-sidebar__branch-label">{displayBranch}</span>
          <button
            className={`execute-sidebar__branch-copy-btn ${copied ? "execute-sidebar__branch-copy-btn--copied" : ""}`}
            onClick={() => {
              if (displayBranch) {
                navigator.clipboard.writeText(displayBranch);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
            title="Copy branch name"
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
                <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
              </svg>
            )}
          </button>
          <button
            className="execute-sidebar__branch-nav-btn"
            onClick={() => {
              const currentIndex = executeBranches.indexOf(displayBranch || "");
              if (currentIndex > 0) {
                handlePreviewBranch(executeBranches[currentIndex - 1]);
              }
            }}
            disabled={executeBranches.indexOf(displayBranch || "") <= 0}
            title="Previous branch"
          >
            ↑
          </button>
          <button
            className="execute-sidebar__branch-nav-btn"
            onClick={() => {
              const currentIndex = executeBranches.indexOf(displayBranch || "");
              if (currentIndex < executeBranches.length - 1) {
                handlePreviewBranch(executeBranches[currentIndex + 1]);
              }
            }}
            disabled={executeBranches.indexOf(displayBranch || "") >= executeBranches.length - 1}
            title="Next branch"
          >
            ↓
          </button>
        </div>
        <div className="execute-sidebar__instruction-actions">
          {instructionDirty && (
            <span className="execute-sidebar__instruction-dirty">unsaved</span>
          )}
          {/* Confirm button for planning sessions */}
          {sessionType === "planning" && instruction?.instructionMd && !instructionEditing && (
            <button
              className={`execute-sidebar__confirm-btn execute-sidebar__confirm-btn--${instruction.confirmationStatus}`}
              onClick={handleConfirmToggle}
              disabled={confirming}
              title={
                instruction.confirmationStatus === "confirmed"
                  ? "Click to unconfirm"
                  : instruction.confirmationStatus === "changed"
                  ? "Instruction changed since last confirmation - click to re-confirm"
                  : "Click to confirm instruction"
              }
            >
              {confirming ? (
                "..."
              ) : instruction.confirmationStatus === "confirmed" ? (
                <>✓ Confirmed</>
              ) : instruction.confirmationStatus === "changed" ? (
                <>⚠ Changed</>
              ) : (
                "Confirm"
              )}
            </button>
          )}
        </div>
      </div>

      {/* Tab Content - using planning-panel classes for consistent styling */}
      <div className="planning-panel__sidebar-content">
        {activeTab === "info" && (
          <div className="execute-sidebar__info-tab">
            {/* Issue Section */}
            <div className="execute-sidebar__links-section">
              <div className="execute-sidebar__links-header">
                <h4>Issue</h4>
              </div>
              {issueLink ? (() => {
                const rawLabels = issueLink.labels ? JSON.parse(issueLink.labels) : [];
                const labels: GitHubLabel[] = rawLabels.map((l: string | GitHubLabel) =>
                  typeof l === "string" ? { name: l, color: "6b7280" } : l
                );
                const getTextColor = (bgColor: string) => {
                  const r = parseInt(bgColor.slice(0, 2), 16);
                  const g = parseInt(bgColor.slice(2, 4), 16);
                  const b = parseInt(bgColor.slice(4, 6), 16);
                  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                  return luminance > 0.5 ? "#000" : "#fff";
                };
                return (
                  <div className="execute-sidebar__link-item">
                    <a
                      href={issueLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="execute-sidebar__link-url"
                    >
                      <span className="execute-sidebar__link-number">#{issueLink.number}</span>
                      {issueLink.title}
                    </a>
                    {issueLink.projectStatus && (
                      <span className="execute-sidebar__link-project">{issueLink.projectStatus}</span>
                    )}
                    {labels.length > 0 && (
                      <div className="execute-sidebar__link-labels">
                        {labels.map((l, i) => (
                          <span
                            key={i}
                            className="execute-sidebar__link-label"
                            style={{ backgroundColor: `#${l.color}`, color: getTextColor(l.color) }}
                          >
                            {l.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })() : (
                <div className="execute-sidebar__no-links">No issue linked</div>
              )}
            </div>

            {/* PR Section */}
            <div className="execute-sidebar__links-section">
              <div className="execute-sidebar__links-header">
                <h4>PR</h4>
              </div>
              {prLink ? (() => {
                const rawLabels = prLink.labels ? JSON.parse(prLink.labels) : [];
                const labels: GitHubLabel[] = rawLabels.map((l: string | GitHubLabel) =>
                  typeof l === "string" ? { name: l, color: "6b7280" } : l
                );
                const reviewers = prLink.reviewers ? JSON.parse(prLink.reviewers) as string[] : [];
                const checks: GitHubCheck[] = prLink.checks ? JSON.parse(prLink.checks) : [];
                const passedChecks = checks.filter((c) => c.conclusion === "SUCCESS" || c.conclusion === "SKIPPED").length;
                const totalChecks = checks.length;
                const getTextColor = (bgColor: string) => {
                  const r = parseInt(bgColor.slice(0, 2), 16);
                  const g = parseInt(bgColor.slice(2, 4), 16);
                  const b = parseInt(bgColor.slice(4, 6), 16);
                  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                  return luminance > 0.5 ? "#000" : "#fff";
                };
                return (
                  <div className="execute-sidebar__link-item execute-sidebar__link-item--detailed">
                    <div className="execute-sidebar__link-main">
                      <a
                        href={prLink.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="execute-sidebar__link-url"
                      >
                        <span className="execute-sidebar__link-number">#{prLink.number}</span>
                        {prLink.title}
                      </a>
                    </div>
                    <div className="execute-sidebar__link-meta">
                      {totalChecks > 0 && (
                        <span className={`execute-sidebar__ci-badge execute-sidebar__ci-badge--${prLink.checksStatus}`}>
                          <span className="execute-sidebar__ci-badge-icon">
                            {prLink.checksStatus === "success" ? "✓" : prLink.checksStatus === "failure" ? "✗" : "●"}
                          </span>
                          <span className="execute-sidebar__ci-badge-count">{passedChecks}/{totalChecks}</span>
                        </span>
                      )}
                      {prLink.reviewDecision && (
                        <span className={`execute-sidebar__review-badge execute-sidebar__review-badge--${prLink.reviewDecision.toLowerCase().replace("_", "-")}`}>
                          {prLink.reviewDecision === "APPROVED" ? "Approved" :
                           prLink.reviewDecision === "CHANGES_REQUESTED" ? "Changes" :
                           prLink.reviewDecision === "REVIEW_REQUIRED" ? "Review Required" : prLink.reviewDecision}
                        </span>
                      )}
                      {prLink.projectStatus && (
                        <span className="execute-sidebar__link-project">{prLink.projectStatus}</span>
                      )}
                      <span className="execute-sidebar__link-reviewers">
                        {reviewers.length > 0 ? (
                          reviewers.map((r, i) => (
                            <span key={i} className="execute-sidebar__link-reviewer">{r}</span>
                          ))
                        ) : (
                          <span className="execute-sidebar__link-reviewer execute-sidebar__link-reviewer--none">No Reviewers</span>
                        )}
                      </span>
                    </div>
                    {labels.length > 0 && (
                      <div className="execute-sidebar__pr-labels">
                        {labels.map((l, i) => (
                          <span
                            key={i}
                            className="execute-sidebar__pr-label"
                            style={{ backgroundColor: `#${l.color}`, color: getTextColor(l.color) }}
                          >
                            {l.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })() : (
                <div className="execute-sidebar__no-links">No PR linked</div>
              )}
            </div>
          </div>
        )}

        {activeTab === "instruction" && (
          <div className="planning-panel__instruction">
            {instructionLoading ? (
              <div className="planning-panel__instruction-loading">Loading...</div>
            ) : (
              <>
                {instructionEditing ? (
                  <>
                    <textarea
                      className="planning-panel__instruction-textarea"
                      value={editingInstructionText}
                      onChange={(e) => {
                        setEditingInstructionText(e.target.value);
                        setInstructionDirty(true);
                      }}
                      placeholder="Enter detailed task instructions..."
                    />
                    <div className="execute-sidebar__instruction-edit-actions">
                      <button
                        className="planning-panel__instruction-save"
                        onClick={handleSaveInstruction}
                        disabled={!instructionDirty || instructionSaving}
                      >
                        {instructionSaving ? "Saving..." : "Save"}
                      </button>
                      <button
                        className="execute-sidebar__instruction-done-btn"
                        onClick={handleCancelInstructionEdit}
                      >
                        Done
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="execute-sidebar__instruction-content">
                    {/* Edit button (pencil icon) - only for planning sessions */}
                    {sessionType === "planning" && (
                      <button
                        className="execute-sidebar__instruction-pencil-btn"
                        onClick={handleStartInstructionEdit}
                        title="Edit instruction"
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>
                        </svg>
                      </button>
                    )}
                    {instruction?.instructionMd ? (
                      <div className="planning-panel__instruction-view">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {instruction.instructionMd}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <span className="planning-panel__instruction-empty">
                        No instruction set for this branch. {sessionType === "planning" && "Click the pencil to add."}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === "todo" && (
          <div className="planning-panel__todo-section">
            <ExecuteTodoList
              repoId={repoId}
              branchName={displayBranch}
              planningSessionId={planningSessionId}
              disabled={!isCurrent}
            />
          </div>
        )}

        {activeTab === "questions" && planningSessionId && (
          <div className="planning-panel__questions-section">
            <PlanningQuestionsPanel
              planningSessionId={planningSessionId}
              branchName={displayBranch}
            />
          </div>
        )}

        {activeTab === "resources" && (
          <div className="planning-panel__resources-section">
            {/* External Links */}
            {externalLinks.length > 0 && (
              <div className="execute-sidebar__links-section">
                <div className="execute-sidebar__links-header">
                  <h4>Links</h4>
                </div>
                <div className="execute-sidebar__external-links">
                  {externalLinks.map((link) => {
                    const icon = getResourceIcon(link.linkType);
                    return (
                      <a
                        key={link.id}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="execute-sidebar__external-link"
                      >
                        <img
                          src={icon.src}
                          alt={icon.alt}
                          className={`execute-sidebar__link-icon execute-sidebar__link-icon${icon.className}`}
                        />
                        <span className="execute-sidebar__external-link-text">
                          {link.title || link.url}
                        </span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Files/Images */}
            {branchFiles.length > 0 && (
              <div className="execute-sidebar__links-section">
                <div className="execute-sidebar__links-header">
                  <h4>Files</h4>
                </div>
                <div className="execute-sidebar__files">
                  {branchFiles.map((file) => {
                    const isImage = file.mimeType?.startsWith("image/");
                    return (
                      <div key={file.id} className="execute-sidebar__file">
                        {isImage ? (
                          <a
                            href={api.getBranchFileUrl(file.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="execute-sidebar__file-image-link"
                          >
                            <img
                              src={api.getBranchFileUrl(file.id)}
                              alt={file.originalName || "Image"}
                              className="execute-sidebar__file-thumbnail"
                            />
                          </a>
                        ) : (
                          <a
                            href={api.getBranchFileUrl(file.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="execute-sidebar__file-link"
                          >
                            📄 {file.originalName || file.filePath}
                          </a>
                        )}
                        {file.description && (
                          <span className="execute-sidebar__file-description">{file.description}</span>
                        )}
                        {file.sourceType === "figma_mcp" && (
                          <span className="execute-sidebar__file-source">From Figma</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {externalLinks.length === 0 && branchFiles.length === 0 && (
              <div className="execute-sidebar__no-links">No resources linked</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ExecuteSidebar;
