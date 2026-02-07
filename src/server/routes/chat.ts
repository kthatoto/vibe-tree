import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and, desc, gt, asc } from "drizzle-orm";
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { randomUUID, createHash } from "crypto";
import { expandTilde } from "../utils";
import { broadcast } from "../ws";
import {
  createChatSessionSchema,
  createPlanningSessionSchema,
  archiveChatSessionSchema,
  chatSendSchema,
  chatSummarizeSchema,
  chatPurgeSchema,
  validateOrThrow,
} from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";
import type {
  ChatSession,
  ChatMessage,
  ChatSummary,
  BranchNamingRule,
} from "../../shared/types";

export const chatRouter = new Hono();

// Server-side storage for streaming states (keyed by sessionId)
interface StreamingChunk {
  type: "thinking" | "text" | "tool_use" | "tool_result";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
}

interface StreamingState {
  sessionId: string;
  runId: number;
  chunks: StreamingChunk[];
  isComplete: boolean;
  assistantMsgId: number | null; // DB message ID for incremental updates
  lastDbUpdateTime: number; // Last time we updated the DB
}

const streamingStates = new Map<string, StreamingState>();

// Helper to convert DB row to ChatSession
function toSession(row: typeof schema.chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    repoId: row.repoId,
    worktreePath: row.worktreePath,
    branchName: row.branchName,
    planId: row.planId,
    status: row.status as "active" | "archived",
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Helper to convert DB row to ChatMessage
function toMessage(row: typeof schema.chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    chatMode: row.chatMode as "planning" | "execution" | null,
    instructionEditStatus: row.instructionEditStatus as "committed" | "rejected" | null,
    createdAt: row.createdAt,
  };
}

// GET /api/chat/sessions - List sessions for a repo
chatRouter.get("/sessions", async (c) => {
  const repoId = c.req.query("repoId");
  if (!repoId) {
    throw new BadRequestError("repoId is required");
  }

  const sessions = await db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.repoId, repoId))
    .orderBy(desc(schema.chatSessions.lastUsedAt));

  return c.json(sessions.map(toSession));
});

// POST /api/chat/sessions - Create or get existing session for branch
chatRouter.post("/sessions", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createChatSessionSchema, body);
  const worktreePath = expandTilde(input.worktreePath);
  const branchName = input.branchName;

  // Check if session already exists for this branch (primary key is branchName, not worktreePath)
  const existing = await db
    .select()
    .from(schema.chatSessions)
    .where(
      and(
        eq(schema.chatSessions.repoId, input.repoId),
        eq(schema.chatSessions.branchName, branchName),
        eq(schema.chatSessions.status, "active")
      )
    );

  if (existing[0]) {
    // Update lastUsedAt and worktreePath (may have changed)
    const now = new Date().toISOString();
    await db
      .update(schema.chatSessions)
      .set({ lastUsedAt: now, updatedAt: now, worktreePath })
      .where(eq(schema.chatSessions.id, existing[0].id));

    return c.json(toSession({ ...existing[0], lastUsedAt: now, updatedAt: now, worktreePath }));
  }

  // Create new session
  const now = new Date().toISOString();
  const sessionId = randomUUID();

  await db.insert(schema.chatSessions).values({
    id: sessionId,
    repoId: input.repoId,
    worktreePath,
    branchName,
    planId: input.planId ?? null,
    status: "active",
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const session: ChatSession = {
    id: sessionId,
    repoId: input.repoId,
    worktreePath,
    branchName,
    planId: input.planId ?? null,
    status: "active",
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  return c.json(session);
});

// POST /api/chat/sessions/planning - Create or get planning session (no worktree needed)
chatRouter.post("/sessions/planning", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createPlanningSessionSchema, body);
  const localPath = expandTilde(input.localPath);

  // Use localPath as worktreePath for planning sessions
  const planningWorktreePath = `planning:${localPath}`;

  // Check if planning session already exists for this repo
  const existing = await db
    .select()
    .from(schema.chatSessions)
    .where(
      and(
        eq(schema.chatSessions.repoId, input.repoId),
        eq(schema.chatSessions.worktreePath, planningWorktreePath),
        eq(schema.chatSessions.status, "active")
      )
    );

  if (existing[0]) {
    // Update lastUsedAt
    const now = new Date().toISOString();
    await db
      .update(schema.chatSessions)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(schema.chatSessions.id, existing[0].id));

    return c.json(toSession({ ...existing[0], lastUsedAt: now, updatedAt: now }));
  }

  // Create new planning session
  const now = new Date().toISOString();
  const sessionId = randomUUID();

  await db.insert(schema.chatSessions).values({
    id: sessionId,
    repoId: input.repoId,
    worktreePath: planningWorktreePath,
    branchName: null,
    planId: null,
    status: "active",
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const session: ChatSession = {
    id: sessionId,
    repoId: input.repoId,
    worktreePath: planningWorktreePath,
    branchName: null,
    planId: null,
    status: "active",
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  return c.json(session);
});

// POST /api/chat/sessions/archive - Archive a session
chatRouter.post("/sessions/archive", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(archiveChatSessionSchema, body);

  const now = new Date().toISOString();
  await db
    .update(schema.chatSessions)
    .set({ status: "archived", updatedAt: now })
    .where(eq(schema.chatSessions.id, input.sessionId));

  return c.json({ success: true });
});

// GET /api/chat/messages - Get messages for a session
chatRouter.get("/messages", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    throw new BadRequestError("sessionId is required");
  }

  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(asc(schema.chatMessages.createdAt));

  return c.json(messages.map(toMessage));
});

// GET /api/chat/running - Check if there's a running agent for a session
chatRouter.get("/running", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    throw new BadRequestError("sessionId is required");
  }

  const runningRuns = await db
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.sessionId, sessionId),
        eq(schema.agentRuns.status, "running")
      )
    )
    .limit(1);

  return c.json({ isRunning: runningRuns.length > 0 });
});

