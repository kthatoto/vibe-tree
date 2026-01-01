import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../../db";
import { randomUUID } from "crypto";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";
import { broadcast } from "../ws";

export const planningSessionsRouter = new Hono();

// Types
interface TaskNode {
  id: string;
  title: string;
  description?: string;
  branchName?: string;
}

interface TaskEdge {
  parent: string;
  child: string;
}

interface PlanningSession {
  id: string;
  repoId: string;
  title: string;
  baseBranch: string;
  status: "draft" | "confirmed" | "discarded";
  nodes: TaskNode[];
  edges: TaskEdge[];
  chatSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Helper to convert DB row to PlanningSession
function toSession(row: typeof schema.planningSessions.$inferSelect): PlanningSession {
  return {
    id: row.id,
    repoId: row.repoId,
    title: row.title,
    baseBranch: row.baseBranch,
    status: row.status as PlanningSession["status"],
    nodes: JSON.parse(row.nodesJson) as TaskNode[],
    edges: JSON.parse(row.edgesJson) as TaskEdge[],
    chatSessionId: row.chatSessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Schemas
const createSessionSchema = z.object({
  repoId: z.string().min(1),
  baseBranch: z.string().min(1),
  title: z.string().optional(),
});

const updateSessionSchema = z.object({
  title: z.string().optional(),
  baseBranch: z.string().optional(),
  nodes: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    branchName: z.string().optional(),
  })).optional(),
  edges: z.array(z.object({
    parent: z.string(),
    child: z.string(),
  })).optional(),
});

// GET /api/planning-sessions?repoId=xxx
planningSessionsRouter.get("/", async (c) => {
  const repoId = c.req.query("repoId");
  if (!repoId) {
    throw new BadRequestError("repoId is required");
  }

  const sessions = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.repoId, repoId))
    .orderBy(desc(schema.planningSessions.updatedAt));

  return c.json(sessions.map(toSession));
});

// GET /api/planning-sessions/:id
planningSessionsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");

  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!session) {
    throw new NotFoundError("Planning session not found");
  }

  return c.json(toSession(session));
});

// POST /api/planning-sessions - Create new planning session
planningSessionsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { repoId, baseBranch, title } = validateOrThrow(createSessionSchema, body);

  const now = new Date().toISOString();
  const sessionId = randomUUID();
  const chatSessionId = randomUUID();

  // Create planning session
  await db.insert(schema.planningSessions).values({
    id: sessionId,
    repoId,
    title: title || "Untitled Planning",
    baseBranch,
    status: "draft",
    nodesJson: "[]",
    edgesJson: "[]",
    chatSessionId,
    createdAt: now,
    updatedAt: now,
  });

  // Create linked chat session
  await db.insert(schema.chatSessions).values({
    id: chatSessionId,
    repoId,
    worktreePath: `planning:${sessionId}`,
    branchName: null,
    planId: null,
    status: "active",
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // Add initial assistant message
  const initialMessage = `こんにちは！何を作りたいですか？

URLやドキュメント（Notion、GitHub Issue、Figma など）があれば共有してください。内容を確認して、タスクを分解するお手伝いをします。`;

  await db.insert(schema.chatMessages).values({
    sessionId: chatSessionId,
    role: "assistant",
    content: initialMessage,
    createdAt: now,
  });

  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, sessionId));

  broadcast({
    type: "planning.created",
    repoId,
    data: toSession(session!),
  });

  return c.json(toSession(session!), 201);
});

// PATCH /api/planning-sessions/:id - Update planning session
planningSessionsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const updates = validateOrThrow(updateSessionSchema, body);

  const [existing] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!existing) {
    throw new NotFoundError("Planning session not found");
  }

  if (existing.status !== "draft") {
    throw new BadRequestError("Cannot update non-draft session");
  }

  const now = new Date().toISOString();
  const updateData: Partial<typeof schema.planningSessions.$inferInsert> = {
    updatedAt: now,
  };

  if (updates.title !== undefined) {
    updateData.title = updates.title;
  }
  if (updates.baseBranch !== undefined) {
    updateData.baseBranch = updates.baseBranch;
  }
  if (updates.nodes !== undefined) {
    updateData.nodesJson = JSON.stringify(updates.nodes);
  }
  if (updates.edges !== undefined) {
    updateData.edgesJson = JSON.stringify(updates.edges);
  }

  await db
    .update(schema.planningSessions)
    .set(updateData)
    .where(eq(schema.planningSessions.id, id));

  const [updated] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  broadcast({
    type: "planning.updated",
    repoId: updated!.repoId,
    data: toSession(updated!),
  });

  return c.json(toSession(updated!));
});

// POST /api/planning-sessions/:id/confirm - Confirm and create branches
planningSessionsRouter.post("/:id/confirm", async (c) => {
  const id = c.req.param("id");

  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!session) {
    throw new NotFoundError("Planning session not found");
  }

  if (session.status !== "draft") {
    throw new BadRequestError("Session is not in draft status");
  }

  const nodes = JSON.parse(session.nodesJson) as TaskNode[];
  if (nodes.length === 0) {
    throw new BadRequestError("No tasks to confirm");
  }

  // Update status to confirmed
  const now = new Date().toISOString();
  await db
    .update(schema.planningSessions)
    .set({ status: "confirmed", updatedAt: now })
    .where(eq(schema.planningSessions.id, id));

  const [updated] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  broadcast({
    type: "planning.confirmed",
    repoId: updated!.repoId,
    data: toSession(updated!),
  });

  return c.json(toSession(updated!));
});

// POST /api/planning-sessions/:id/discard - Discard planning session
planningSessionsRouter.post("/:id/discard", async (c) => {
  const id = c.req.param("id");

  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!session) {
    throw new NotFoundError("Planning session not found");
  }

  const now = new Date().toISOString();
  await db
    .update(schema.planningSessions)
    .set({ status: "discarded", updatedAt: now })
    .where(eq(schema.planningSessions.id, id));

  // Also archive the chat session
  if (session.chatSessionId) {
    await db
      .update(schema.chatSessions)
      .set({ status: "archived", updatedAt: now })
      .where(eq(schema.chatSessions.id, session.chatSessionId));
  }

  const [updated] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  broadcast({
    type: "planning.discarded",
    repoId: updated!.repoId,
    data: toSession(updated!),
  });

  return c.json(toSession(updated!));
});

// DELETE /api/planning-sessions/:id - Delete planning session
planningSessionsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!session) {
    throw new NotFoundError("Planning session not found");
  }

  // Delete external links
  await db
    .delete(schema.externalLinks)
    .where(eq(schema.externalLinks.planningSessionId, id));

  // Delete chat messages
  if (session.chatSessionId) {
    await db
      .delete(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, session.chatSessionId));

    await db
      .delete(schema.chatSessions)
      .where(eq(schema.chatSessions.id, session.chatSessionId));
  }

  // Delete planning session
  await db
    .delete(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  broadcast({
    type: "planning.deleted",
    repoId: session.repoId,
    data: { id },
  });

  return c.json({ success: true });
});
