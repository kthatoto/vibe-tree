import { z } from "zod";
import { getDb, getTodos } from "../db/client";
import {
  broadcastTodoCreated,
  broadcastTodoUpdated,
  broadcastTodoDeleted,
} from "../ws/notifier";

// Get todos schema
export const getTodosSchema = z.object({
  repoId: z.string().describe("Repository ID (owner/repo format)"),
  branchName: z.string().describe("Branch name"),
});

export type GetTodosInput = z.infer<typeof getTodosSchema>;

interface GetTodosOutput {
  branchName: string;
  todos: Array<{
    id: number;
    title: string;
    description: string | null;
    status: string;
    orderIndex: number;
  }>;
}

export function getTodosList(input: GetTodosInput): GetTodosOutput {
  const todoRows = getTodos(input.repoId, input.branchName);

  return {
    branchName: input.branchName,
    todos: todoRows.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      orderIndex: t.order_index,
    })),
  };
}

// Schema definitions
export const addTodoSchema = z.object({
  repoId: z.string().describe("Repository ID (owner/repo format)"),
  branchName: z.string().describe("Branch name"),
  planningSessionId: z.string().optional().describe("Planning session ID"),
  title: z.string().describe("Todo title"),
  description: z.string().optional().describe("Todo description"),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .optional()
    .describe("Initial status"),
});

export const updateTodoSchema = z.object({
  todoId: z.number().describe("Todo ID"),
  title: z.string().optional().describe("New title"),
  description: z.string().optional().describe("New description"),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .optional()
    .describe("New status"),
});

export const completeTodoSchema = z.object({
  todoId: z.number().describe("Todo ID to mark as completed"),
});

export const deleteTodoSchema = z.object({
  todoId: z.number().describe("Todo ID to delete"),
});

export type AddTodoInput = z.infer<typeof addTodoSchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;
export type CompleteTodoInput = z.infer<typeof completeTodoSchema>;
export type DeleteTodoInput = z.infer<typeof deleteTodoSchema>;

interface TodoOutput {
  id: number;
  repoId: string;
  branchName: string;
  title: string;
  description: string | null;
  status: string;
  orderIndex: number;
}

// Get todo by ID helper
function getTodoById(id: number) {
  const db = getDb();
  return db.prepare(`SELECT * FROM task_todos WHERE id = ?`).get(id) as
    | {
        id: number;
        repo_id: string;
        branch_name: string;
        planning_session_id: string | null;
        title: string;
        description: string | null;
        status: string;
        order_index: number;
        source: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
}

function toTodoOutput(row: ReturnType<typeof getTodoById>): TodoOutput {
  if (!row) throw new Error("Todo not found");
  return {
    id: row.id,
    repoId: row.repo_id,
    branchName: row.branch_name,
    title: row.title,
    description: row.description,
    status: row.status,
    orderIndex: row.order_index,
  };
}

export function addTodo(input: AddTodoInput): TodoOutput {
  const db = getDb();
  const now = new Date().toISOString();

  // Get max orderIndex for this branch
  const existingTodos = getTodos(input.repoId, input.branchName);
  const maxOrderIndex =
    existingTodos.length > 0
      ? Math.max(...existingTodos.map((t) => t.order_index)) + 1
      : 0;

  const stmt = db.prepare(
    `INSERT INTO task_todos (repo_id, branch_name, planning_session_id, title, description, status, order_index, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const info = stmt.run(
    input.repoId,
    input.branchName,
    input.planningSessionId ?? null,
    input.title,
    input.description ?? null,
    input.status ?? "pending",
    maxOrderIndex,
    "ai",
    now,
    now
  );

  const created = getTodoById(info.lastInsertRowid as number);
  const output = toTodoOutput(created);

  broadcastTodoCreated(input.repoId, {
    ...output,
    source: "ai",
    planningSessionId: input.planningSessionId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return output;
}

export function updateTodo(input: UpdateTodoInput): TodoOutput {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = getTodoById(input.todoId);
  if (!existing) {
    throw new Error(`Todo not found: ${input.todoId}`);
  }

  const updates: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

  if (input.title !== undefined) {
    updates.push("title = ?");
    values.push(input.title);
  }
  if (input.description !== undefined) {
    updates.push("description = ?");
    values.push(input.description);
  }
  if (input.status !== undefined) {
    updates.push("status = ?");
    values.push(input.status);
  }

  values.push(input.todoId);

  db.prepare(
    `UPDATE task_todos SET ${updates.join(", ")} WHERE id = ?`
  ).run(...values);

  const updated = getTodoById(input.todoId);
  const output = toTodoOutput(updated);

  broadcastTodoUpdated(existing.repo_id, {
    ...output,
    source: updated!.source,
    planningSessionId: updated!.planning_session_id,
    createdAt: updated!.created_at,
    updatedAt: updated!.updated_at,
  });

  return output;
}

export function completeTodo(input: CompleteTodoInput): TodoOutput {
  return updateTodo({ todoId: input.todoId, status: "completed" });
}

export function deleteTodo(input: DeleteTodoInput): { success: boolean } {
  const db = getDb();

  const existing = getTodoById(input.todoId);
  if (!existing) {
    throw new Error(`Todo not found: ${input.todoId}`);
  }

  db.prepare(`DELETE FROM task_todos WHERE id = ?`).run(input.todoId);

  broadcastTodoDeleted(existing.repo_id, {
    id: input.todoId,
    branchName: existing.branch_name,
  });

  return { success: true };
}