// POST /api/chat/cancel - Cancel a running agent
chatRouter.post("/cancel", async (c) => {
  const body = await c.req.json();
  const sessionId = body.sessionId;
  if (!sessionId) {
    throw new BadRequestError("sessionId is required");
  }

  // Find running agent run
  const runningRuns = await db
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.sessionId, sessionId),
        eq(schema.agentRuns.status, "running")
      )
    )
    .limit(1);

  const run = runningRuns[0];
  if (!run) {
    console.log(`[Chat] Cancel: No running agent found for session ${sessionId}`);
    return c.json({ success: false, message: "No running agent found" });
  }

  console.log(`[Chat] Cancel: Found running agent run ${run.id}, pid=${run.pid}`);

  // Get streaming state to preserve chunks
  const state = streamingStates.get(sessionId);
  console.log(`[Chat] Cancel: Streaming state exists=${!!state}, chunks=${state?.chunks?.length ?? 0}`);

  // Kill the process if we have a pid
  if (run.pid) {
    console.log(`[Chat] Cancel: Killing process ${run.pid}`);
    try {
      // Try SIGTERM first
      process.kill(run.pid, "SIGTERM");
      console.log(`[Chat] Cancel: SIGTERM sent to ${run.pid}`);
      // Also try SIGKILL after a short delay to ensure termination
      setTimeout(() => {
        try {
          process.kill(run.pid!, "SIGKILL");
          console.log(`[Chat] Cancel: SIGKILL sent to ${run.pid}`);
        } catch {
          // Process may already be terminated
          console.log(`[Chat] Cancel: SIGKILL failed (process likely terminated)`);
        }
      }, 500);
    } catch (err) {
      console.error(`[Chat] Cancel: Failed to kill process ${run.pid}:`, err);
    }
  } else {
    console.log(`[Chat] Cancel: No pid found for agent run ${run.id}`);
  }

  // Update agent run status
  const now = new Date().toISOString();
  await db
    .update(schema.agentRuns)
    .set({ status: "cancelled", finishedAt: now })
    .where(eq(schema.agentRuns.id, run.id));

  // Update assistant message with final content (preserve what we have)
  let updatedMsg = null;
  if (state?.assistantMsgId) {
    console.log(`[Chat] Cancel: Updating assistant message ${state.assistantMsgId} with ${state.chunks.length} chunks`);
    const finalContent = state.chunks.length > 0
      ? JSON.stringify({ chunks: state.chunks, cancelled: true })
      : JSON.stringify({ chunks: [], cancelled: true });

    await db
      .update(schema.chatMessages)
      .set({ content: finalContent })
      .where(eq(schema.chatMessages.id, state.assistantMsgId));

    const [msg] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, state.assistantMsgId));
    updatedMsg = msg;
    console.log(`[Chat] Cancel: Assistant message updated, msg=${!!msg}`);
  } else {
    console.log(`[Chat] Cancel: No assistantMsgId in state, state=${!!state}`);
  }

  // Get session for repoId
  const sessions = await db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId))
    .limit(1);

  const session = sessions[0];
  if (session) {
    console.log(`[Chat] Cancel: Broadcasting streaming.end for session ${sessionId}, repoId=${session.repoId}`);
    // Broadcast streaming end with the preserved message
    broadcast({
      type: "chat.streaming.end",
      repoId: session.repoId,
      data: { sessionId, message: updatedMsg ? toMessage(updatedMsg) : null },
    });
  } else {
    console.log(`[Chat] Cancel: Session not found for ${sessionId}`);
  }

  // Clear streaming state
  streamingStates.delete(sessionId);
  console.log(`[Chat] Cancel: Done`);

  return c.json({ success: true });
});

// PATCH /api/chat/messages/:id/instruction-status - Update instruction edit status
chatRouter.patch("/messages/:id/instruction-status", async (c) => {
  const messageId = parseInt(c.req.param("id"), 10);
  if (isNaN(messageId)) {
    throw new BadRequestError("Invalid message ID");
  }

  const body = await c.req.json();
  const status = body.status as "committed" | "rejected";

  if (status !== "committed" && status !== "rejected") {
    throw new BadRequestError("status must be 'committed' or 'rejected'");
  }

  // Get the message first
  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.id, messageId));

  const message = messages[0];
  if (!message) {
    throw new NotFoundError("Message not found");
  }

  // Update the status
  await db
    .update(schema.chatMessages)
    .set({ instructionEditStatus: status })
    .where(eq(schema.chatMessages.id, messageId));

  return c.json({ success: true, status });
});

