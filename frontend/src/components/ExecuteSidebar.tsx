import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type TaskTodo, type PlanningQuestion, type BranchLink, type TaskInstruction } from "../lib/api";
import { wsClient } from "../lib/ws";
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
}

export function ExecuteSidebar({
  repoId,
  executeBranches,
  currentExecuteIndex,
  planningSessionId,
  onManualBranchSwitch,
  onBranchCompleted,
  workingBranch,
}: ExecuteSidebarProps) {
  // Preview branch (clicked but not switched to)
  const [previewBranch, setPreviewBranch] = useState<string | null>(null);

  // Active tab: "instruction", "todo", or "questions"
  const [activeTab, setActiveTab] = useState<"instruction" | "todo" | "questions">("instruction");

  // All todos for all branches (for completion tracking)
  const [allTodos, setAllTodos] = useState<Map<string, TaskTodo[]>>(new Map());

  // All questions for all branches (for badge counts)
  const [allQuestions, setAllQuestions] = useState<PlanningQuestion[]>([]);

  // All branch links for all branches (for PR status in tree)
  const [allBranchLinks, setAllBranchLinks] = useState<Map<string, BranchLink[]>>(new Map());

  // Branch links and instruction for display branch
  const [branchLinks, setBranchLinks] = useState<BranchLink[]>([]);
  const [instruction, setInstruction] = useState<TaskInstruction | null>(null);
  const [instructionLoading, setInstructionLoading] = useState(false);

  // Current branch (actual execution target)
  const currentBranch = executeBranches[currentExecuteIndex] || null;

  // Display branch (preview if set, otherwise current)
  const displayBranch = previewBranch || currentBranch;

  // Reset preview when current branch changes
  useEffect(() => {
    setPreviewBranch(null);
  }, [currentExecuteIndex]);

  // Load branch links and instruction for display branch
  useEffect(() => {
    if (!repoId || !displayBranch) {
      setBranchLinks([]);
      setInstruction(null);
      return;
    }
    setInstructionLoading(true);
    Promise.all([
      api.getBranchLinks(repoId, displayBranch).catch(() => []),
      api.getTaskInstruction(repoId, displayBranch).catch(() => null),
    ])
      .then(([links, inst]) => {
        setBranchLinks(links);
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

  // Load all branch links for all branches
  useEffect(() => {
    if (!repoId || executeBranches.length === 0) return;

    const loadAllBranchLinks = async () => {
      const linksMap = new Map<string, BranchLink[]>();
      await Promise.all(
        executeBranches.map(async (branch) => {
          try {
            const links = await api.getBranchLinks(repoId, branch);
            linksMap.set(branch, links);
          } catch {
            linksMap.set(branch, []);
          }
        })
      );
      setAllBranchLinks(linksMap);
    };

    loadAllBranchLinks();
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

  // Handle switch to branch
  const handleSwitchToBranch = useCallback(() => {
    if (!previewBranch || !onManualBranchSwitch) return;
    const index = executeBranches.indexOf(previewBranch);
    if (index !== -1) {
      onManualBranchSwitch(index);
      setPreviewBranch(null);
    }
  }, [previewBranch, executeBranches, onManualBranchSwitch]);

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

  const getChecksStatusIcon = (status: string | null) => {
    switch (status) {
      case "success": return "✓";
      case "failure": return "✕";
      case "pending": return "◌";
      default: return "";
    }
  };

  return (
    <div className="execute-sidebar">
      {/* Branch Tree (compact) */}
      <div className="execute-sidebar__branches">
        <ExecuteBranchTree
          branches={executeBranches}
          currentBranchIndex={currentExecuteIndex}
          previewBranch={previewBranch}
          onPreviewBranch={handlePreviewBranch}
          completedBranches={completedBranches}
          branchTodoCounts={branchTodoCounts}
          branchQuestionCounts={branchQuestionCounts}
          branchLinks={allBranchLinks}
          workingBranch={workingBranch}
        />
      </div>

      {/* Branch Header with PR/Issue links */}
      <div className="execute-sidebar__branch-header">
        <div className="execute-sidebar__branch-name">
          {displayBranch}
          {isCurrent ? (
            <span className="execute-sidebar__current-badge">Current</span>
          ) : (
            onManualBranchSwitch && (
              <button
                className="execute-sidebar__switch-btn"
                onClick={handleSwitchToBranch}
              >
                Switch
              </button>
            )
          )}
        </div>
        {(prLink || issueLink) && (
          <div className="execute-sidebar__links">
            {prLink && (
              <a
                href={prLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="execute-sidebar__link execute-sidebar__link--pr"
              >
                PR #{prLink.number}
                {prLink.checksStatus && (
                  <span className={`execute-sidebar__checks execute-sidebar__checks--${prLink.checksStatus}`}>
                    {getChecksStatusIcon(prLink.checksStatus)}
                  </span>
                )}
              </a>
            )}
            {issueLink && (
              <a
                href={issueLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="execute-sidebar__link execute-sidebar__link--issue"
              >
                Issue #{issueLink.number}
              </a>
            )}
          </div>
        )}
      </div>

      {/* Tabs - using planning-panel classes for consistent styling */}
      <div className="planning-panel__sidebar-tabs">
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
      </div>

      {/* Tab Content - using planning-panel classes for consistent styling */}
      <div className="planning-panel__sidebar-content">
        {activeTab === "instruction" && (
          <div className="planning-panel__instruction">
            {instructionLoading ? (
              <div className="planning-panel__instruction-loading">Loading...</div>
            ) : instruction?.instructionMd ? (
              <div className="planning-panel__instruction-view">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {instruction.instructionMd}
                </ReactMarkdown>
              </div>
            ) : (
              <span className="planning-panel__instruction-empty">
                No instruction set for this branch
              </span>
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
              disabled={!isCurrent}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default ExecuteSidebar;
