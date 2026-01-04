import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import { db, schema } from "../../db";
import { randomUUID } from "crypto";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";
import { broadcast } from "../ws";
import { execSync } from "child_process";
import { existsSync } from "fs";

export const planningSessionsRouter = new Hono();

// Types
interface TaskNode {
  id: string;
  title: string;
  description?: string;
  branchName?: string;
  issueUrl?: string; // GitHub issue URL
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
    issueUrl: z.string().optional(),
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

  // Add initial assistant message based on session type
  const isInstructionReview = (title || "").startsWith("Planning:");
  const initialMessage = isInstructionReview
    ? `タスクインストラクションの内容を確認します。

気になる点や不明確な箇所があれば指摘しますので、一緒に精査していきましょう。`
    : `こんにちは！何を作りたいですか？

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
  const edges = JSON.parse(session.edgesJson) as TaskEdge[];

  if (nodes.length === 0) {
    throw new BadRequestError("No tasks to confirm");
  }

  // Get local path from repo pins
  const [repoPin] = await db
    .select()
    .from(schema.repoPins)
    .where(eq(schema.repoPins.repoId, session.repoId))
    .limit(1);

  if (!repoPin) {
    throw new BadRequestError("Repository not found in pins");
  }

  const localPath = repoPin.localPath;
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Build parent mapping from edges
  const parentMap = new Map<string, string>(); // taskId -> parentTaskId
  for (const edge of edges) {
    parentMap.set(edge.child, edge.parent);
  }

  const now = new Date().toISOString();
  const results: Array<{
    taskId: string;
    branchName: string;
    parentBranch: string;
    success: boolean;
    error?: string;
  }> = [];

  // Process nodes in order (parents first)
  const processed = new Set<string>();
  const taskBranchMap = new Map<string, string>(); // taskId -> branchName

  const processTask = async (taskId: string) => {
    if (processed.has(taskId)) return;

    const task = nodes.find((n) => n.id === taskId);
    if (!task) return;

    // Process parent first if exists
    const parentTaskId = parentMap.get(taskId);
    if (parentTaskId && !processed.has(parentTaskId)) {
      await processTask(parentTaskId);
    }

    // Determine branch name
    const branchName = task.branchName ||
      `task/${task.title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").substring(0, 30)}`;

    // Determine parent branch
    let parentBranch = session.baseBranch;
    if (parentTaskId) {
      const parentBranchName = taskBranchMap.get(parentTaskId);
      if (parentBranchName) {
        parentBranch = parentBranchName;
      }
    }

    const result: typeof results[number] = {
      taskId: task.id,
      branchName,
      parentBranch,
      success: false,
    };

    try {
      // Check if branch already exists
      const existingBranches = execSync(
        `cd "${localPath}" && git branch --list "${branchName}"`,
        { encoding: "utf-8" }
      ).trim();

      // Create branch if it doesn't exist
      if (!existingBranches) {
        // Check if parent branch exists locally, if not try remote
        let actualParent = parentBranch;
        try {
          const localExists = execSync(
            `cd "${localPath}" && git rev-parse --verify "${parentBranch}" 2>/dev/null`,
            { encoding: "utf-8" }
          ).trim();
          if (!localExists) {
            actualParent = `origin/${parentBranch}`;
          }
        } catch {
          // Local branch doesn't exist, try with origin prefix
          actualParent = `origin/${parentBranch}`;
        }
        execSync(
          `cd "${localPath}" && git branch "${branchName}" "${actualParent}"`,
          { encoding: "utf-8" }
        );
      }

      // Store task instruction for this branch
      const instructionMd = [
        `# ${task.title}`,
        "",
        task.description || "",
      ].join("\n");

      await db.insert(schema.taskInstructions).values({
        repoId: session.repoId,
        taskId: task.id,
        branchName,
        instructionMd,
        createdAt: now,
        updatedAt: now,
      });

      // Link issue if task has issueUrl
      if (task.issueUrl) {
        const issueMatch = task.issueUrl.match(/\/issues\/(\d+)/);
        if (issueMatch) {
          const issueNumber = parseInt(issueMatch[1], 10);

          // Check if link already exists
          const [existingLink] = await db
            .select()
            .from(schema.branchLinks)
            .where(
              and(
                eq(schema.branchLinks.repoId, session.repoId),
                eq(schema.branchLinks.branchName, branchName),
                eq(schema.branchLinks.linkType, "issue"),
                eq(schema.branchLinks.number, issueNumber)
              )
            )
            .limit(1);

          if (!existingLink) {
            // Fetch issue info from GitHub
            let title: string | null = null;
            let status: string | null = null;
            try {
              const issueResult = execSync(
                `gh issue view ${issueNumber} --repo "${session.repoId}" --json title,state`,
                { encoding: "utf-8", timeout: 10000 }
              ).trim();
              const issueData = JSON.parse(issueResult);
              title = issueData.title;
              status = issueData.state?.toLowerCase();
            } catch {
              // Ignore fetch errors
            }

            await db.insert(schema.branchLinks).values({
              repoId: session.repoId,
              branchName,
              linkType: "issue",
              url: task.issueUrl,
              number: issueNumber,
              title,
              status,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }

      result.success = true;
      taskBranchMap.set(taskId, branchName);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`Failed to create branch for task ${taskId}:`, result.error);
    }

    results.push(result);
    processed.add(taskId);
  };

  // Process all tasks
  for (const node of nodes) {
    await processTask(node.id);
  }

  const successCount = results.filter((r) => r.success).length;

  // Update nodes with branch names
  const updatedNodes = nodes.map((node) => ({
    ...node,
    branchName: taskBranchMap.get(node.id) || node.branchName,
  }));

  // Update status to confirmed and save updated nodes with branch names
  await db
    .update(schema.planningSessions)
    .set({
      status: "confirmed",
      nodesJson: JSON.stringify(updatedNodes),
      updatedAt: now,
    })
    .where(eq(schema.planningSessions.id, id));

  const [updated] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  broadcast({
    type: "planning.confirmed",
    repoId: updated!.repoId,
    data: {
      ...toSession(updated!),
      branchResults: results,
    },
  });

  // Also broadcast to trigger branch refetch
  broadcast({
    type: "branches.changed",
    repoId: updated!.repoId,
    data: { reason: "planning_confirmed" },
  });

  return c.json({
    ...toSession(updated!),
    branchResults: results,
    summary: {
      total: nodes.length,
      success: successCount,
      failed: nodes.length - successCount,
    },
  });
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