// POST /api/chat/send - Send a message (execute Claude asynchronously)
chatRouter.post("/send", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(chatSendSchema, body);

  // Get session
  const sessions = await db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, input.sessionId));

  const session = sessions[0];
  if (!session) {
    throw new NotFoundError("Session not found");
  }

  // Handle planning sessions (worktreePath starts with "planning:")
  const isPlanningSession = session.worktreePath.startsWith("planning:");
  let worktreePath: string;

  if (isPlanningSession) {
    // For planning sessions, get the local path from repo_pins
    const repoPins = await db
      .select()
      .from(schema.repoPins)
      .where(eq(schema.repoPins.repoId, session.repoId))
      .limit(1);

    const repoPin = repoPins[0];
    if (!repoPin) {
      throw new BadRequestError(`Repo pin not found for repoId: ${session.repoId}`);
    }
    worktreePath = repoPin.localPath;
  } else {
    worktreePath = session.worktreePath;
  }

  if (!existsSync(worktreePath)) {
    throw new BadRequestError(`Path does not exist: ${worktreePath}`);
  }

  const now = new Date().toISOString();

  // Check if there's already a running agent for this session
  const runningRuns = await db
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.sessionId, input.sessionId),
        eq(schema.agentRuns.status, "running")
      )
    )
    .limit(1);

  const runningRun = runningRuns[0];

  // If already running, cancel the current execution first
  if (runningRun) {
    console.log(`[Chat] Send: Cancelling running agent to process new message`);

    // Get streaming state to preserve chunks
    const state = streamingStates.get(input.sessionId);

    // Kill the process if we have a pid
    if (runningRun.pid) {
      try {
        process.kill(runningRun.pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(runningRun.pid!, "SIGKILL");
          } catch {
            // Process may already be terminated
          }
        }, 500);
      } catch {
        // Process may already be terminated
      }
    }

    // Update agent run status to cancelled
    await db
      .update(schema.agentRuns)
      .set({ status: "cancelled", finishedAt: now })
      .where(eq(schema.agentRuns.id, runningRun.id));

    // Update assistant message with final content (preserve what we have)
    if (state?.assistantMsgId) {
      const finalContent = state.chunks.length > 0
        ? JSON.stringify({ chunks: state.chunks, interrupted: true })
        : JSON.stringify({ chunks: [], interrupted: true });

      await db
        .update(schema.chatMessages)
        .set({ content: finalContent })
        .where(eq(schema.chatMessages.id, state.assistantMsgId));
    }

    // Clear streaming state
    streamingStates.delete(input.sessionId);

    // Small delay to ensure process cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // 1. Save user message
  const userMsgResult = await db
    .insert(schema.chatMessages)
    .values({
      sessionId: input.sessionId,
      role: "user",
      content: input.userMessage,
      chatMode: input.chatMode ?? null,
      createdAt: now,
    })
    .returning();

  const userMsg = userMsgResult[0];
  if (!userMsg) {
    throw new BadRequestError("Failed to save user message");
  }

  // Note: User message is returned via API response, not broadcast
  // Only assistant messages are broadcast via WebSocket to avoid duplicates

  // 2. Build prompt with context
  const prompt = await buildPrompt(session, input.userMessage, input.context);

  // 3. Create agent run record (status: running)
  const promptDigest = createHash("md5").update(prompt).digest("hex");
  const startedAt = new Date().toISOString();

  const runResult = await db
    .insert(schema.agentRuns)
    .values({
      sessionId: input.sessionId,
      repoId: session.repoId,
      worktreePath,
      inputPromptDigest: promptDigest,
      startedAt,
      status: "running",
      createdAt: startedAt,
    })
    .returning();

  const run = runResult[0];
  if (!run) {
    throw new BadRequestError("Failed to create agent run record");
  }
  const runId = run.id;
  console.log(`[Chat] Send: Created agentRun ${runId} for session ${input.sessionId}`);

  // 4. Execute Claude ASYNCHRONOUSLY (non-blocking)
  // Return immediately, process in background
  const isExecution = input.chatMode === "execution";
  const claudeArgs = ["-p", prompt];
  // All sessions use streaming output
  claudeArgs.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");
  // Quick mode: use haiku for faster responses
  if (input.quickMode) {
    claudeArgs.push("--model", "haiku");
  }
  if (isExecution) {
    // Execution mode: bypass permissions
    claudeArgs.push("--dangerously-skip-permissions");
  }

  console.log(`[Chat] Send: Spawning claude process in ${worktreePath}`);
  // Spawn claude process in background
  const claudeProcess = spawn("claude", claudeArgs, {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Save pid for cancellation
  if (claudeProcess.pid) {
    console.log(`[Chat] Send: Claude process started with pid=${claudeProcess.pid}`);
    await db
      .update(schema.agentRuns)
      .set({ pid: claudeProcess.pid })
      .where(eq(schema.agentRuns.id, runId));
  } else {
    console.log(`[Chat] Send: Claude process has no pid!`);
  }

  let accumulatedText = "";
  const streamingChunks: StreamingChunk[] = [];
  let stderr = "";
  let lineBuffer = "";

  // Create assistant message in DB immediately (will be updated incrementally)
  const assistantMsgResult = await db
    .insert(schema.chatMessages)
    .values({
      sessionId: input.sessionId,
      role: "assistant",
      content: JSON.stringify({ chunks: [], streaming: true }),
      chatMode: input.chatMode ?? null,
      createdAt: now,
    })
    .returning();

  const assistantMsg = assistantMsgResult[0];
  const assistantMsgId = assistantMsg?.id ?? null;

  // Initialize streaming state (server-side storage for session recovery)
  streamingStates.set(input.sessionId, {
    sessionId: input.sessionId,
    runId,
    chunks: streamingChunks,
    isComplete: false,
    assistantMsgId,
    lastDbUpdateTime: Date.now(),
  });

  // Broadcast streaming start
  broadcast({
    type: "chat.streaming.start",
    repoId: session.repoId,
    data: { sessionId: input.sessionId, chatMode: input.chatMode, runId },
  });

  // Helper: Update assistant message in DB (debounced)
  const updateAssistantMessageInDb = async () => {
    if (!assistantMsgId) return;
    const state = streamingStates.get(input.sessionId);
    if (!state) return;

    try {
      await db
        .update(schema.chatMessages)
        .set({
          content: JSON.stringify({ chunks: state.chunks, streaming: true }),
        })
        .where(eq(schema.chatMessages.id, assistantMsgId));
      state.lastDbUpdateTime = Date.now();
    } catch (err) {
      console.error("[Chat] Failed to update assistant message:", err);
    }
  };

  claudeProcess.stdout.on("data", (data: Buffer) => {
    // Parse stream-json format for all sessions
    lineBuffer += data.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);

        if (json.type === "assistant" && json.message?.content) {
          for (const block of json.message.content) {
            if (block.type === "thinking" && block.thinking) {
              streamingChunks.push({ type: "thinking", content: block.thinking });
              broadcast({
                type: "chat.streaming.chunk",
                repoId: session.repoId,
                data: {
                  sessionId: input.sessionId,
                  chunkType: "thinking",
                  content: block.thinking,
                },
              });
            } else if (block.type === "text" && block.text) {
              accumulatedText += block.text;
              streamingChunks.push({ type: "text", content: block.text });
              broadcast({
                type: "chat.streaming.chunk",
                repoId: session.repoId,
                data: {
                  sessionId: input.sessionId,
                  chunkType: "text",
                  content: block.text,
                },
              });
            } else if (block.type === "tool_use") {
              streamingChunks.push({ type: "tool_use", toolName: block.name, toolInput: block.input });
              broadcast({
                type: "chat.streaming.chunk",
                repoId: session.repoId,
                data: {
                  sessionId: input.sessionId,
                  chunkType: "tool_use",
                  toolName: block.name,
                  toolInput: block.input,
                },
              });
            } else if (block.type === "tool_result") {
              const resultContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              streamingChunks.push({ type: "tool_result", content: resultContent });
              broadcast({
                type: "chat.streaming.chunk",
                repoId: session.repoId,
                data: {
                  sessionId: input.sessionId,
                  chunkType: "tool_result",
                  content: resultContent,
                },
              });
            }
          }
        } else if (json.type === "content_block_delta") {
          if (json.delta?.thinking) {
            streamingChunks.push({ type: "thinking", content: json.delta.thinking });
            broadcast({
              type: "chat.streaming.chunk",
              repoId: session.repoId,
              data: {
                sessionId: input.sessionId,
                chunkType: "thinking_delta",
                content: json.delta.thinking,
              },
            });
          } else if (json.delta?.text) {
            accumulatedText += json.delta.text;
            streamingChunks.push({ type: "text", content: json.delta.text });
            broadcast({
              type: "chat.streaming.chunk",
              repoId: session.repoId,
              data: {
                sessionId: input.sessionId,
                chunkType: "text_delta",
                content: json.delta.text,
              },
            });
          }
        }
      } catch {
        // Non-JSON line, ignore
      }
    }

    // Periodically update DB (every 500ms)
    const state = streamingStates.get(input.sessionId);
    if (state && Date.now() - state.lastDbUpdateTime > 500) {
      updateAssistantMessageInDb();
    }
  });

  claudeProcess.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  claudeProcess.on("close", async (code) => {
    console.log(`[Chat] Close: Process closed with code=${code}, sessionId=${input.sessionId}`);
    const finishedAt = new Date().toISOString();
    const status = code === 0 ? "success" : "failed";

    // Save structured content with chunks for all sessions
    let assistantContent: string;
    if (streamingChunks.length > 0) {
      assistantContent = JSON.stringify({ chunks: streamingChunks });
    } else {
      assistantContent = accumulatedText.trim() || "Claude execution failed. Please try again.";
    }

    // Update agent run
    console.log(`[Chat] Close: Updating agentRun ${runId} to status=${status}`);
    await db
      .update(schema.agentRuns)
      .set({
        finishedAt,
        status,
        stdoutSnippet: accumulatedText.slice(0, 5000),
        stderrSnippet: stderr.slice(0, 1000),
      })
      .where(eq(schema.agentRuns.id, runId));

    // Update existing assistant message (created at streaming start)
    if (assistantMsgId) {
      console.log(`[Chat] Close: Updating assistant message ${assistantMsgId}`);
      await db
        .update(schema.chatMessages)
        .set({
          content: assistantContent,
        })
        .where(eq(schema.chatMessages.id, assistantMsgId));

      // Get the updated message
      const [updatedMsg] = await db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, assistantMsgId));

      if (updatedMsg) {
        // Update session lastUsedAt
        await db
          .update(schema.chatSessions)
          .set({ lastUsedAt: finishedAt, updatedAt: finishedAt })
          .where(eq(schema.chatSessions.id, input.sessionId));

        console.log(`[Chat] Close: Broadcasting streaming.end for sessionId=${input.sessionId}, repoId=${session.repoId}`);
        // Broadcast streaming end
        broadcast({
          type: "chat.streaming.end",
          repoId: session.repoId,
          data: { sessionId: input.sessionId, message: toMessage(updatedMsg) },
        });

        // Broadcast assistant message
        broadcast({
          type: "chat.message",
          repoId: session.repoId,
          data: toMessage(updatedMsg),
        });

        // Clear streaming state after a delay (allow late clients to fetch)
        setTimeout(() => {
          streamingStates.delete(input.sessionId);
        }, 5000);

        // Auto-link PRs found in assistant response (for execution mode)
        if (input.chatMode === "execution" && session.branchName) {
          const prUrls = extractGitHubPrUrls(assistantContent);
          for (const pr of prUrls) {
            try {
              await savePrLink(session.repoId, session.branchName, pr.url, pr.number);
            } catch (err) {
              console.error(`[Chat] Failed to auto-link PR:`, err);
            }
          }
        }
      }
    }
  });

  claudeProcess.on("error", async (err) => {
    console.error(`[Chat] Claude process error:`, err);
    const finishedAt = new Date().toISOString();

    // Update agent run as failed
    await db
      .update(schema.agentRuns)
      .set({
        finishedAt,
        status: "failed",
        stderrSnippet: err.message.slice(0, 1000),
      })
      .where(eq(schema.agentRuns.id, runId));

    // Update existing assistant message with error
    if (assistantMsgId) {
      await db
        .update(schema.chatMessages)
        .set({
          content: `Claude execution failed: ${err.message}`,
        })
        .where(eq(schema.chatMessages.id, assistantMsgId));

      const [updatedMsg] = await db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, assistantMsgId));

      if (updatedMsg) {
        // Broadcast streaming end
        broadcast({
          type: "chat.streaming.end",
          repoId: session.repoId,
          data: { sessionId: input.sessionId, message: toMessage(updatedMsg) },
        });

        broadcast({
          type: "chat.message",
          repoId: session.repoId,
          data: toMessage(updatedMsg),
        });
      }
    }

    // Clear streaming state
    streamingStates.delete(input.sessionId);
  });

  // Return immediately with user message and run ID
  // Assistant message will be broadcast via WebSocket when ready
  return c.json({
    userMessage: toMessage(userMsg),
    runId: runId,
    status: "processing",
  });
});

