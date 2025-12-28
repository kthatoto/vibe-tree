import { z } from "zod";

// Repo ID format: owner/name (e.g., "kthatoto/vibe-tree")
const repoIdSchema = z.string().min(1).regex(/^[^/]+\/[^/]+$/, "Invalid repo ID format (expected owner/name)");

// Branch naming schemas
export const branchNamingRuleSchema = z.object({
  pattern: z.string().min(1, "Pattern is required"),
  description: z.string().default(""),
  examples: z.array(z.string()).default([]),
});

export const updateBranchNamingSchema = z.object({
  repoId: repoIdSchema,
  pattern: z.string().min(1, "Pattern is required"),
  description: z.string().default(""),
  examples: z.array(z.string()).default([]),
});

export type UpdateBranchNamingInput = z.infer<typeof updateBranchNamingSchema>;

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
  repoId: repoIdSchema,
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

// Tree spec schemas
export const treeSpecNodeSchema = z.object({
  branchName: z.string().min(1),
  intendedIssue: z.number().int().positive().optional(),
  intendedPr: z.number().int().positive().optional(),
  description: z.string().optional(),
});

export const treeSpecEdgeSchema = z.object({
  parent: z.string().min(1),
  child: z.string().min(1),
});

export const updateTreeSpecSchema = z.object({
  repoId: repoIdSchema,
  nodes: z.array(treeSpecNodeSchema),
  edges: z.array(treeSpecEdgeSchema),
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
