import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and } from "drizzle-orm";
import { spawn, type ChildProcess, execSync } from "child_process";
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { expandTilde, getRepoId } from "../utils";
import { broadcast } from "../ws";
import {
  aiStartSchema,
  aiStopSchema,
  validateOrThrow,
} from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";
import type { BranchNamingRule, Plan, AgentSession } from "../../shared/types";

export const aiRouter = new Hono();

// Track running agents: sessionId -> { process, heartbeatInterval, session }
interface RunningAgent {
  process: ChildProcess;
  heartbeatInterval: ReturnType<typeof setInterval>;
  session: AgentSession;
}

const runningAgents = new Map<string, RunningAgent>();

// Write heartbeat file
function writeHeartbeat(localPath: string, pid: number, agent: string = "claude") {
  const heartbeatDir = join(localPath, ".vibetree");
  const heartbeatPath = join(heartbeatDir, "heartbeat.json");

  if (!existsSync(heartbeatDir)) {
    mkdirSync(heartbeatDir, { recursive: true });
  }

  const heartbeat = {
    agent,
    pid,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(heartbeatPath, JSON.stringify(heartbeat, null, 2));
}

// Remove heartbeat file
function removeHeartbeat(localPath: string) {
  const heartbeatPath = join(localPath, ".vibetree", "heartbeat.json");
  try {
    if (existsSync(heartbeatPath)) {
      unlinkSync(heartbeatPath);
    }
  } catch {
    // Ignore errors
  }
}

// Generate prompt for Claude
async function generatePrompt(
  repoId: string,
  localPath: string,
  planId?: number,
  branch?: string
): Promise<string> {
  // Get plan if specified
  let plan: Plan | null = null;
  if (planId) {
    const plans = await db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.id, planId));
    if (plans[0]) {
      plan = {
        id: plans[0].id,
        repoId: plans[0].repoId,
        title: plans[0].title,
        contentMd: plans[0].contentMd,
        status: plans[0].status as "draft" | "committed",
        githubIssueUrl: plans[0].githubIssueUrl,
        createdAt: plans[0].createdAt,
        updatedAt: plans[0].updatedAt,
      };
    }
  }

  // Get branch naming rule
  const rules = await db
    .select()
    .from(schema.projectRules)
    .where(
      and(
        eq(schema.projectRules.repoId, repoId),
        eq(schema.projectRules.ruleType, "branch_naming"),
        eq(schema.projectRules.isActive, true)
      )
    );

  const ruleRecord = rules[0];
  const branchNaming = ruleRecord
    ? (JSON.parse(ruleRecord.ruleJson) as BranchNamingRule)
    : null;

  // Get current branch
  let currentBranch = branch ?? "";
  if (!currentBranch) {
    try {
      currentBranch = execSync(`cd "${localPath}" && git branch --show-current`, {
        encoding: "utf-8",
      }).trim();
    } catch {
      currentBranch = "unknown";
    }
  }

  // Get git status
  let gitStatus = "";
  try {
    gitStatus = execSync(`cd "${localPath}" && git status --short`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    gitStatus = "";
  }

  // Build prompt
  const parts: string[] = [];

  parts.push(`# Working on ${repoId}`);
  parts.push(`\nCurrent branch: \`${currentBranch}\``);

  if (branchNaming) {
    parts.push(`\n## Branch Naming Convention`);
    parts.push(`- Pattern: \`${branchNaming.pattern}\``);
    if (branchNaming.examples?.length) {
      parts.push(`- Examples: ${branchNaming.examples.join(", ")}`);
    }
  }

  if (plan) {
    parts.push(`\n## Current Plan: ${plan.title}`);
    if (plan.contentMd) {
      parts.push(plan.contentMd);
    }
  }

  if (gitStatus) {
    parts.push(`\n## Working Directory Status`);
    parts.push("```");
    parts.push(gitStatus);
    parts.push("```");
  } else {
    parts.push(`\n## Working Directory Status`);
    parts.push("Clean working directory.");
  }

  parts.push(`\n## Instructions`);
  parts.push(`Continue working on this project. Follow the branch naming convention if creating new branches.`);

  return parts.join("\n");
}