// GET /api/chat/streaming/:sessionId - Get current streaming state for session recovery
chatRouter.get("/streaming/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const state = streamingStates.get(sessionId);

  if (!state) {
    return c.json({ isStreaming: false, chunks: [] });
  }

  return c.json({
    isStreaming: !state.isComplete,
    runId: state.runId,
    chunks: state.chunks,
  });
});

// POST /api/chat/summarize - Generate summary of conversation
chatRouter.post("/summarize", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(chatSummarizeSchema, body);

  // Get session
  const sessions = await db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, input.sessionId));

  const session = sessions[0];
  if (!session) {
    throw new NotFoundError("Session not found");
  }

  // Get latest summary if exists
  const summaries = await db
    .select()
    .from(schema.chatSummaries)
    .where(eq(schema.chatSummaries.sessionId, input.sessionId))
    .orderBy(desc(schema.chatSummaries.createdAt))
    .limit(1);

  const lastSummary = summaries[0];
  const coveredUntil = lastSummary?.coveredUntilMessageId ?? 0;

  // Get messages after last summary
  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(
      and(
        eq(schema.chatMessages.sessionId, input.sessionId),
        gt(schema.chatMessages.id, coveredUntil)
      )
    )
    .orderBy(asc(schema.chatMessages.createdAt));

  if (messages.length === 0) {
    return c.json({ message: "No new messages to summarize" });
  }

  // Build summary prompt
  const conversationText = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  const summaryPrompt = `Please summarize the following conversation. Focus on:
1. Key decisions made
2. Tasks completed
3. Outstanding issues or next steps
4. Important context that should be preserved

Conversation:
${conversationText}

Provide a concise markdown summary (max 500 words).`;

  let summaryContent = "";
  try {
    summaryContent = execSync(`claude -p "${escapeShell(summaryPrompt)}"`, {
      cwd: session.worktreePath,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: 60000,
    });
  } catch {
    // Fallback: simple summary
    summaryContent = `## Conversation Summary\n\n- ${messages.length} messages exchanged\n- Last update: ${messages[messages.length - 1]?.createdAt}`;
  }

  const now = new Date().toISOString();
  const lastMessageId = messages[messages.length - 1]?.id ?? 0;

  await db.insert(schema.chatSummaries).values({
    sessionId: input.sessionId,
    summaryMarkdown: summaryContent,
    coveredUntilMessageId: lastMessageId,
    createdAt: now,
  });

  const summary: ChatSummary = {
    id: 0, // Will be set by DB
    sessionId: input.sessionId,
    summaryMarkdown: summaryContent,
    coveredUntilMessageId: lastMessageId,
    createdAt: now,
  };

  return c.json(summary);
});

// POST /api/chat/purge - Delete old messages
chatRouter.post("/purge", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(chatPurgeSchema, body);

  // Get all messages for session ordered by id desc
  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, input.sessionId))
    .orderBy(desc(schema.chatMessages.id));

  if (messages.length <= input.keepLastN) {
    return c.json({ deleted: 0, remaining: messages.length });
  }

  // Delete old messages (all except last N)
  const toDelete = messages.slice(input.keepLastN);
  for (const msg of toDelete) {
    await db.delete(schema.chatMessages).where(eq(schema.chatMessages.id, msg.id));
  }

  return c.json({ deleted: toDelete.length, remaining: input.keepLastN });
});

