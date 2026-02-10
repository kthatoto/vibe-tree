/**
 * Context Compactor Service
 *
 * Handles conversation compression and context management:
 * - Token estimation
 * - Automatic summarization triggers
 * - Segment management
 * - Artifact externalization
 */

import { db, schema } from "../../db";
import { eq, and, desc, asc, gt } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";

// Configuration
const CONFIG = {
  // Token thresholds
  MAX_CONTEXT_TOKENS: 150000, // Target max tokens for context
  SUMMARIZE_THRESHOLD: 100000, // Trigger summarization at this level
  RECENT_MESSAGES_KEEP: 10, // Always keep last N messages in full

  // Artifact externalization
  ARTIFACT_SIZE_THRESHOLD: 2000, // Characters - externalize tool_results larger than this
  ARTIFACT_SUMMARY_MAX_TOKENS: 200, // Max tokens for artifact summary

  // Token estimation (rough approximation)
  CHARS_PER_TOKEN: 4, // Average characters per token (conservative for Japanese)
};

/**
 * Estimate token count for a string
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Simple estimation: ~4 chars per token for mixed English/Japanese
  // This is conservative - actual count may be lower
  return Math.ceil(text.length / CONFIG.CHARS_PER_TOKEN);
}

/**
 * Check if a session needs summarization
 */
export async function needsSummarization(sessionId: string): Promise<{
  needed: boolean;
  currentTokens: number;
  messageCount: number;
}> {
  // Get all messages for the session
  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(asc(schema.chatMessages.createdAt));

  // Get latest summary
  const [latestSummary] = await db
    .select()
    .from(schema.chatSummaries)
    .where(eq(schema.chatSummaries.sessionId, sessionId))
    .orderBy(desc(schema.chatSummaries.createdAt))
    .limit(1);

  // Calculate tokens for messages not covered by summary
  const coveredUntilId = latestSummary?.coveredUntilMessageId ?? 0;
  const uncoveredMessages = messages.filter((m) => m.id > coveredUntilId);

  let totalTokens = 0;
  for (const msg of uncoveredMessages) {
    totalTokens += estimateTokens(msg.content);
  }

  // Add summary tokens if exists
  if (latestSummary) {
    totalTokens += estimateTokens(latestSummary.summaryMarkdown);
  }

  return {
    needed: totalTokens > CONFIG.SUMMARIZE_THRESHOLD,
    currentTokens: totalTokens,
    messageCount: uncoveredMessages.length,
  };
}

/**
 * Create or update a chat segment
 */
export async function createSegment(
  sessionId: string,
  startMessageId: number
): Promise<number> {
  const now = new Date().toISOString();

  // Get current max segment index
  const [maxSegment] = await db
    .select()
    .from(schema.chatSegments)
    .where(eq(schema.chatSegments.sessionId, sessionId))
    .orderBy(desc(schema.chatSegments.segmentIndex))
    .limit(1);

  const segmentIndex = (maxSegment?.segmentIndex ?? -1) + 1;

  const [segment] = await db
    .insert(schema.chatSegments)
    .values({
      sessionId,
      segmentIndex,
      startMessageId,
      endMessageId: null,
      summaryMarkdown: null,
      tokenEstimate: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return segment!.id;
}

/**
 * Close a segment and create summary
 */
export async function closeSegment(
  segmentId: number,
  endMessageId: number
): Promise<void> {
  const now = new Date().toISOString();

  // Get segment info
  const [segment] = await db
    .select()
    .from(schema.chatSegments)
    .where(eq(schema.chatSegments.id, segmentId));

  if (!segment) return;

  // Get messages in this segment
  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(
      and(
        eq(schema.chatMessages.sessionId, segment.sessionId),
        gt(schema.chatMessages.id, segment.startMessageId - 1)
      )
    )
    .orderBy(asc(schema.chatMessages.createdAt));

  const segmentMessages = messages.filter(
    (m) => m.id >= segment.startMessageId && m.id <= endMessageId
  );

  // Generate summary
  const summary = await generateSegmentSummary(segmentMessages);
  const tokenEstimate = estimateTokens(
    segmentMessages.map((m) => m.content).join("\n")
  );

  // Update segment
  await db
    .update(schema.chatSegments)
    .set({
      endMessageId,
      summaryMarkdown: summary,
      tokenEstimate,
      status: "summarized",
      updatedAt: now,
    })
    .where(eq(schema.chatSegments.id, segmentId));
}

/**
 * Generate summary for a segment
 */
async function generateSegmentSummary(
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  if (messages.length === 0) return "";

  const conversationText = messages
    .map((m) => {
      // Parse JSON content for assistant messages
      let content = m.content;
      try {
        const parsed = JSON.parse(m.content);
        if (parsed.chunks) {
          content = parsed.chunks
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { content: string }) => c.content || "")
            .join("");
        }
      } catch {
        // Plain text
      }
      return `[${m.role}]: ${content.slice(0, 500)}`;
    })
    .join("\n\n");

  const prompt = `以下の会話セグメントを簡潔に要約してください。

要約には以下を含めてください：
- 主要なタスク/決定事項
- 重要な技術的詳細
- 未解決の問題やTODO

会話:
${conversationText.slice(0, 8000)}

要約（200-300文字）:`;

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.text?.trim() || `${messages.length}件のメッセージ`;
  } catch (err) {
    console.error("[ContextCompactor] Summary generation failed:", err);
    return `${messages.length}件のメッセージのセグメント`;
  }
}

