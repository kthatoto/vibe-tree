import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, desc, and } from "drizzle-orm";
import { broadcast } from "../ws";
import { z } from "zod";
import crypto from "crypto";
import {
  repoIdQuerySchema,
  logInstructionSchema,
  validateOrThrow,
} from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";

// Helper to compute content hash for instruction comparison
function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export const instructionsRouter = new Hono();

// POST /api/instructions/log
instructionsRouter.post("/log", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(logInstructionSchema, body);

  const now = new Date().toISOString();

  const result = await db
    .insert(schema.instructionsLog)
    .values({
      repoId: input.repoId,
      planId: input.planId ?? null,
      worktreePath: input.worktreePath ?? null,
      branchName: input.branchName ?? null,
      kind: input.kind,
      contentMd: input.contentMd,
      createdAt: now,
    })
    .returning();

  const log = result[0];
  if (!log) {
    throw new Error("Failed to create instruction log");
  }

  broadcast({
    type: "instructions.logged",
    repoId: input.repoId,
    data: log,
  });

  return c.json(log, 201);
});

// GET /api/instructions/logs?repoId=...
instructionsRouter.get("/logs", async (c) => {
  const query = validateOrThrow(repoIdQuerySchema, {
    repoId: c.req.query("repoId"),
  });

  const logs = await db
    .select()
    .from(schema.instructionsLog)
    .where(eq(schema.instructionsLog.repoId, query.repoId))
    .orderBy(desc(schema.instructionsLog.createdAt))
    .limit(100);

  return c.json(logs);
});

// Task instruction schemas
const taskInstructionQuerySchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
});

const updateTaskInstructionSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
  instructionMd: z.string(),
});

// Helper to compute confirmation status
function getConfirmationStatus(instruction: {
  instructionMd: string;
  confirmedAt: string | null;
  confirmedContentHash: string | null;
}): "unconfirmed" | "confirmed" | "changed" {
  if (!instruction.confirmedAt || !instruction.confirmedContentHash) {
    return "unconfirmed";
  }
  const currentHash = computeContentHash(instruction.instructionMd);
  if (currentHash !== instruction.confirmedContentHash) {
    return "changed";
  }
  return "confirmed";
}

// GET /api/instructions/task?repoId=...&branchName=...
instructionsRouter.get("/task", async (c) => {
  const query = validateOrThrow(taskInstructionQuerySchema, {
    repoId: c.req.query("repoId"),
    branchName: c.req.query("branchName"),
  });

  const [instruction] = await db
    .select()
    .from(schema.taskInstructions)
    .where(
      and(
        eq(schema.taskInstructions.repoId, query.repoId),
        eq(schema.taskInstructions.branchName, query.branchName)
      )
    )
    .limit(1);

  if (!instruction) {
    // Return empty instruction if not found (branch may not have task instruction)
    return c.json({
      id: null,
      repoId: query.repoId,
      branchName: query.branchName,
      instructionMd: "",
      taskId: null,
      confirmedAt: null,
      confirmedContentHash: null,
      confirmationStatus: "unconfirmed" as const,
    });
  }

  return c.json({
    ...instruction,
    confirmationStatus: getConfirmationStatus(instruction),
  });
});

// PATCH /api/instructions/task - Update or create task instruction
instructionsRouter.patch("/task", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(updateTaskInstructionSchema, body);
  const now = new Date().toISOString();

  // Check if instruction exists
  const [existing] = await db
    .select()
    .from(schema.taskInstructions)
    .where(
      and(
        eq(schema.taskInstructions.repoId, input.repoId),
        eq(schema.taskInstructions.branchName, input.branchName)
      )
    )
    .limit(1);

  if (existing) {
    // Update existing
    await db
      .update(schema.taskInstructions)
      .set({
        instructionMd: input.instructionMd,
        updatedAt: now,
      })
      .where(eq(schema.taskInstructions.id, existing.id));

    const [updated] = await db
      .select()
      .from(schema.taskInstructions)
      .where(eq(schema.taskInstructions.id, existing.id));

    broadcast({
      type: "taskInstruction.updated",
      repoId: input.repoId,
      data: { ...updated, confirmationStatus: getConfirmationStatus(updated) },
    });

    return c.json({ ...updated, confirmationStatus: getConfirmationStatus(updated) });
  } else {
    // Create new
    const result = await db
      .insert(schema.taskInstructions)
      .values({
        repoId: input.repoId,
        taskId: `branch-${input.branchName}`,
        branchName: input.branchName,
        instructionMd: input.instructionMd,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const created = result[0];
    if (!created) {
      throw new BadRequestError("Failed to create task instruction");
    }

    broadcast({
      type: "taskInstruction.created",
      repoId: input.repoId,
      data: { ...created, confirmationStatus: "unconfirmed" as const },
    });

    return c.json({ ...created, confirmationStatus: "unconfirmed" as const }, 201);
  }
});

// Confirm instruction schema
const confirmInstructionSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
});

// POST /api/instructions/task/confirm - Confirm instruction
instructionsRouter.post("/task/confirm", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(confirmInstructionSchema, body);
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(schema.taskInstructions)
    .where(
      and(
        eq(schema.taskInstructions.repoId, input.repoId),
        eq(schema.taskInstructions.branchName, input.branchName)
      )
    )
    .limit(1);

  if (!existing) {
    throw new BadRequestError("Task instruction not found");
  }

  const contentHash = computeContentHash(existing.instructionMd);

  await db
    .update(schema.taskInstructions)
    .set({
      confirmedAt: now,
      confirmedContentHash: contentHash,
      updatedAt: now,
    })
    .where(eq(schema.taskInstructions.id, existing.id));

  const [updated] = await db
    .select()
    .from(schema.taskInstructions)
    .where(eq(schema.taskInstructions.id, existing.id));

  broadcast({
    type: "taskInstruction.confirmed",
    repoId: input.repoId,
    data: { ...updated, confirmationStatus: "confirmed" as const },
  });

  return c.json({ ...updated, confirmationStatus: "confirmed" as const });
});

// POST /api/instructions/task/unconfirm - Unconfirm instruction
instructionsRouter.post("/task/unconfirm", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(confirmInstructionSchema, body);
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(schema.taskInstructions)
    .where(
      and(
        eq(schema.taskInstructions.repoId, input.repoId),
        eq(schema.taskInstructions.branchName, input.branchName)
      )
    )
    .limit(1);

  if (!existing) {
    throw new BadRequestError("Task instruction not found");
  }

  await db
    .update(schema.taskInstructions)
    .set({
      confirmedAt: null,
      confirmedContentHash: null,
      updatedAt: now,
    })
    .where(eq(schema.taskInstructions.id, existing.id));

  const [updated] = await db
    .select()
    .from(schema.taskInstructions)
    .where(eq(schema.taskInstructions.id, existing.id));

  broadcast({
    type: "taskInstruction.unconfirmed",
    repoId: input.repoId,
    data: { ...updated, confirmationStatus: "unconfirmed" as const },
  });

  return c.json({ ...updated, confirmationStatus: "unconfirmed" as const });
});