// Refinement system prompt (task breakdown)
const REFINEMENT_SYSTEM_PROMPT = `あなたはプロジェクト計画のアシスタントです。

## 役割
1. ユーザーの要件を理解するために積極的に質問する
2. **共有されたリンク・ドキュメントがあれば、その内容を確認・整理してタスクに反映する**
3. タスクを分解して提案する
4. タスク間の親子関係を考慮して提案する

## 【重要】AskUserQuestion ツールを積極的に使う
ユーザーに質問する際は、**AskUserQuestion ツール**を使用してください。
選択肢形式で質問することで、ユーザーが簡単に回答できます。

### 使用場面：
- 機能の優先度を聞きたい時
- 技術的な選択肢を提示したい時
- 実装アプローチを確認したい時
- 仕様の詳細を確認したい時

## 重要：共有リンクの活用
ユーザーがリンク（Notion、GitHub Issue、Figma、その他URL）を共有した場合：
- リンクの内容を確認し、要件を抽出する
- 内容に基づいてタスクを提案する
- 不明点があれば選択式フォーマットで質問する

## タスク提案フォーマット
タスクを提案する際は、必ず以下の形式を使ってください：

<<TASK>>
{"label": "タスク名", "description": "タスクの説明", "parent": "親タスク名（任意）", "branch": "【ブランチ命名規則に従ったブランチ名】", "issue": "関連するGitHub IssueのURL（任意）"}
<</TASK>>

### フィールド説明：
- label: タスクの名前（必須）
- description: タスクの説明、完了条件など（必須）
- parent: このタスクの親となるタスク名。親子関係がある場合に指定（任意）
- branch: **必須。下記の「ブランチ命名規則」セクションで指定されたパターンに完全に従うこと。feature/ や feat/ などのデフォルトパターンは使用禁止。**
- issue: このタスクに関連するGitHub IssueのURL（任意）。共有されたリンクにGitHub Issueがあれば紐づける。

## 注意点
- 1つのメッセージで複数のタスクを提案してOK
- タスクは具体的に、1〜2日で完了できる粒度に
- 関連するタスクは親子関係を設定する
- **ブランチ名は必ず「ブランチ命名規則」セクションのパターンに従うこと**
- GitHub Issueが共有されている場合、関連するタスクにissueフィールドでURLを紐づける
- ユーザーがブランチ名の変更を依頼したら、新しいタスク提案で修正版を提示する
- ユーザーが情報を共有したら、まず内容を理解・整理してから質問やタスク提案を行う
`;

// Instruction review system prompt (for Planning sessions)
const INSTRUCTION_REVIEW_SYSTEM_PROMPT = `あなたはタスクインストラクションを詳細化・具体化するアシスタントです。

## 目的
ユーザーと対話しながら、このブランチで実行すべきタスクの内容を明確に定義していきます。
最終的には、AIが実装を進められるレベルまでタスクインストラクションを具体化することがゴールです。

## 重要な制約
- **タスクの実行は絶対にしない**: コードを書いたり、実装したり、ファイルを変更したりしない
- あくまで「計画・設計フェーズ」であり、実行は別のセッションで行う
- 提案や質問を通じて、タスクインストラクションを洗練させることに集中する

## 役割
1. 現在のタスクインストラクションの内容を確認・精査する
2. 不明確な点や曖昧な記述を指摘し、具体化を促す
3. より良い表現や構成を提案する
4. 技術的な観点からのフィードバックを行う
5. 足りない情報を質問で引き出す
6. **ToDoリストを作成・更新する**

## 【重要】AskUserQuestion ツールを積極的に使う
ユーザーに質問する際は、**AskUserQuestion ツール**を使用してください。
選択肢形式で質問することで、ユーザーが簡単に回答できます。

### 使用場面：
- 仕様の詳細を確認したい時
- 実装アプローチの選択肢を提示したい時
- 優先順位を確認したい時
- エッジケースの処理方法を聞きたい時

## 詳細化のポイント
- 目的・ゴールが明確か
- 実装に必要な情報が揃っているか
- 曖昧な表現がないか
- 技術的な矛盾や問題がないか
- 優先順位や依存関係が明確か
- エッジケースや例外処理の考慮があるか

## フィードバック時の注意
- 具体的な改善案を提示する
- 良い点も指摘する
- 選択式フォーマットで質問は1-2問に絞る
- ユーザーの意図を尊重しながら改善を提案する

## タスクインストラクション更新フォーマット
タスクインストラクションの変更を提案する際は、必ず以下の形式を使ってください：

<<INSTRUCTION_EDIT>>
（ここに更新後のタスクインストラクション全文を記載）
<</INSTRUCTION_EDIT>>

### 使用ルール：
- 更新を提案する場合は、変更後の**完全なインストラクション**をタグ内に記載する
- 部分的な変更ではなく、全文を含める（diffではなく新しい全体）
- ユーザーがUIで「Accept」すると、この内容でタスクインストラクションが更新される
- 1つのメッセージに1つの提案のみ
- タグの前後に説明を付けて、何を変更したかを伝える

### 例：
「目的セクションを追加し、優先度を明確化しました：」

<<INSTRUCTION_EDIT>>
# 目的
ユーザー認証機能を実装する

# 優先度
高

# 実装内容
- ログイン画面の作成
- セッション管理
- ログアウト機能
<</INSTRUCTION_EDIT>>

## ToDo管理フォーマット【重要】
タスクの実装手順や作業項目を管理するために、ToDoリストを作成・更新してください。
インストラクションの内容に基づいて、具体的なToDoを提案してください。

<<TODO_UPDATE>>
<item action="add" status="pending">ToDoの内容をここに記載</item>
<item action="add" status="pending">別のToDoの内容</item>
<item action="complete" id="123" />
<item action="update" id="456" status="in_progress">更新後のタイトル</item>
<item action="delete" id="789" />
<</TODO_UPDATE>>

### ToDoアクション一覧：
- **add**: 新しいToDoを追加（status: pending/in_progress/completed）
- **complete**: 既存のToDoを完了にする（idが必要）
- **update**: 既存のToDoを更新する（id必須、status/titleを変更可能）
- **delete**: 既存のToDoを削除する（idが必要）

### 使用ガイドライン：
- インストラクションを具体化したら、それに対応するToDoも提案する
- ユーザーと合意した実装方針をToDoに反映する
- ToDoは実装時の作業チェックリストとして使用される
- 1メッセージで複数のToDoアクションを含めてOK

### 例：
「インストラクションを整理したので、ToDoリストも作成しました：」

<<TODO_UPDATE>>
<item action="add" status="pending">ログイン画面のUIを作成する</item>
<item action="add" status="pending">認証APIエンドポイントを実装する</item>
<item action="add" status="pending">セッション管理ロジックを追加する</item>
<</TODO_UPDATE>>
`;

