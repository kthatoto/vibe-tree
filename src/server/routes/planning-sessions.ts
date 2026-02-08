import { Hono } from "hono";
import { eq, desc, and, asc } from "drizzle-orm";
import { db, schema } from "../../db";
import { randomUUID } from "crypto";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";
import { broadcast } from "../ws";
import { execSync } from "child_process";
import { existsSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";

export const planningSessionsRouter = new Hono();

// Types
export type PlanningSessionType = "refinement" | "planning" | "execute";

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
  type: PlanningSessionType;
  baseBranch: string;
  status: "draft" | "confirmed" | "discarded";
  nodes: TaskNode[];
  edges: TaskEdge[];
  chatSessionId: string | null;
  executeBranches: string[] | null; // Selected branches for execute session
  currentExecuteIndex: number; // Current index in executeBranches
  createdAt: string;
  updatedAt: string;
}

// Helper to convert DB row to PlanningSession
function toSession(row: typeof schema.planningSessions.$inferSelect): PlanningSession {
  return {
    id: row.id,
    repoId: row.repoId,
    title: row.title,
    type: (row.type || "refinement") as PlanningSessionType,
    baseBranch: row.baseBranch,
    status: row.status as PlanningSession["status"],
    nodes: JSON.parse(row.nodesJson) as TaskNode[],
    edges: JSON.parse(row.edgesJson) as TaskEdge[],
    chatSessionId: row.chatSessionId,
    executeBranches: row.executeBranchesJson ? JSON.parse(row.executeBranchesJson) as string[] : null,
    currentExecuteIndex: row.currentExecuteIndex ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Schemas
const createSessionSchema = z.object({
  repoId: z.string().min(1),
  baseBranch: z.string().min(1),
  title: z.string().optional(),
  type: z.enum(["refinement", "planning", "execute"]).optional(),
  executeBranches: z.array(z.string()).optional(), // For execute sessions
});

const updateExecuteBranchesSchema = z.object({
  executeBranches: z.array(z.string()),
});

const updateSessionSchema = z.object({
  title: z.string().optional(),
  type: z.enum(["refinement", "planning", "execute"]).optional(),
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
  const { repoId, baseBranch, title, type, executeBranches } = validateOrThrow(createSessionSchema, body);

  const now = new Date().toISOString();
  const sessionId = randomUUID();
  const chatSessionId = randomUUID();

  // Create planning session
  await db.insert(schema.planningSessions).values({
    id: sessionId,
    repoId,
    title: title || "Untitled Session",
    type: type || "refinement",
    baseBranch,
    status: "draft",
    nodesJson: "[]",
    edgesJson: "[]",
    chatSessionId,
    executeBranchesJson: executeBranches ? JSON.stringify(executeBranches) : null,
    currentExecuteIndex: 0,
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
  if (updates.type !== undefined) {
    updateData.type = updates.type;
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

  const isPlanningType = session.type === "planning";

  // For planning sessions, allow confirm from any status except "confirmed"
  // For other types, require "draft" status
  if (isPlanningType) {
    if (session.status === "confirmed") {
      throw new BadRequestError("Session is already confirmed");
    }
  } else {
    if (session.status !== "draft") {
      throw new BadRequestError("Session is not in draft status");
    }
  }

  const nodes = JSON.parse(session.nodesJson) as TaskNode[];
  const edges = JSON.parse(session.edgesJson) as TaskEdge[];

  // Planning type sessions don't require tasks (they focus on instruction editing)
  if (!isPlanningType && nodes.length === 0) {
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

// POST /api/planning-sessions/:id/unconfirm - Revert confirmed session back to draft
planningSessionsRouter.post("/:id/unconfirm", async (c) => {
  const id = c.req.param("id");

  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!session) {
    throw new NotFoundError("Planning session not found");
  }

  if (session.status !== "confirmed") {
    throw new BadRequestError("Session is not in confirmed status");
  }

  const now = new Date().toISOString();
  await db
    .update(schema.planningSessions)
    .set({ status: "draft", updatedAt: now })
    .where(eq(schema.planningSessions.id, id));

  // Reactivate the chat session if it was archived
  if (session.chatSessionId) {
    await db
      .update(schema.chatSessions)
      .set({ status: "active", updatedAt: now })
      .where(eq(schema.chatSessions.id, session.chatSessionId));
  }

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

// PATCH /api/planning-sessions/:id/execute-branches - Update execute branches
planningSessionsRouter.patch("/:id/execute-branches", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { executeBranches } = validateOrThrow(updateExecuteBranchesSchema, body);

  const [existing] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!existing) {
    throw new NotFoundError("Planning session not found");
  }

  if (existing.type !== "execute" && existing.type !== "planning") {
    throw new BadRequestError("Session must be execute or planning type");
  }

  const now = new Date().toISOString();
  await db
    .update(schema.planningSessions)
    .set({
      executeBranchesJson: JSON.stringify(executeBranches),
      currentExecuteIndex: 0, // Reset index when branches change
      updatedAt: now,
    })
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

// POST /api/planning-sessions/:id/advance-task - Advance to next task
planningSessionsRouter.post("/:id/advance-task", async (c) => {
  const id = c.req.param("id");

  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!session) {
    throw new NotFoundError("Planning session not found");
  }

  if (session.type !== "execute") {
    throw new BadRequestError("Session is not an execute session");
  }

  const executeBranches = session.executeBranchesJson
    ? JSON.parse(session.executeBranchesJson) as string[]
    : [];
  const currentIndex = session.currentExecuteIndex ?? 0;

  if (currentIndex >= executeBranches.length - 1) {
    // Already at last task or no tasks
    return c.json({
      ...toSession(session),
      completed: true,
      message: "All tasks completed",
    });
  }

  const now = new Date().toISOString();
  const newIndex = currentIndex + 1;

  await db
    .update(schema.planningSessions)
    .set({
      currentExecuteIndex: newIndex,
      updatedAt: now,
    })
    .where(eq(schema.planningSessions.id, id));

  const [updated] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  broadcast({
    type: "planning.taskAdvanced",
    repoId: updated!.repoId,
    data: {
      ...toSession(updated!),
      previousIndex: currentIndex,
      newIndex,
      currentBranch: executeBranches[newIndex],
    },
  });

  return c.json({
    ...toSession(updated!),
    completed: newIndex >= executeBranches.length - 1,
    currentBranch: executeBranches[newIndex],
  });
});

// Schema for generate-title
const generateTitleSchema = z.object({
  messageCount: z.number().int().min(0),
});

// POST /api/planning-sessions/:id/generate-title - Auto-generate session title
planningSessionsRouter.post("/:id/generate-title", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { messageCount } = validateOrThrow(generateTitleSchema, body);

  const [session] = await db
    .select()
    .from(schema.planningSessions)
    .where(eq(schema.planningSessions.id, id));

  if (!session) {
    throw new NotFoundError("Planning session not found");
  }

  // Get chat messages for this session
  if (!session.chatSessionId) {
    throw new BadRequestError("Session has no chat session");
  }

  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, session.chatSessionId))
    .orderBy(asc(schema.chatMessages.createdAt))
    .limit(10); // Get first 10 messages max for title generation

  if (messages.length === 0) {
    return c.json({ title: session.title, updated: false });
  }

  // Build conversation summary for title generation
  const conversationSnippet = messages
    .map((m) => {
      // Parse content if it's JSON (assistant message with chunks)
      let content = m.content;
      try {
        const parsed = JSON.parse(m.content);
        if (parsed.chunks) {
          content = parsed.chunks
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { content: string }) => c.content)
            .join("");
        }
      } catch {
        // Plain text content
      }
      return `${m.role}: ${content.slice(0, 200)}`;
    })
    .join("\n");

  // Determine if we should be conservative about changes
  const isConservative = messageCount > 6;
  const currentTitle = session.title;

  // Build prompt
  let prompt: string;
  if (isConservative) {
    prompt = `この会話のタイトルを考えてください。現在のタイトルは「${currentTitle}」です。

会話の最初の部分:
${conversationSnippet}

ルール:
- 現在のタイトルが適切であれば、そのまま返してください
- 大きく内容が変わった場合のみ、新しいタイトルを提案してください
- タイトルのみを出力してください（説明なし）
- 20文字以内で簡潔に
- 日本語で`;
  } else {
    prompt = `この会話にふさわしい短いタイトルを考えてください。

会話:
${conversationSnippet}

ルール:
- タイトルのみを出力してください（説明なし）
- 20文字以内で簡潔に
- 日本語で
- 会話の主要なトピックを反映`;
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 50,
      messages: [
        { role: "user", content: prompt }
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    let newTitle = textBlock?.text?.trim() || currentTitle;

    // Clean up the title (remove quotes if present)
    newTitle = newTitle.replace(/^["「『]|["」』]$/g, "").trim();

    // Limit length
    if (newTitle.length > 50) {
      newTitle = newTitle.slice(0, 47) + "...";
    }

    // Check if title actually changed
    if (newTitle === currentTitle) {
      return c.json({ title: currentTitle, updated: false });
    }

    // Update session title
    const now = new Date().toISOString();
    await db
      .update(schema.planningSessions)
      .set({ title: newTitle, updatedAt: now })
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

    return c.json({ title: newTitle, updated: true });
  } catch (err) {
    console.error("[PlanningSession] Title generation failed:", err);
    // Return current title on error
    return c.json({ title: currentTitle, updated: false });
  }
});
