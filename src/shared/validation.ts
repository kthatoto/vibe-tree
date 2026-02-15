import { z } from "zod";

// Repo ID format: owner/name (e.g., "kthatoto/vibe-tree")
const repoIdSchema = z.string().min(1).regex(/^[^/]+\/[^/]+$/, "Invalid repo ID format (expected owner/name)");

// Branch naming schemas
export const branchNamingRuleSchema = z.object({
  patterns: z.array(z.string()),
});

export const updateBranchNamingSchema = z.object({
  repoId: repoIdSchema,
  patterns: z.array(z.string()),
});

export type UpdateBranchNamingInput = z.infer<typeof updateBranchNamingSchema>;

// Worktree settings schemas
export const worktreeSettingsSchema = z.object({
  createScript: z.string().optional(),
  postCreateScript: z.string().optional(),
  postDeleteScript: z.string().optional(),
  checkoutPreference: z.enum(["main", "first", "ask"]).optional(),
});

// Polling settings schemas
export const pollingSettingsSchema = z.object({
  prFetchCount: z.number().int().min(1).max(20).default(5),
});

export const updatePollingSettingsSchema = z.object({
  repoId: repoIdSchema,
  prFetchCount: z.number().int().min(1).max(20),
});

export type UpdatePollingSettingsInput = z.infer<typeof updatePollingSettingsSchema>;

export const updateWorktreeSettingsSchema = z.object({
  repoId: repoIdSchema,
  createScript: z.string().optional(),
  postCreateScript: z.string().optional(),
  postDeleteScript: z.string().optional(),
  checkoutPreference: z.enum(["main", "first", "ask"]).optional(),
});

export type UpdateWorktreeSettingsInput = z.infer<typeof updateWorktreeSettingsSchema>;

// Plan schemas
export const startPlanSchema = z.object({
  repoId: repoIdSchema,
  title: z.string().min(1, "Title is required").max(200, "Title too long"),
});

export type StartPlanInput = z.infer<typeof startPlanSchema>;

export const updatePlanSchema = z.object({
  planId: z.number().int().positive("Valid planId is required"),
  contentMd: z.string().default(""),
});

export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const commitPlanSchema = z.object({
  planId: z.number().int().positive("Valid planId is required"),
  localPath: z.string().min(1, "Local path is required"),
});

export type CommitPlanInput = z.infer<typeof commitPlanSchema>;

// Scan schemas
export const scanSchema = z.object({
  localPath: z.string().min(1, "Local path is required"),
});

export type ScanInput = z.infer<typeof scanSchema>;

// Instructions schemas
export const instructionKindSchema = z.enum([
  "director_suggestion",
  "user_instruction",
  "system_note",
]);

export const logInstructionSchema = z.object({
  repoId: repoIdSchema,
  planId: z.number().int().positive().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  kind: instructionKindSchema,
  contentMd: z.string().min(1, "Content is required"),
});

export type LogInstructionInput = z.infer<typeof logInstructionSchema>;

// Tree spec schemas (Task-based)
export const taskStatusSchema = z.enum(["todo", "doing", "done"]);

export const treeSpecNodeSchema = z.object({
  id: z.string().min(1), // UUID for task identification
  title: z.string().min(1), // タスク名
  description: z.string().optional(), // 完了条件/メモ
  status: taskStatusSchema.default("todo"),
  branchName: z.string().optional(), // 未確定ならundefined
  worktreePath: z.string().optional(), // Path to worktree
  chatSessionId: z.string().optional(), // Linked chat session ID
  prUrl: z.string().optional(), // PR URL (created by batch generation)
  prNumber: z.number().int().positive().optional(), // PR number
});

export const treeSpecEdgeSchema = z.object({
  parent: z.string().min(1), // node id
  child: z.string().min(1), // node id
});

export const updateTreeSpecSchema = z.object({
  repoId: repoIdSchema,
  baseBranch: z.string().optional(), // default branch (develop, main, master, etc.)
  nodes: z.array(treeSpecNodeSchema),
  edges: z.array(treeSpecEdgeSchema),
  siblingOrder: z.record(z.string(), z.array(z.string())).optional(), // parent branchName -> ordered child branchNames
});

export type UpdateTreeSpecInput = z.infer<typeof updateTreeSpecSchema>;