// Log instruction to DB
async function logInstruction(
  repoId: string,
  planId: number | null,
  localPath: string,
  kind: "director_suggestion" | "user_instruction" | "system_note",
  contentMd: string
) {
  await db.insert(schema.instructionsLog).values({
    repoId,
    planId,
    worktreePath: localPath,
    kind,
    contentMd,
    createdAt: new Date().toISOString(),
  });
}

// Update session in DB
async function updateSessionStatus(
  sessionId: string,
  status: "running" | "stopped" | "exited",
  exitCode?: number
) {
  const now = new Date().toISOString();
  await db
    .update(schema.agentSessions)
    .set({
      status,
      lastSeenAt: now,
      endedAt: status !== "running" ? now : undefined,
      exitCode: exitCode ?? undefined,
    })
    .where(eq(schema.agentSessions.id, sessionId));
}

// POST /api/ai/start - Start Claude agent
aiRouter.post("/start", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(aiStartSchema, body);
  const localPath = expandTilde(input.localPath);

  // Verify path exists
  if (!existsSync(localPath)) {
    throw new BadRequestError(`Local path does not exist: ${localPath}`);
  }

  // Get repo ID
  const repoId = getRepoId(localPath);
  if (!repoId) {
    throw new BadRequestError(`Could not detect GitHub repo at: ${localPath}`);
  }

  // Check if already running for this path
  for (const [sessionId, agent] of runningAgents) {
    if (agent.session.worktreePath === localPath && agent.session.status === "running") {
      return c.json({
        status: "already_running",
        sessionId,
        pid: agent.session.pid,
        repoId: agent.session.repoId,
        startedAt: agent.session.startedAt,
      });
    }
  }

  // Generate prompt
  const prompt = await generatePrompt(repoId, localPath, input.planId, input.branch);

  // Get current branch
  let branch: string | null = input.branch ?? null;
  if (!branch) {
    try {
      branch = execSync(`cd "${localPath}" && git branch --show-current`, {
        encoding: "utf-8",
      }).trim() || null;
    } catch {
      branch = null;
    }
  }

  // Start Claude process
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();

  const claudeProcess = spawn("claude", [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ], {
    cwd: localPath,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  if (!claudeProcess.pid) {
    throw new BadRequestError("Failed to start Claude process");
  }

  const pid = claudeProcess.pid;

  // Create session object
  const session: AgentSession = {
    id: sessionId,
    repoId,
    worktreePath: localPath,
    branch,
    status: "running",
    pid,
    startedAt,
    lastSeenAt: startedAt,
    endedAt: null,
    exitCode: null,
  };

  // Save session to DB
  await db.insert(schema.agentSessions).values({
    id: sessionId,
    repoId,
    worktreePath: localPath,
    branch,
    status: "running",
    pid,
    startedAt,
    lastSeenAt: startedAt,
  });

  // Write initial heartbeat
  writeHeartbeat(localPath, pid);

  // Start heartbeat updater (every 5 seconds)
  const heartbeatInterval = setInterval(async () => {
    writeHeartbeat(localPath, pid);
    // Update lastSeenAt in DB
    await db
      .update(schema.agentSessions)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId));
  }, 5000);

  // Track the running agent
  runningAgents.set(sessionId, {
    process: claudeProcess,
    heartbeatInterval,
    session,
  });

  // Log start instruction
  await logInstruction(
    repoId,
    input.planId ?? null,
    localPath,
    "system_note",
    `Claude agent started (session: ${sessionId})`
  );

  // Broadcast start event
  broadcast({
    type: "agent.started",
    repoId,
    data: { sessionId, pid, startedAt, localPath, branch },
  });

  // Stream stdout - parse stream-json format
  let lineBuffer = "";
  claudeProcess.stdout?.on("data", (data) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        broadcast({
          type: "agent.output",
          repoId,
          data: {
            sessionId,
            stream: "stdout",
            json,
            timestamp: new Date().toISOString(),
          },
        });
      } catch {
        // Non-JSON line, broadcast as raw text
        broadcast({
          type: "agent.output",
          repoId,
          data: {
            sessionId,
            stream: "stdout",
            data: line,
            timestamp: new Date().toISOString(),
          },
        });
      }
    }
  });

  // Stream stderr
  claudeProcess.stderr?.on("data", (data) => {
    const output = data.toString();
    broadcast({
      type: "agent.output",
      repoId,
      data: {
        sessionId,
        stream: "stderr",
        data: output,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // Handle process exit
  claudeProcess.on("exit", async (code) => {
    const agent = runningAgents.get(sessionId);
    if (agent) {
      clearInterval(agent.heartbeatInterval);
      removeHeartbeat(localPath);
      runningAgents.delete(sessionId);

      // Update session in DB
      await updateSessionStatus(sessionId, "exited", code ?? undefined);

      // Log finish instruction
      await logInstruction(
        repoId,
        input.planId ?? null,
        localPath,
        "system_note",
        `Claude agent finished with exit code ${code} (session: ${sessionId})`
      );

      // Broadcast finish event
      broadcast({
        type: "agent.finished",
        repoId,
        data: { sessionId, pid, exitCode: code, finishedAt: new Date().toISOString() },
      });
    }
  });

  claudeProcess.on("error", async (err) => {
    const agent = runningAgents.get(sessionId);
    if (agent) {
      clearInterval(agent.heartbeatInterval);
      removeHeartbeat(localPath);
      runningAgents.delete(sessionId);

      // Update session in DB
      await updateSessionStatus(sessionId, "exited", -1);

      // Log error
      await logInstruction(
        repoId,
        input.planId ?? null,
        localPath,
        "system_note",
        `Claude agent error: ${err.message} (session: ${sessionId})`
      );

      broadcast({
        type: "agent.finished",
        repoId,
        data: { sessionId, pid, exitCode: -1, error: err.message, finishedAt: new Date().toISOString() },
      });
    }
  });

  return c.json({
    status: "started",
    sessionId,
    pid,
    repoId,
    startedAt,
    localPath,
    branch,
  });
});

// POST /api/ai/stop - Stop a running Claude agent
aiRouter.post("/stop", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(aiStopSchema, body);

  // Find agent by pid
  let targetSessionId: string | null = null;
  let targetAgent: RunningAgent | null = null;

  for (const [sessionId, agent] of runningAgents) {
    if (agent.session.pid === input.pid) {
      targetSessionId = sessionId;
      targetAgent = agent;
      break;
    }
  }

  if (!targetSessionId || !targetAgent) {
    throw new NotFoundError(`No running agent with pid: ${input.pid}`);
  }

  // Clean up
  clearInterval(targetAgent.heartbeatInterval);
  removeHeartbeat(targetAgent.session.worktreePath);

  // Kill the process
  try {
    targetAgent.process.kill("SIGTERM");
  } catch {
    try {
      targetAgent.process.kill("SIGKILL");
    } catch {
      // Ignore
    }
  }

  runningAgents.delete(targetSessionId);

  // Update session in DB
  await updateSessionStatus(targetSessionId, "stopped");

  // Log stop instruction
  await logInstruction(
    targetAgent.session.repoId,
    null,
    targetAgent.session.worktreePath,
    "system_note",
    `Claude agent stopped from UI (session: ${targetSessionId})`
  );

  // Broadcast stop event
  broadcast({
    type: "agent.stopped",
    repoId: targetAgent.session.repoId,
    data: { sessionId: targetSessionId, pid: input.pid, stoppedAt: new Date().toISOString() },
  });

  return c.json({ status: "stopped", sessionId: targetSessionId, pid: input.pid });
});

// GET /api/ai/status - Get status of running agents
aiRouter.get("/status", (c) => {
  const agents: AgentSession[] = [];

  for (const [, agent] of runningAgents) {
    agents.push(agent.session);
  }

  return c.json({ agents });
});

// GET /api/ai/sessions - Get all sessions from DB
aiRouter.get("/sessions", async (c) => {
  const repoId = c.req.query("repoId");

  let sessions;
  if (repoId) {
    sessions = await db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.repoId, repoId))
      .orderBy(schema.agentSessions.startedAt);
  } else {
    sessions = await db
      .select()
      .from(schema.agentSessions)
      .orderBy(schema.agentSessions.startedAt);
  }

  return c.json({ sessions });
});