/**
 * Externalize a large artifact
 */
export async function externalizeArtifact(options: {
  sessionId?: string;
  messageId?: number;
  artifactType: "tool_result" | "figma_design" | "file_content" | "code_block";
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<{ refId: string; summary: string }> {
  const { sessionId, messageId, artifactType, content, metadata } = options;

  // Generate unique ref ID
  const refId = `artifact_${randomUUID().slice(0, 8)}`;

  // Generate content hash for deduplication
  const contentHash = createHash("md5").update(content).digest("hex");

  // Check for existing artifact with same hash
  const [existing] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.contentHash, contentHash))
    .limit(1);

  if (existing) {
    return {
      refId: existing.refId,
      summary: existing.summaryMarkdown || "",
    };
  }

  // Generate summary for the artifact
  const summary = await generateArtifactSummary(content, artifactType);

  const now = new Date().toISOString();
  await db.insert(schema.artifacts).values({
    sessionId: sessionId ?? null,
    messageId: messageId ?? null,
    artifactType,
    refId,
    contentHash,
    content,
    summaryMarkdown: summary,
    tokenEstimate: estimateTokens(content),
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt: now,
  });

  return { refId, summary };
}

/**
 * Generate summary for an artifact
 */
async function generateArtifactSummary(
  content: string,
  type: string
): Promise<string> {
  // For small content, return truncated version
  if (content.length < 500) {
    return content;
  }

  const typePrompts: Record<string, string> = {
    tool_result: "このツール実行結果を1-2文で要約:",
    figma_design: "このFigmaデザイン情報を1-2文で要約:",
    file_content: "このファイル内容を1-2文で要約:",
    code_block: "このコードの機能を1-2文で要約:",
  };

  const prompt = `${typePrompts[type] || "内容を1-2文で要約:"}

${content.slice(0, 2000)}

要約:`;

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.text?.trim() || content.slice(0, 200);
  } catch {
    return content.slice(0, 200) + "...";
  }
}

/**
 * Get artifact by ref ID
 */
export async function getArtifact(
  refId: string
): Promise<typeof schema.artifacts.$inferSelect | null> {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.refId, refId))
    .limit(1);

  return artifact ?? null;
}

/**
 * Check if content should be externalized
 */
export function shouldExternalize(content: string): boolean {
  return content.length > CONFIG.ARTIFACT_SIZE_THRESHOLD;
}

/**
 * Build compacted context for a session
 * Returns messages with old content replaced by summaries
 */
