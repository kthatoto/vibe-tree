import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, desc, and, lt } from "drizzle-orm";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";

export const scanLogsRouter = new Hono();

// Validation schemas
const getLogsSchema = z.object({
  repoId: z.string().min(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  before: z.coerce.number().optional(), // cursor for pagination (log id)
});

const createLogSchema = z.object({
  repoId: z.string().min(1),
  logType: z.string().min(1),
  message: z.string().min(1),
  html: z.string().optional(),
  branchName: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// GET /api/scan-logs?repoId=...&limit=50&before=123
scanLogsRouter.get("/", async (c) => {
  const query = validateOrThrow(getLogsSchema, {
    repoId: c.req.query("repoId"),
    limit: c.req.query("limit"),
    before: c.req.query("before"),
  });

  let logs;
  if (query.before) {
    logs = await db
      .select()
      .from(schema.scanLogs)
      .where(
        and(
          eq(schema.scanLogs.repoId, query.repoId),
          lt(schema.scanLogs.id, query.before)
        )
      )
      .orderBy(desc(schema.scanLogs.id))
      .limit(query.limit);
  } else {
    logs = await db
      .select()
      .from(schema.scanLogs)
      .where(eq(schema.scanLogs.repoId, query.repoId))
      .orderBy(desc(schema.scanLogs.id))
      .limit(query.limit);
  }

  // Return with hasMore flag for pagination
  const hasMore = logs.length === query.limit;

  return c.json({
    logs: logs.map((log) => ({
      id: log.id,
      logType: log.logType,
      message: log.message,
      html: log.html,
      branchName: log.branchName,
      scanSessionId: log.scanSessionId,
      metadata: log.metadata ? JSON.parse(log.metadata) : null,
      createdAt: log.createdAt,
    })),
    hasMore,
    nextCursor: hasMore && logs.length > 0 ? logs[logs.length - 1].id : null,
  });
});

// POST /api/scan-logs
scanLogsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createLogSchema, body);
  const now = new Date().toISOString();

  const result = await db
    .insert(schema.scanLogs)
    .values({
      repoId: input.repoId,
      logType: input.logType,
      message: input.message,
      html: input.html || null,
      branchName: input.branchName || null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: now,
    })
    .returning();

  const log = result[0];
  if (!log) {
    throw new BadRequestError("Failed to create log");
  }

  return c.json({
    id: log.id,
    logType: log.logType,
    message: log.message,
    html: log.html,
    branchName: log.branchName,
    metadata: input.metadata || null,
    createdAt: log.createdAt,
  }, 201);
});

// DELETE /api/scan-logs/cleanup?repoId=...&keepDays=7
// Clean up old logs (keep only last N days)
scanLogsRouter.delete("/cleanup", async (c) => {
  const repoId = c.req.query("repoId");
  const keepDays = parseInt(c.req.query("keepDays") || "7", 10);

  if (!repoId) {
    throw new BadRequestError("repoId is required");
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - keepDays);
  const cutoffStr = cutoffDate.toISOString();

  const { lt } = await import("drizzle-orm");
  const deleted = await db
    .delete(schema.scanLogs)
    .where(
      and(
        eq(schema.scanLogs.repoId, repoId),
        lt(schema.scanLogs.createdAt, cutoffStr)
      )
    )
    .returning();

  return c.json({ deleted: deleted.length });
});
