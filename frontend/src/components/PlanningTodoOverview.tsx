import { useState, useEffect } from "react";
import { api, type TaskTodo } from "../lib/api";
import { wsClient } from "../lib/ws";
import "./PlanningTodoOverview.css";

interface PlanningTodoOverviewProps {
  repoId: string;
  branches: string[];
  planningSessionId?: string;
}

interface BranchTodoData {
  branchName: string;
  todos: TaskTodo[];
  isExpanded: boolean;
}

export function PlanningTodoOverview({
  repoId,
  branches,
  planningSessionId: _planningSessionId,
}: PlanningTodoOverviewProps) {
  const [branchData, setBranchData] = useState<Map<string, BranchTodoData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());

  // Load todos for all branches
  useEffect(() => {
    if (!repoId || branches.length === 0) {
      setBranchData(new Map());
      setLoading(false);
      return;
    }

    setLoading(true);
    const loadTodos = async () => {
      const newData = new Map<string, BranchTodoData>();
      await Promise.all(
        branches.map(async (branchName) => {
          try {
            const todos = await api.getTodos(repoId, branchName);
            newData.set(branchName, {
              branchName,
              todos,
              isExpanded: expandedBranches.has(branchName),
            });
          } catch {
            newData.set(branchName, {
              branchName,
              todos: [],
              isExpanded: expandedBranches.has(branchName),
            });
          }
        })
      );
      setBranchData(newData);
      setLoading(false);
    };

    loadTodos();
  }, [repoId, branches]);

  // WebSocket updates for todos
  useEffect(() => {
    const updateTodosForBranch = (branchName: string, updater: (todos: TaskTodo[]) => TaskTodo[]) => {
      setBranchData((prev) => {
        const newMap = new Map(prev);
        const current = newMap.get(branchName);
        if (current) {
          newMap.set(branchName, {
            ...current,
            todos: updater(current.todos),
          });
        }
        return newMap;
      });
    };

    const unsubCreated = wsClient.on("todo.created", (msg) => {
      const todo = msg.data as TaskTodo;
      if (branches.includes(todo.branchName)) {
        updateTodosForBranch(todo.branchName, (todos) =>
          [...todos, todo].sort((a, b) => a.orderIndex - b.orderIndex)
        );
      }
    });

    const unsubUpdated = wsClient.on("todo.updated", (msg) => {
      const todo = msg.data as TaskTodo;
      if (branches.includes(todo.branchName)) {
        updateTodosForBranch(todo.branchName, (todos) =>
          todos.map((t) => (t.id === todo.id ? todo : t)).sort((a, b) => a.orderIndex - b.orderIndex)
        );
      }
    });

    const unsubDeleted = wsClient.on("todo.deleted", (msg) => {
      const data = msg.data as { id: number; branchName: string };
      if (branches.includes(data.branchName)) {
        updateTodosForBranch(data.branchName, (todos) =>
          todos.filter((t) => t.id !== data.id)
        );
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
    };
  }, [branches]);

  const toggleBranch = (branchName: string) => {
    setExpandedBranches((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(branchName)) {
        newSet.delete(branchName);
      } else {
        newSet.add(branchName);
      }
      return newSet;
    });
  };

  // Calculate overall progress
  const totalTodos = Array.from(branchData.values()).reduce(
    (sum, data) => sum + data.todos.length,
    0
  );
  const completedTodos = Array.from(branchData.values()).reduce(
    (sum, data) => sum + data.todos.filter((t) => t.status === "completed").length,
    0
  );

  if (loading) {
    return (
      <div className="planning-todo-overview planning-todo-overview--loading">
        <div className="planning-todo-overview__spinner" />
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <div className="planning-todo-overview planning-todo-overview--empty">
        <p>No branches selected</p>
      </div>
    );
  }

  return (
    <div className="planning-todo-overview">
      <div className="planning-todo-overview__header">
        <h4>ToDo Overview</h4>
        {totalTodos > 0 && (
          <span className="planning-todo-overview__progress">
            {completedTodos}/{totalTodos}
          </span>
        )}
      </div>

      <div className="planning-todo-overview__branches">
        {branches.map((branchName) => {
          const data = branchData.get(branchName);
          const todos = data?.todos || [];
          const completedCount = todos.filter((t) => t.status === "completed").length;
          const isExpanded = expandedBranches.has(branchName);
          const isComplete = todos.length > 0 && completedCount === todos.length;

          return (
            <div
              key={branchName}
              className={`planning-todo-overview__branch ${isComplete ? "planning-todo-overview__branch--complete" : ""}`}
            >
              <div
                className="planning-todo-overview__branch-header"
                onClick={() => toggleBranch(branchName)}
              >
                <span className="planning-todo-overview__branch-toggle">
                  {isExpanded ? "▼" : "▶"}
                </span>
                <span className="planning-todo-overview__branch-name">{branchName}</span>
                <span className="planning-todo-overview__branch-count">
                  {todos.length > 0 ? `${completedCount}/${todos.length}` : "0"}
                </span>
                {isComplete && (
                  <span className="planning-todo-overview__branch-done">✓</span>
                )}
              </div>

              {isExpanded && (
                <div className="planning-todo-overview__branch-todos">
                  {todos.length === 0 ? (
                    <div className="planning-todo-overview__no-todos">
                      No todos
                    </div>
                  ) : (
                    todos.map((todo) => (
                      <div
                        key={todo.id}
                        className={`planning-todo-overview__todo planning-todo-overview__todo--${todo.status}`}
                      >
                        <span className="planning-todo-overview__todo-status">
                          {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "●" : "○"}
                        </span>
                        <span className="planning-todo-overview__todo-title">{todo.title}</span>
                        {todo.source === "ai" && (
                          <span className="planning-todo-overview__todo-ai">AI</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PlanningTodoOverview;
