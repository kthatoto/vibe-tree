import { useState, useEffect, useCallback } from "react";
import { api, type TaskTodo, type TaskTodoStatus } from "../lib/api";
import { wsClient } from "../lib/ws";
import "./ExecuteTodoList.css";

interface ExecuteTodoListProps {
  repoId: string;
  branchName: string;
  planningSessionId?: string;
  disabled?: boolean;
}

export function ExecuteTodoList({
  repoId,
  branchName,
  planningSessionId,
  disabled = false,
}: ExecuteTodoListProps) {
  const [todos, setTodos] = useState<TaskTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTodoTitle, setNewTodoTitle] = useState("");
  const [addingTodo, setAddingTodo] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  // Load todos
  useEffect(() => {
    if (!repoId || !branchName) return;
    setLoading(true);
    api
      .getTodos(repoId, branchName)
      .then(setTodos)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [repoId, branchName]);

  // WebSocket updates
  useEffect(() => {
    const unsubCreated = wsClient.on("todo.created", (msg) => {
      const todo = msg.data as TaskTodo;
      if (todo.branchName === branchName && todo.repoId === repoId) {
        setTodos((prev) => [...prev, todo].sort((a, b) => a.orderIndex - b.orderIndex));
      }
    });

    const unsubUpdated = wsClient.on("todo.updated", (msg) => {
      const todo = msg.data as TaskTodo;
      if (todo.branchName === branchName && todo.repoId === repoId) {
        setTodos((prev) =>
          prev.map((t) => (t.id === todo.id ? todo : t)).sort((a, b) => a.orderIndex - b.orderIndex)
        );
      }
    });

    const unsubDeleted = wsClient.on("todo.deleted", (msg) => {
      const data = msg.data as { id: number; branchName: string };
      if (data.branchName === branchName) {
        setTodos((prev) => prev.filter((t) => t.id !== data.id));
      }
    });

    const unsubReordered = wsClient.on("todo.reordered", (msg) => {
      const data = msg.data as { branchName: string; todos: TaskTodo[] };
      if (data.branchName === branchName) {
        setTodos(data.todos);
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
      unsubReordered();
    };
  }, [repoId, branchName]);

  const handleAddTodo = useCallback(async () => {
    if (!newTodoTitle.trim() || addingTodo || disabled) return;
    setAddingTodo(true);
    try {
      const todo = await api.createTodo({
        repoId,
        branchName,
        planningSessionId,
        title: newTodoTitle.trim(),
        source: "user",
      });
      setTodos((prev) => [...prev, todo].sort((a, b) => a.orderIndex - b.orderIndex));
      setNewTodoTitle("");
    } catch (err) {
      console.error("Failed to add todo:", err);
    } finally {
      setAddingTodo(false);
    }
  }, [repoId, branchName, planningSessionId, newTodoTitle, addingTodo, disabled]);

  const handleToggleStatus = useCallback(
    async (todo: TaskTodo) => {
      if (disabled) return;
      const nextStatus: TaskTodoStatus =
        todo.status === "completed" ? "pending" : "completed";
      try {
        await api.updateTodo(todo.id, { status: nextStatus });
      } catch (err) {
        console.error("Failed to update todo:", err);
      }
    },
    [disabled]
  );

  const handleUpdateTitle = useCallback(async () => {
    if (editingId === null || !editingTitle.trim() || disabled) return;
    try {
      await api.updateTodo(editingId, { title: editingTitle.trim() });
    } catch (err) {
      console.error("Failed to update todo:", err);
    } finally {
      setEditingId(null);
      setEditingTitle("");
    }
  }, [editingId, editingTitle, disabled]);

  const handleDeleteTodo = useCallback(
    async (id: number) => {
      if (disabled) return;
      try {
        await api.deleteTodo(id);
      } catch (err) {
        console.error("Failed to delete todo:", err);
      }
    },
    [disabled]
  );

  const startEditing = (todo: TaskTodo) => {
    if (disabled) return;
    setEditingId(todo.id);
    setEditingTitle(todo.title);
  };

  const getStatusIcon = (status: TaskTodoStatus) => {
    switch (status) {
      case "completed":
        return "✓";
      case "in_progress":
        return "●";
      default:
        return "○";
    }
  };

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const totalCount = todos.length;

  if (loading) {
    return (
      <div className="execute-todo-list execute-todo-list--loading">
        <div className="execute-todo-list__spinner" />
      </div>
    );
  }

  return (
    <div className="execute-todo-list">
      <div className="execute-todo-list__header">
        <h4>ToDo</h4>
        {totalCount > 0 && (
          <span className="execute-todo-list__progress">
            {completedCount}/{totalCount}
          </span>
        )}
      </div>

      <div className="execute-todo-list__items">
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={`execute-todo-list__item execute-todo-list__item--${todo.status} ${todo.source === "ai" ? "execute-todo-list__item--ai" : ""}`}
          >
            <button
              className={`execute-todo-list__checkbox execute-todo-list__checkbox--${todo.status}`}
              onClick={() => handleToggleStatus(todo)}
              disabled={disabled}
            >
              {getStatusIcon(todo.status)}
            </button>

            {editingId === todo.id ? (
              <input
                type="text"
                className="execute-todo-list__edit-input"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={handleUpdateTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleUpdateTitle();
                  if (e.key === "Escape") {
                    setEditingId(null);
                    setEditingTitle("");
                  }
                }}
                autoFocus
              />
            ) : (
              <span
                className="execute-todo-list__title"
                onClick={() => startEditing(todo)}
              >
                {todo.title}
              </span>
            )}

            {todo.source === "ai" && (
              <span className="execute-todo-list__ai-badge" title="AI suggested">
                AI
              </span>
            )}

            {!disabled && (
              <button
                className="execute-todo-list__delete"
                onClick={() => handleDeleteTodo(todo.id)}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {!disabled && (
        <div className="execute-todo-list__add">
          <input
            type="text"
            className="execute-todo-list__add-input"
            placeholder="Add todo..."
            value={newTodoTitle}
            onChange={(e) => setNewTodoTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddTodo();
            }}
            disabled={addingTodo}
          />
          <button
            className="execute-todo-list__add-btn"
            onClick={handleAddTodo}
            disabled={addingTodo || !newTodoTitle.trim()}
          >
            +
          </button>
        </div>
      )}

      {totalCount === 0 && !disabled && (
        <div className="execute-todo-list__empty">
          No todos yet. Add one above or let AI suggest tasks.
        </div>
      )}
    </div>
  );
}

export default ExecuteTodoList;