// Helper: Build prompt with full context
async function buildPrompt(
  session: typeof schema.chatSessions.$inferSelect,
  userMessage: string,
  context?: string
): Promise<string> {
  const parts: string[] = [];

  // Check if this is a planning session (Refinement or Planning tab)
  const isClaudeCodeSession = session.worktreePath.startsWith("planning:");
  const planningSessionId = isClaudeCodeSession
    ? session.worktreePath.replace("planning:", "")
    : null;
  const actualPath = isClaudeCodeSession
    ? session.worktreePath.replace("planning:", "")
    : session.worktreePath;

  // Get planning session to check if it's an Instruction Review session
  let isInstructionReviewSession = false;
  if (planningSessionId) {
    const [planningSession] = await db
      .select()
      .from(schema.planningSessions)
      .where(eq(schema.planningSessions.id, planningSessionId));
    // Use type property if available, fall back to title-based detection for legacy data
    if (planningSession?.type === "planning" || planningSession?.title.startsWith("Planning:")) {
      isInstructionReviewSession = true;
    }
  }

  // 1. System: Project rules (fetch early for use in both modes)
  const rules = await db
    .select()
    .from(schema.projectRules)
    .where(
      and(
        eq(schema.projectRules.repoId, session.repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    );

  const branchNaming = rules[0]
    ? (JSON.parse(rules[0].ruleJson) as BranchNamingRule)
    : null;

  if (isClaudeCodeSession) {
    if (isInstructionReviewSession) {
      // Planning tab: Instruction review mode
      parts.push(INSTRUCTION_REVIEW_SYSTEM_PROMPT);
      parts.push(`## Repository: ${session.repoId}\n`);
    } else {
      // Refinement tab: Task breakdown mode
      // Add branch naming rules FIRST for planning sessions (most important)
      if (branchNaming && branchNaming.pattern) {
        parts.push(`# ブランチ命名規則【厳守】

ブランチ名は以下のパターンに従ってください:

${branchNaming.pattern}

{} で囲まれた部分をタスクに応じて置換してください。
※ {issueId} がパターンに含まれていても、Issue番号がない場合は省略してください。
${branchNaming.examples?.length ? `\n例: ${branchNaming.examples.join(", ")}` : ""}
`);
      }

      parts.push(REFINEMENT_SYSTEM_PROMPT);
      parts.push(`## Repository: ${session.repoId}\n`);
    }
  }

  if (!isClaudeCodeSession) {
    parts.push(`# System Context

## Working Directory
- Path: ${actualPath}
- Branch: ${session.branchName ?? "unknown"}
- Repository: ${session.repoId}

## Project Rules
${branchNaming ? `- Branch naming: \`${branchNaming.pattern}\`` : "- No specific rules configured"}
`);

    // Add task instruction for execution sessions
    if (session.branchName) {
      const instructions = await db
        .select()
        .from(schema.taskInstructions)
        .where(
          and(
            eq(schema.taskInstructions.repoId, session.repoId),
            eq(schema.taskInstructions.branchName, session.branchName)
          )
        )
        .limit(1);

      if (instructions[0]) {
        parts.push(`## タスクインストラクション
以下がこのタスクの実装指示です。この内容に従って実装を進めてください。

${instructions[0].instructionMd}
`);
      }
    }
  }

  // 2. Context: Git status (skip for planning sessions)
  if (!isClaudeCodeSession) {
    let gitStatus = "";
    try {
      gitStatus = execSync(`cd "${actualPath}" && git status --short`, {
        encoding: "utf-8",
      }).trim();
    } catch {
      gitStatus = "";
    }

    parts.push(`## Current Git Status
\`\`\`
${gitStatus || "Clean working directory"}
\`\`\`
`);
  }

  // 3. External links context and base branch (for planning sessions)
  if (isClaudeCodeSession) {
    // Find the planning session that has this chat session linked
    const planningSession = await db
      .select()
      .from(schema.planningSessions)
      .where(eq(schema.planningSessions.chatSessionId, session.id))
      .limit(1);

    if (planningSession[0]) {
      // Check if this is a multi-branch planning session
      const executeBranches = planningSession[0].executeBranchesJson
        ? JSON.parse(planningSession[0].executeBranchesJson) as string[]
        : [];
      const currentBranchIndex = planningSession[0].currentExecuteIndex ?? 0;
      const currentBranch = executeBranches.length > 0
        ? executeBranches[currentBranchIndex]
        : planningSession[0].baseBranch;

      if (executeBranches.length > 0) {
        // Multi-branch planning session
        parts.push(`## 作業対象ブランチ一覧
${executeBranches.map((b, i) => `${i === currentBranchIndex ? "→ " : "  "}${i + 1}. \`${b}\`${i === currentBranchIndex ? " 【現在編集中】" : ""}`).join("\n")}

現在は **${currentBranch}** のインストラクションとToDoを編集しています。
`);
      } else {
        // Single branch (legacy)
        parts.push(`## ベースブランチ
このPlanning Sessionのベースブランチ: \`${planningSession[0].baseBranch}\`
提案するタスクは、このブランチを起点として作成されます。
`);
      }

      // Add task instruction for Planning sessions
      if (isInstructionReviewSession) {
        const instructions = await db
          .select()
          .from(schema.taskInstructions)
          .where(
            and(
              eq(schema.taskInstructions.repoId, session.repoId),
              eq(schema.taskInstructions.branchName, currentBranch)
            )
          )
          .limit(1);

        if (instructions[0]) {
          parts.push(`## タスクインストラクション【精査対象】
ブランチ: \`${currentBranch}\`

以下がこのタスクのインストラクションです。内容を確認し、不明瞭な点や改善点があれば指摘してください。
変更がある場合は <<INSTRUCTION_EDIT>> タグで全文を提案してください。

\`\`\`markdown
${instructions[0].instructionMd}
\`\`\`
`);
        } else {
          parts.push(`## タスクインストラクション【未作成】
ブランチ: \`${currentBranch}\`

このブランチにはまだインストラクションがありません。
ユーザーと対話してインストラクションを作成してください。
作成後は <<INSTRUCTION_EDIT>> タグで全文を提案してください。
`);
        }

        // Add current todos for this branch
        const todos = await db
          .select()
          .from(schema.taskTodos)
          .where(
            and(
              eq(schema.taskTodos.repoId, session.repoId),
              eq(schema.taskTodos.branchName, currentBranch)
            )
          )
          .orderBy(asc(schema.taskTodos.orderIndex));

        if (todos.length > 0) {
          const todoList = todos.map((t) => {
            const statusIcon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
            return `${statusIcon} [id:${t.id}] ${t.title}`;
          }).join("\n");

          parts.push(`## 現在のToDoリスト
ブランチ: \`${currentBranch}\`

${todoList}

ToDoを更新する場合は <<TODO_UPDATE>> タグを使用してください。
`);
        } else {
          parts.push(`## ToDoリスト【未作成】
ブランチ: \`${currentBranch}\`

このブランチにはまだToDoがありません。
インストラクションに基づいて、具体的な作業項目をToDoとして追加してください。
<<TODO_UPDATE>> タグを使用してToDoを作成できます。
`);
        }
      }

      const links = await db
        .select()
        .from(schema.externalLinks)
        .where(eq(schema.externalLinks.planningSessionId, planningSession[0].id));

      console.log(`[Chat] Found ${links.length} external links for planning session ${planningSession[0].id}`);

      if (links.length > 0) {
        const linksContext = links.map((link) => {
          const typeLabel = {
            notion: "Notion",
            figma: "Figma",
            github_issue: "GitHub Issue",
            github_pr: "GitHub PR",
            url: "URL",
          }[link.linkType] || link.linkType;

          if (link.contentCache) {
            return `### ${link.title || typeLabel}\nSource: ${link.url}\n\n${link.contentCache}`;
          } else {
            // Still include the link even without cached content
            return `### ${link.title || typeLabel}\nSource: ${link.url}\n\n(コンテンツ未取得 - このリンクを参照してタスクを検討してください)`;
          }
        });

        parts.push(`## 共有されたリンク・ドキュメント
以下のリンクがユーザーから共有されています。これらの内容を読んで、タスクを提案してください。

${linksContext.join("\n\n---\n\n")}
`);
      }
    } else {
      console.log(`[Chat] No planning session found with chatSessionId=${session.id}`);
    }
  }

  // 4. Plan if available
  if (session.planId) {
    const plans = await db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.id, session.planId));

    if (plans[0]) {
      parts.push(`## Current Plan: ${plans[0].title}
${plans[0].contentMd}
`);
    }
  }

  // 5. Memory: Latest summary + recent messages
  const summaries = await db
    .select()
    .from(schema.chatSummaries)
    .where(eq(schema.chatSummaries.sessionId, session.id))
    .orderBy(desc(schema.chatSummaries.createdAt))
    .limit(1);

  if (summaries[0]) {
    parts.push(`## Previous Conversation Summary
${summaries[0].summaryMarkdown}
`);
  }

  // Get recent messages (last 20)
  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, session.id))
    .orderBy(desc(schema.chatMessages.createdAt))
    .limit(20);

  if (messages.length > 0) {
    const recentMsgs = messages.reverse(); // Oldest first
    parts.push(`## Recent Conversation
${recentMsgs.map((m) => `**${m.role}**: ${m.content.slice(0, 500)}${m.content.length > 500 ? "..." : ""}`).join("\n\n")}
`);
  }

  // 6. Context and Mode-specific prompts
  if (context) {
    // Parse mode from context
    const modeMatch = context.match(/\[Mode: (planning|execution)\]/);
    const mode = modeMatch?.[1] || "execution";

    // Add mode-specific system prompt
    if (mode === "planning") {
      parts.push(`## Mode: Planning

あなたはタスクの計画を支援するアシスタントです。

### 役割
- Task Instructionの内容を改善・具体化する
- 要件を明確にするための質問をする
- 実装方針を提案する

### Task Instruction の編集提案
Task Instructionの変更を提案する場合は、以下のフォーマットを使用してください：

<<INSTRUCTION_EDIT>>
（新しいTask Instructionの全文をここに記載）
<</INSTRUCTION_EDIT>>

ユーザーが「Commit」ボタンを押すと、この内容がTask Instructionに反映されます。

### Execution権限のリクエスト【重要】
Planningモードでは**ファイルの作成・編集・コード実行はできません**。
以下の操作が必要な場合は、必ずPERMISSION_REQUESTフォーマットを使用してください：

- ファイルを作成する
- コードを書く・編集する
- gitコマンドを実行する
- PRを作成する
- その他、実際の変更を伴う操作

**フォーマット（必ずこの形式を使用）：**
<<PERMISSION_REQUEST>>
{"action": "switch_to_execution", "reason": "〇〇を作成/実装するため"}
<</PERMISSION_REQUEST>>

このフォーマットを使うと、ユーザーに「許可してExecutionモードに切り替え」ボタンが表示されます。
ボタンをクリックすると、Executionモードに切り替わり、実装を進められます。

### 注意点
- Planningモードでは計画・相談のみ。実際の変更はExecutionモードで行う
- ファイル操作が必要になったら、すぐにPERMISSION_REQUESTを使用する
- 編集提案（INSTRUCTION_EDIT）は1つのメッセージに1つまで
- 具体的で実行可能な指示にする
`);
    } else {
      // Get parent branch for PR base
      let parentBranch = "main"; // default
      try {
        // Try to get the tree spec to find parent branch
        const treeSpecs = await db
          .select()
          .from(schema.treeSpecs)
          .where(eq(schema.treeSpecs.repoId, session.repoId))
          .limit(1);

        if (treeSpecs[0]) {
          const specJson = JSON.parse(treeSpecs[0].specJson) as { nodes: unknown[]; edges: { parent: string; child: string }[] };
          // Find edge where child is the current branch
          const edge = specJson.edges.find((e) => e.child === session.branchName);
          if (edge) {
            parentBranch = edge.parent;
          } else {
            // Use base branch from tree spec
            parentBranch = treeSpecs[0].baseBranch || "main";
          }
        }
      } catch {
        // Ignore errors, use default
      }

      parts.push(`## Mode: Execution (完全自動実行モード)

あなたはタスクを実装して完了させるアシスタントです。
これは**完全自動実行セッション**です。ユーザーの確認を求めずに、タスクを最後まで完了させてください。

### 【最重要】完全自動実行ルール
1. **確認・質問は絶対にしない**: 「よろしいですか？」「確認してください」などは禁止
2. **迷わず実装を進める**: 不明点があっても、最善と思われる方法で実装を完了させる
3. **必ずPR作成まで完了させる**: コミット→プッシュ→PR作成を一気に行う
4. **完了報告で終わる**: 「PRを作成しました: [URL]」で終了すること
5. **ユーザーの途中コメントには必ず対応する**: 実行中にユーザーからコメントがあった場合は、その内容を反映して作業を続けること。無視せず、指示に従って軌道修正すること

### 役割
1. **コードを書く**: Task Instructionに従って実装する
2. **コミットする**: 意味のある単位でコミットを作成する
3. **プッシュする**: リモートにプッシュする
4. **PRを作成する**: 適切なベースブランチを指定してPRを作成する

### 重要：ブランチについて
- **作業ブランチ**: \`${session.branchName}\`（このブランチで作業すること）
- **PRのベースブランチ**: \`${parentBranch}\`
- **新しいブランチを作成しないこと**: 既に \`${session.branchName}\` ブランチが用意されています。\`git checkout -b\` や \`git branch\` で新しいブランチを作成せず、この既存ブランチをそのまま使ってください
- PRを作成する際は必ず \`--base ${parentBranch}\` を指定してください

### 実装フロー（すべて一気に実行）
\`\`\`bash
# 1. コード実装後、変更をステージング
git add .

# 2. コミット
git commit -m "feat: 実装内容の説明"

# 3. プッシュ
git push -u origin ${session.branchName}

# 4. PR作成
gh pr create --base ${parentBranch} --title "PR タイトル" --body "PR の説明"
\`\`\`

### 禁止事項
- ❌ ユーザーに確認を求める
- ❌ 「どうしますか？」と聞く
- ❌ 実装方針の相談
- ❌ 途中で止まる
- ❌ 新しいブランチを作成する（\`git checkout -b\`、\`git branch\` 禁止）

### 必須事項
- ✅ Task Instructionの内容を即座に実装
- ✅ コミット→プッシュ→PR作成まで一気に完了
- ✅ PR URLを報告して終了
- ✅ ユーザーの途中コメントがあれば、その指示を反映して作業を継続
`);
    }

    // Add the context (Task Instruction)
    const contextWithoutMode = context.replace(/\[Mode: (planning|execution)\]/, "").trim();
    if (contextWithoutMode) {
      parts.push(`${contextWithoutMode}
`);
    }
  }

  // 7. User message
  parts.push(`## User Request
${userMessage}`);

  return parts.join("\n");
}

