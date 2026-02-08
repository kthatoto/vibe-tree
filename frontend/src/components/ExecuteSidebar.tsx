import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { api, type TaskTodo, type PlanningQuestion } from "../lib/api";
import { wsClient } from "../lib/ws";
import ExecuteBranchTree from "./ExecuteBranchTree";
import ExecuteBranchDetail from "./ExecuteBranchDetail";
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

  // Active tab: "todo" or "questions"
  const [activeTab, setActiveTab] = useState<"todo" | "questions">("todo");

  // All todos for all branches (for completion tracking)
  const [allTodos, setAllTodos] = useState<Map<string, TaskTodo[]>>(new Map());

  // All questions for all branches (for badge counts)
  const [allQuestions, setAllQuestions] = useState<PlanningQuestion[]>([]);

  // Current branch (actual execution target)
  const currentBranch = executeBranches[currentExecuteIndex] || null;

  // Display branch (preview if set, otherwise current)
  const displayBranch = previewBranch || currentBranch;

  // Reset preview when current branch changes
  useEffect(() => {
    setPreviewBranch(null);
  }, [currentExecuteIndex]);

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

  return (
    <div className="execute-sidebar">
      {/* Branch Tree */}
      <div className="execute-sidebar__section">
        <ExecuteBranchTree
          branches={executeBranches}
          currentBranchIndex={currentExecuteIndex}
          previewBranch={previewBranch}
          onPreviewBranch={handlePreviewBranch}
          completedBranches={completedBranches}
          branchTodoCounts={branchTodoCounts}
          branchQuestionCounts={branchQuestionCounts}
          workingBranch={workingBranch}
        />
      </div>

      {/* Branch Detail */}
      <div className="execute-sidebar__section">
        <ExecuteBranchDetail
          repoId={repoId}
          branchName={displayBranch}
          isCurrent={isCurrent}
          onSwitchToBranch={!isCurrent && onManualBranchSwitch ? handleSwitchToBranch : undefined}
        />
      </div>

      {/* Tabs */}
      <div className="execute-sidebar__tabs">
        <button
          className={`execute-sidebar__tab ${activeTab === "todo" ? "execute-sidebar__tab--active" : ""}`}
          onClick={() => setActiveTab("todo")}
        >
          ToDo
        </button>
        <button
          className={`execute-sidebar__tab ${activeTab === "questions" ? "execute-sidebar__tab--active" : ""}`}
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

      {/* Tab Content */}
      {activeTab === "todo" && (
        <div className="execute-sidebar__section execute-sidebar__section--todos">
          <ExecuteTodoList
            repoId={repoId}
            branchName={displayBranch}
            planningSessionId={planningSessionId}
            disabled={!isCurrent}
          />
        </div>
      )}

      {activeTab === "questions" && planningSessionId && (
        <div className="execute-sidebar__section execute-sidebar__section--questions">
          <PlanningQuestionsPanel
            planningSessionId={planningSessionId}
            branchName={displayBranch}
            disabled={!isCurrent}
          />
        </div>
      )}
    </div>
  );
}

export default ExecuteSidebar;
