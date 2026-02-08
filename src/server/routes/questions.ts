import { Hono } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { db, schema } from "../../db";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { NotFoundError } from "../middleware/error-handler";
import { broadcast } from "../ws";

export const questionsRouter = new Hono();

// Helper to format question for response
function toQuestion(q: typeof schema.planningQuestions.$inferSelect) {
  return {
    id: q.id,
    planningSessionId: q.planningSessionId,
    branchName: q.branchName,
    question: q.question,
    assumption: q.assumption,
    status: q.status as "pending" | "answered" | "skipped",
    answer: q.answer,
    acknowledged: q.acknowledged ?? false,
    orderIndex: q.orderIndex,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

// GET /api/questions?planningSessionId=...
questionsRouter.get("/", async (c) => {
  const planningSessionId = c.req.query("planningSessionId");
  if (!planningSessionId) {
    return c.json([]);
  }

  const questions = await db
    .select()
    .from(schema.planningQuestions)
    .where(eq(schema.planningQuestions.planningSessionId, planningSessionId))
    .orderBy(asc(schema.planningQuestions.orderIndex));

  return c.json(questions.map(toQuestion));
});

// Create question schema
const createQuestionSchema = z.object({
  planningSessionId: z.string(),
  branchName: z.string().optional(),
  question: z.string().min(1),
  assumption: z.string().optional(),
});

// POST /api/questions
questionsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const data = validateOrThrow(createQuestionSchema, body);

  const now = new Date().toISOString();

  // Get max orderIndex
  const existing = await db
    .select()
    .from(schema.planningQuestions)
    .where(eq(schema.planningQuestions.planningSessionId, data.planningSessionId))
    .orderBy(asc(schema.planningQuestions.orderIndex));

  const maxOrder = existing.length > 0 ? Math.max(...existing.map((q) => q.orderIndex)) : -1;

  const [question] = await db
    .insert(schema.planningQuestions)
    .values({
      planningSessionId: data.planningSessionId,
      branchName: data.branchName || null,
      question: data.question,
      assumption: data.assumption || null,
      status: "pending",
      orderIndex: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const result = toQuestion(question);

  // Get repoId from planning session for broadcast
  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, data.planningSessionId));

  if (session) {
    broadcast({
      type: "question.created",
      repoId: session.repoId,
      data: result,
    });
  }

  return c.json(result, 201);
});

// Update question schema
const updateQuestionSchema = z.object({
  question: z.string().min(1).optional(),
  assumption: z.string().optional(),
  status: z.enum(["pending", "answered", "skipped"]).optional(),
  answer: z.string().optional(),
});

// PATCH /api/questions/:id
questionsRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = validateOrThrow(updateQuestionSchema, body);

  const [existing] = await db
    .select()
    .from(schema.planningQuestions)
    .where(eq(schema.planningQuestions.id, id));

  if (!existing) {
    throw new NotFoundError("Question not found");
  }

  const now = new Date().toISOString();

  await db
    .update(schema.planningQuestions)
    .set({
      ...data,
      updatedAt: now,
    })
    .where(eq(schema.planningQuestions.id, id));

  const [updated] = await db
    .select()
    .from(schema.planningQuestions)
    .where(eq(schema.planningQuestions.id, id));

  const result = toQuestion(updated);

  // Get repoId from planning session for broadcast
  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, existing.planningSessionId));

  if (session) {
    broadcast({
      type: "question.updated",
      repoId: session.repoId,
      data: result,
    });
  }

  return c.json(result);
});

// DELETE /api/questions/:id
questionsRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);

  const [existing] = await db
    .select()
    .from(schema.planningQuestions)
    .where(eq(schema.planningQuestions.id, id));

  if (!existing) {
    throw new NotFoundError("Question not found");
  }

  await db.delete(schema.planningQuestions).where(eq(schema.planningQuestions.id, id));

  // Get repoId from planning session for broadcast
  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, existing.planningSessionId));

  if (session) {
    broadcast({
      type: "question.deleted",
      repoId: session.repoId,
      data: { id, planningSessionId: existing.planningSessionId },
    });
  }

  return c.json({ success: true });
});

// POST /api/questions/:id/answer - Answer a question and trigger AI update
questionsRouter.post("/:id/answer", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const { answer } = validateOrThrow(z.object({ answer: z.string().min(1) }), body);

  const [existing] = await db
    .select()
    .from(schema.planningQuestions)
    .where(eq(schema.planningQuestions.id, id));

  if (!existing) {
    throw new NotFoundError("Question not found");
  }

  const now = new Date().toISOString();

  await db
    .update(schema.planningQuestions)
    .set({
      answer,
      status: "answered",
      acknowledged: false, // Reset acknowledged when answer is updated
      updatedAt: now,
    })
    .where(eq(schema.planningQuestions.id, id));

  const [updated] = await db
    .select()
    .from(schema.planningQuestions)
    .where(eq(schema.planningQuestions.id, id));

  const result = toQuestion(updated);

  // Get repoId from planning session for broadcast
  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, existing.planningSessionId));

  if (session) {
    broadcast({
      type: "question.answered",
      repoId: session.repoId,
      data: result,
    });
  }

  return c.json(result);
});