// Helper: Escape shell string
function escapeShell(str: string): string {
  return str.replace(/'/g, "'\"'\"'").replace(/"/g, '\\"');
}

// Helper: Extract GitHub PR URLs from text
function extractGitHubPrUrls(text: string): Array<{ url: string; number: number }> {
  const prUrlRegex = /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/(\d+)/g;
  const results: Array<{ url: string; number: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = prUrlRegex.exec(text)) !== null) {
    results.push({
      url: match[0],
      number: parseInt(match[1], 10),
    });
  }

  return results;
}

// Helper: Fetch PR info from GitHub
interface GitHubCheck {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

interface GitHubLabel {
  name: string;
  color: string;
}

function fetchGitHubPRInfo(repoId: string, prNumber: number): {
  title: string;
  status: string;
  checksStatus: string;
  checks: GitHubCheck[];
  labels: GitHubLabel[];
  reviewers: string[];
  projectStatus?: string;
} | null {
  try {
    const result = execSync(
      `gh pr view ${prNumber} --repo "${repoId}" --json number,title,state,statusCheckRollup,labels,reviewRequests,reviews,projectItems`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    const data = JSON.parse(result);

    // Extract individual checks - deduplicate by name, keeping only the latest
    const checksMap = new Map<string, GitHubCheck>();
    let checksStatus = "pending";
    if (data.statusCheckRollup && data.statusCheckRollup.length > 0) {
      for (const c of data.statusCheckRollup) {
        const name = c.name || c.context || "Unknown";
        checksMap.set(name, {
          name,
          status: c.status || "COMPLETED",
          conclusion: c.conclusion || null,
          detailsUrl: c.detailsUrl || c.targetUrl || null,
        });
      }
      const checks = Array.from(checksMap.values());
      const hasFailure = checks.some((c) =>
        c.conclusion === "FAILURE" || c.conclusion === "ERROR"
      );
      const allSuccess = checks.every((c) => c.conclusion === "SUCCESS" || c.conclusion === "SKIPPED");
      if (hasFailure) checksStatus = "failure";
      else if (allSuccess) checksStatus = "success";
    }
    const checks = Array.from(checksMap.values());

    // Extract reviewers (filter out bots like GitHub Copilot)
    const isBot = (login: string) =>
      login.toLowerCase().includes("copilot") || login.endsWith("[bot]");
    const reviewers: string[] = [];
    if (data.reviewRequests) {
      for (const r of data.reviewRequests) {
        if (r.login && !isBot(r.login)) reviewers.push(r.login);
      }
    }
    if (data.reviews) {
      for (const r of data.reviews) {
        if (r.author?.login && !isBot(r.author.login) && !reviewers.includes(r.author.login)) {
          reviewers.push(r.author.login);
        }
      }
    }

    // Extract project status
    let projectStatus: string | undefined;
    if (data.projectItems && data.projectItems.length > 0) {
      const item = data.projectItems[0];
      if (item.status) {
        projectStatus = item.status.name || item.status;
      }
    }

    return {
      title: data.title,
      status: data.state?.toLowerCase() || "open",
      checksStatus,
      checks,
      labels: (data.labels || []).map((l: { name: string; color: string }) => ({ name: l.name, color: l.color })),
      reviewers,
      projectStatus,
    };
  } catch (err) {
    console.error(`[Chat] Failed to fetch PR #${prNumber}:`, err);
    return null;
  }
}

// Helper: Save PR link to branchLinks (if not already exists)
async function savePrLink(
  repoId: string,
  branchName: string,
  prUrl: string,
  prNumber: number
): Promise<void> {
  const now = new Date().toISOString();

  // Check if already exists
  const existing = await db
    .select()
    .from(schema.branchLinks)
    .where(
      and(
        eq(schema.branchLinks.repoId, repoId),
        eq(schema.branchLinks.branchName, branchName),
        eq(schema.branchLinks.url, prUrl)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    // Fetch full PR info from GitHub
    const prInfo = fetchGitHubPRInfo(repoId, prNumber);

    await db.insert(schema.branchLinks).values({
      repoId,
      branchName,
      linkType: "pr",
      url: prUrl,
      number: prNumber,
      title: prInfo?.title ?? null,
      status: prInfo?.status ?? "open",
      checksStatus: prInfo?.checksStatus ?? null,
      checks: prInfo?.checks ? JSON.stringify(prInfo.checks) : null,
      labels: prInfo?.labels ? JSON.stringify(prInfo.labels) : null,
      reviewers: prInfo?.reviewers ? JSON.stringify(prInfo.reviewers) : null,
      projectStatus: prInfo?.projectStatus ?? null,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`[Chat] Auto-linked PR #${prNumber} to branch ${branchName}`);

    // Broadcast the new link
    const [newLink] = await db
      .select()
      .from(schema.branchLinks)
      .where(
        and(
          eq(schema.branchLinks.repoId, repoId),
          eq(schema.branchLinks.branchName, branchName),
          eq(schema.branchLinks.url, prUrl)
        )
      )
      .limit(1);

    if (newLink) {
      broadcast({
        type: "branchLink.created",
        repoId,
        data: newLink,
      });
    }
  }
}
