import { Hono } from "hono";
import { db, schema } from "../../db";
import { eq, and, desc, gt, asc } from "drizzle-orm";
import { execSync } from "child_process";
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

// POST /api/chat/sessions - Create or get existing session for worktree
chatRouter.post("/sessions", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createChatSessionSchema, body);
  const worktreePath = expandTilde(input.worktreePath);

  // Check if session already exists for this worktree
  const existing = await db
    .select()
    .from(schema.chatSessions)
    .where(
      and(
        eq(schema.chatSessions.repoId, input.repoId),
        eq(schema.chatSessions.worktreePath, worktreePath),
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

  // Get current branch from git
  let branchName: string | null = null;
  try {
    branchName = execSync(`cd "${worktreePath}" && git branch --show-current`, {
      encoding: "utf-8",
    }).trim() || null;
  } catch {
    // Ignore
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

  // Add initial assistant message
  const initialMessage = `こんにちは！何を作りたいですか？

URLやドキュメント（Notion、Google Docs など）があれば共有してください。内容を確認して、タスクを分解するお手伝いをします。`;

  await db.insert(schema.chatMessages).values({
    sessionId,
    role: "assistant",
    content: initialMessage,
    createdAt: now,
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

// POST /api/chat/send - Send a message (execute Claude)
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

  // Broadcast user message
  broadcast({
    type: "chat.message",
    repoId: session.repoId,
    data: toMessage(userMsg),
  });

  // 2. Build prompt with context
  const prompt = await buildPrompt(session, input.userMessage, input.context);

  // 3. Execute Claude
  const promptDigest = createHash("md5").update(prompt).digest("hex");
  const startedAt = new Date().toISOString();

  // Create agent run record
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

  let assistantContent = "";
  let stderr = "";
  let status: "success" | "failed" = "success";

  try {
    // Run claude -p synchronously for simplicity
    assistantContent = execSync(`claude -p "${escapeShell(prompt)}"`, {
      cwd: worktreePath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 300000, // 5 minutes
    });
  } catch (err: unknown) {
    status = "failed";
    if (err && typeof err === "object" && "stderr" in err) {
      stderr = String((err as { stderr: unknown }).stderr);
    }
    if (err && typeof err === "object" && "stdout" in err) {
      assistantContent = String((err as { stdout: unknown }).stdout) || "Claude execution failed";
    }
    if (!assistantContent) {
      assistantContent = "Claude execution failed. Please try again.";
    }
  }

  const finishedAt = new Date().toISOString();

  // Update agent run
  await db
    .update(schema.agentRuns)
    .set({
      finishedAt,
      status,
      stdoutSnippet: assistantContent.slice(0, 5000),
      stderrSnippet: stderr.slice(0, 1000),
    })
    .where(eq(schema.agentRuns.id, runId));

  // 4. Save assistant message
  const assistantMsgResult = await db
    .insert(schema.chatMessages)
    .values({
      sessionId: input.sessionId,
      role: "assistant",
      content: assistantContent,
      chatMode: input.chatMode ?? null,
      createdAt: finishedAt,
    })
    .returning();

  const assistantMsg = assistantMsgResult[0];
  if (!assistantMsg) {
    throw new BadRequestError("Failed to save assistant message");
  }

  // Update session lastUsedAt
  await db
    .update(schema.chatSessions)
    .set({ lastUsedAt: finishedAt, updatedAt: finishedAt })
    .where(eq(schema.chatSessions.id, input.sessionId));

  // Broadcast assistant message
  broadcast({
    type: "chat.message",
    repoId: session.repoId,
    data: toMessage(assistantMsg),
  });

  return c.json({
    assistantMessage: toMessage(assistantMsg),
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

// Planning system prompt
const PLANNING_SYSTEM_PROMPT = `あなたはプロジェクト計画のアシスタントです。

## 役割
1. ユーザーの要件を理解するために積極的に質問する
2. **共有されたリンク・ドキュメントがあれば、その内容を確認・整理してタスクに反映する**
3. タスクを分解して提案する
4. タスク間の親子関係を考慮して提案する

## 重要：共有リンクの活用
ユーザーがリンク（Notion、GitHub Issue、Figma、その他URL）を共有した場合：
- リンクの内容を確認し、要件を抽出する
- 内容に基づいてタスクを提案する
- 不明点があれば質問する

## 質問例（状況に応じて使う）
- "どんな機能が必要ですか？"
- "優先度の高い機能は何ですか？"
- "技術的な制約はありますか？"
- "デザインやUIの参考はありますか？"
- "デッドラインはありますか？"

## タスク提案フォーマット
タスクを提案する際は、必ず以下の形式を使ってください：

<<TASK>>
{"label": "タスク名", "description": "タスクの説明", "parent": "親タスク名（任意）", "branch": "feature/branch-name（任意）"}
<</TASK>>

### フィールド説明：
- label: タスクの名前（必須）
- description: タスクの説明、完了条件など（必須）
- parent: このタスクの親となるタスク名。親子関係がある場合に指定（任意）
- branch: このタスクのブランチ名。指定しない場合は自動生成される（任意）

### 例：

単独タスク:
<<TASK>>
{"label": "認証機能の実装", "description": "ログイン・ログアウト・セッション管理を実装する", "branch": "feature/auth"}
<</TASK>>

親子関係あり:
<<TASK>>
{"label": "認証機能の実装", "description": "認証システム全体の親タスク"}
<</TASK>>
<<TASK>>
{"label": "ログインフォーム作成", "description": "メール/パスワードでのログインUIを作成", "parent": "認証機能の実装", "branch": "feature/auth-login-form"}
<</TASK>>
<<TASK>>
{"label": "セッション管理", "description": "JWTトークンの発行と検証", "parent": "認証機能の実装", "branch": "feature/auth-session"}
<</TASK>>

## 注意点
- 1つのメッセージで複数のタスクを提案してOK
- タスクは具体的に、1〜2日で完了できる粒度に
- 関連するタスクは親子関係を設定する
- ブランチ名は英数字とハイフンのみ、feature/ や fix/ などのプレフィックスを推奨
- ユーザーがブランチ名の変更を依頼したら、新しいタスク提案で修正版を提示する
- ユーザーが情報を共有したら、まず内容を理解・整理してから質問やタスク提案を行う
`;

// Helper: Build prompt with full context
async function buildPrompt(
  session: typeof schema.chatSessions.$inferSelect,
  userMessage: string,
  context?: string
): Promise<string> {
  const parts: string[] = [];

  // Check if this is a planning session
  const isPlanningSession = session.worktreePath.startsWith("planning:");
  const actualPath = isPlanningSession
    ? session.worktreePath.replace("planning:", "")
    : session.worktreePath;

  if (isPlanningSession) {
    parts.push(PLANNING_SYSTEM_PROMPT);
    parts.push(`## Repository: ${session.repoId}\n`);
  }

  // 1. System: Project rules
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

  if (!isPlanningSession) {
    parts.push(`# System Context

## Working Directory
- Path: ${actualPath}
- Branch: ${session.branchName ?? "unknown"}
- Repository: ${session.repoId}

## Project Rules
${branchNaming ? `- Branch naming: \`${branchNaming.pattern}\`` : "- No specific rules configured"}
`);
  }

  // 2. Context: Git status (skip for planning sessions)
  if (!isPlanningSession) {
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

  // 3. External links context (for planning sessions)
  if (isPlanningSession) {
    // Find the planning session that has this chat session linked
    const planningSession = await db
      .select()
      .from(schema.planningSessions)
      .where(eq(schema.planningSessions.chatSessionId, session.id))
      .limit(1);

    if (planningSession[0]) {
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

### 注意点
- 編集提案は1つのメッセージに1つまで
- 既存の内容を踏まえて改善する
- 具体的で実行可能な指示にする
`);
    } else {
      parts.push(`## Mode: Execution

あなたはタスクを実装するアシスタントです。

### 役割
- Task Instructionに従ってコードを実装する
- 必要なファイルを作成・編集する
- テストを書く
- 問題があれば報告する

### 注意点
- Task Instructionの内容に忠実に実装する
- 不明点があれば質問する
- 段階的に実装を進める
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