export async function buildCompactedContext(sessionId: string): Promise<{
  summary: string | null;
  recentMessages: Array<{ role: string; content: string }>;
  totalTokens: number;
}> {
  // Get latest summary
  const [latestSummary] = await db
    .select()
    .from(schema.chatSummaries)
    .where(eq(schema.chatSummaries.sessionId, sessionId))
    .orderBy(desc(schema.chatSummaries.createdAt))
    .limit(1);

  // Get messages after the summary (or all if no summary)
  const coveredUntilId = latestSummary?.coveredUntilMessageId ?? 0;

  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(
      and(
        eq(schema.chatMessages.sessionId, sessionId),
        gt(schema.chatMessages.id, coveredUntilId)
      )
    )
    .orderBy(asc(schema.chatMessages.createdAt));

  // Keep last N messages in full, summarize the rest
  const recentCount = Math.min(messages.length, CONFIG.RECENT_MESSAGES_KEEP);
  const recentMessages = messages.slice(-recentCount).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let totalTokens = 0;
  if (latestSummary) {
    totalTokens += estimateTokens(latestSummary.summaryMarkdown);
  }
  for (const msg of recentMessages) {
    totalTokens += estimateTokens(msg.content);
  }

  return {
    summary: latestSummary?.summaryMarkdown ?? null,
    recentMessages,
    totalTokens,
  };
}

/**
 * Trigger automatic summarization if needed
 */
export async function autoSummarizeIfNeeded(sessionId: string): Promise<{
  summarized: boolean;
  newSummaryId?: number;
}> {
  const { needed, currentTokens, messageCount } =
    await needsSummarization(sessionId);

  if (!needed) {
    return { summarized: false };
  }

  console.log(
    `[ContextCompactor] Auto-summarizing session ${sessionId}: ${currentTokens} tokens, ${messageCount} messages`
  );

  // Get messages to summarize (all except last N)
  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(asc(schema.chatMessages.createdAt));

  // Get latest summary
  const [latestSummary] = await db
    .select()
    .from(schema.chatSummaries)
    .where(eq(schema.chatSummaries.sessionId, sessionId))
    .orderBy(desc(schema.chatSummaries.createdAt))
    .limit(1);

  const coveredUntilId = latestSummary?.coveredUntilMessageId ?? 0;
  const uncoveredMessages = messages.filter((m) => m.id > coveredUntilId);

  if (uncoveredMessages.length <= CONFIG.RECENT_MESSAGES_KEEP) {
    return { summarized: false };
  }

  // Messages to summarize (all except last N)
  const toSummarize = uncoveredMessages.slice(0, -CONFIG.RECENT_MESSAGES_KEEP);
  const lastMessageId = toSummarize[toSummarize.length - 1]?.id;

  if (!lastMessageId) {
    return { summarized: false };
  }

  // Build summary including previous summary
  const previousSummary = latestSummary?.summaryMarkdown
    ? `前回の要約:\n${latestSummary.summaryMarkdown}\n\n`
    : "";

  const conversationText = toSummarize
    .map((m) => {
      let content = m.content;
      try {
        const parsed = JSON.parse(m.content);
        if (parsed.chunks) {
          content = parsed.chunks
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { content: string }) => c.content || "")
            .join("");
        }
      } catch {
        // Plain text
      }
      return `[${m.role}]: ${content.slice(0, 500)}`;
    })
    .join("\n\n");

  const summaryPrompt = `${previousSummary}以下の会話を要約してください。

要約には以下を含めてください：
1. 完了したタスク
2. 重要な決定事項
3. 技術的な詳細（実装内容、使用技術等）
4. 未解決の問題やTODO

会話:
${conversationText.slice(0, 12000)}

要約（500文字以内）:`;

  let summaryContent = "";
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 800,
      messages: [{ role: "user", content: summaryPrompt }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    summaryContent = textBlock?.text?.trim() || "";
  } catch (err) {
    console.error("[ContextCompactor] Auto-summarization failed:", err);
    summaryContent = `${toSummarize.length}件のメッセージを含む会話セグメント`;
  }

  const now = new Date().toISOString();
  const [newSummary] = await db
    .insert(schema.chatSummaries)
    .values({
      sessionId,
      summaryMarkdown: summaryContent,
      coveredUntilMessageId: lastMessageId,
      createdAt: now,
    })
    .returning();

  console.log(
    `[ContextCompactor] Created summary covering until message ${lastMessageId}`
  );

  return {
    summarized: true,
    ...(newSummary?.id !== undefined && { newSummaryId: newSummary.id }),
  };
}
