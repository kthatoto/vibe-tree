import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and, asc } from "drizzle-orm";
import { broadcast } from "../ws";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";

export const todosRouter = new Hono();

// Validation schemas
const getTodosSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
});

const createTodoSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
  planningSessionId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  orderIndex: z.number().optional(),
  source: z.enum(["user", "ai"]).optional(),
});

const updateTodoSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  orderIndex: z.number().optional(),
});

const reorderTodosSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
  todoIds: z.array(z.number()),
});

// GET /api/todos?repoId=...&branchName=...
todosRouter.get("/", async (c) => {
  const query = validateOrThrow(getTodosSchema, {
    repoId: c.req.query("repoId"),
    branchName: c.req.query("branchName"),
  });

  const todos = await db
    .select()
    .from(schema.taskTodos)
    .where(
      and(
        eq(schema.taskTodos.repoId, query.repoId),
        eq(schema.taskTodos.branchName, query.branchName)
      )
    )
    .orderBy(asc(schema.taskTodos.orderIndex));

  return c.json(todos);
});

// POST /api/todos
todosRouter.post("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createTodoSchema, body);
  const now = new Date().toISOString();

  // Get max orderIndex for this branch
  const existingTodos = await db
    .select()
    .from(schema.taskTodos)
    .where(
      and(
        eq(schema.taskTodos.repoId, input.repoId),
        eq(schema.taskTodos.branchName, input.branchName)
      )
    )
    .orderBy(asc(schema.taskTodos.orderIndex));

  const maxOrderIndex = existingTodos.length > 0
    ? Math.max(...existingTodos.map(t => t.orderIndex)) + 1
    : 0;

  const result = await db
    .insert(schema.taskTodos)
    .values({
      repoId: input.repoId,
      branchName: input.branchName,
      planningSessionId: input.planningSessionId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? "pending",
      orderIndex: input.orderIndex ?? maxOrderIndex,
      source: input.source ?? "user",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const todo = result[0];
  if (!todo) {
    throw new BadRequestError("Failed to create todo");
  }

  broadcast({
    type: "todo.created",
    repoId: input.repoId,
    data: todo,
  });

  return c.json(todo, 201);
});

// PATCH /api/todos/:id
todosRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const body = await c.req.json();
  const input = validateOrThrow(updateTodoSchema, body);
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(schema.taskTodos)
    .where(eq(schema.taskTodos.id, id))
    .limit(1);

  if (!existing) {
    throw new NotFoundError("Todo not found");
  }

  const updates: Record<string, unknown> = { updatedAt: now };
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.status !== undefined) updates.status = input.status;
  if (input.orderIndex !== undefined) updates.orderIndex = input.orderIndex;

  await db
    .update(schema.taskTodos)
    .set(updates)
    .where(eq(schema.taskTodos.id, id));

  const [updated] = await db
    .select()
    .from(schema.taskTodos)
    .where(eq(schema.taskTodos.id, id));

  broadcast({
    type: "todo.updated",
    repoId: existing.repoId,
    data: updated,
  });

  return c.json(updated);
});

// DELETE /api/todos/:id
todosRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const [existing] = await db
    .select()
    .from(schema.taskTodos)
    .where(eq(schema.taskTodos.id, id))
    .limit(1);

  if (!existing) {
    throw new NotFoundError("Todo not found");
  }

  await db.delete(schema.taskTodos).where(eq(schema.taskTodos.id, id));

  broadcast({
    type: "todo.deleted",
    repoId: existing.repoId,
    data: { id, branchName: existing.branchName },
  });

  return c.json({ success: true });
});

// POST /api/todos/reorder
todosRouter.post("/reorder", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(reorderTodosSchema, body);
  const now = new Date().toISOString();

  // Update order for each todo
  for (let i = 0; i < input.todoIds.length; i++) {
    await db
      .update(schema.taskTodos)
      .set({
        orderIndex: i,
        updatedAt: now,
      })
      .where(eq(schema.taskTodos.id, input.todoIds[i]));
  }

  // Fetch updated todos
  const todos = await db
    .select()
    .from(schema.taskTodos)
    .where(
      and(
        eq(schema.taskTodos.repoId, input.repoId),
        eq(schema.taskTodos.branchName, input.branchName)
      )
    )
    .orderBy(asc(schema.taskTodos.orderIndex));

  broadcast({
    type: "todo.reordered",
    repoId: input.repoId,
    data: { branchName: input.branchName, todos },
  });

  return c.json(todos);
});