// Query param schemas
export const repoIdQuerySchema = z.object({
  repoId: repoIdSchema,
});

export const restartPromptQuerySchema = z.object({
  repoId: repoIdSchema,
  localPath: z.string().min(1),
  planId: z.coerce.number().int().positive().optional(),
  worktreePath: z.string().optional(),
});

// Repo pin schemas
export const createRepoPinSchema = z.object({
  localPath: z.string().min(1, "Local path is required"),
  label: z.string().optional(),
});

export type CreateRepoPinInput = z.infer<typeof createRepoPinSchema>;

export const useRepoPinSchema = z.object({
  id: z.number().int().positive("Valid id is required"),
});

export type UseRepoPinInput = z.infer<typeof useRepoPinSchema>;

// Branch schemas
export const createBranchSchema = z.object({
  localPath: z.string().min(1, "Local path is required"),
  branchName: z.string().min(1, "Branch name is required"),
  baseBranch: z.string().min(1, "Base branch is required"),
});

export type CreateBranchInput = z.infer<typeof createBranchSchema>;

// Batch worktree creation schema
export const createTreeTaskSchema = z.object({
  id: z.string().min(1, "Task ID is required"),
  branchName: z.string().min(1, "Branch name is required"),
  parentBranch: z.string().min(1, "Parent branch is required"),
  worktreeName: z.string().min(1, "Worktree name is required"),
  title: z.string().optional(), // For PR title
  description: z.string().optional(), // For PR body
});

export const createTreeSchema = z.object({
  repoId: repoIdSchema,
  localPath: z.string().min(1, "Local path is required"),
  tasks: z.array(createTreeTaskSchema).min(1, "At least one task is required"),
  createPrs: z.boolean().default(false), // Whether to create PRs
  baseBranch: z.string().optional(), // Base branch for root PRs
});

export type CreateTreeInput = z.infer<typeof createTreeSchema>;
export type CreateTreeTaskInput = z.infer<typeof createTreeTaskSchema>;

// AI agent schemas
export const aiStartSchema = z.object({
  localPath: z.string().min(1, "Local path is required"),
  planId: z.number().int().positive().optional(),
  branch: z.string().optional(),
});

export type AiStartInput = z.infer<typeof aiStartSchema>;

export const aiStopSchema = z.object({
  pid: z.number().int().positive("Valid pid is required"),
});

export type AiStopInput = z.infer<typeof aiStopSchema>;

// Chat schemas
export const createChatSessionSchema = z.object({
  repoId: repoIdSchema,
  worktreePath: z.string().min(1, "Worktree path is required"),
  branchName: z.string().min(1, "Branch name is required"),
  planId: z.number().int().positive().optional(),
});

export type CreateChatSessionInput = z.infer<typeof createChatSessionSchema>;

// Planning session schema (no worktreePath required)
export const createPlanningSessionSchema = z.object({
  repoId: repoIdSchema,
  localPath: z.string().min(1, "Local path is required"),
});

export type CreatePlanningSessionInput = z.infer<typeof createPlanningSessionSchema>;

export const archiveChatSessionSchema = z.object({
  sessionId: z.string().uuid("Valid session ID is required"),
});

export type ArchiveChatSessionInput = z.infer<typeof archiveChatSessionSchema>;

export const chatModeSchema = z.enum(["planning", "execution"]);

export const chatSendSchema = z.object({
  sessionId: z.string().uuid("Valid session ID is required"),
  userMessage: z.string().min(1, "Message is required"),
  context: z.string().optional(),
  chatMode: chatModeSchema.optional(),
  quickMode: z.boolean().optional(),
});

export type ChatSendInput = z.infer<typeof chatSendSchema>;

export const chatSummarizeSchema = z.object({
  sessionId: z.string().uuid("Valid session ID is required"),
});

export type ChatSummarizeInput = z.infer<typeof chatSummarizeSchema>;

export const chatPurgeSchema = z.object({
  sessionId: z.string().uuid("Valid session ID is required"),
  keepLastN: z.number().int().min(0).default(50),
});

export type ChatPurgeInput = z.infer<typeof chatPurgeSchema>;

// Validation helper
export function validateOrThrow<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues;
    const errors = issues
      .map((issue) => {
        const path = issue.path.map(String).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join(", ");
    throw new ValidationError(errors || "Validation failed");
  }
  return result.data;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
