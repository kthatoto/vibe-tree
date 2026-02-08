import { z } from "zod";
import { getDb, getInstruction } from "../db/client";
import { broadcastInstructionUpdated } from "../ws/notifier";

// Get instruction schema
export const getInstructionSchema = z.object({
  repoId: z.string().describe("Repository ID (owner/repo format)"),
  branchName: z.string().describe("Branch name"),
});

export type GetInstructionInput = z.infer<typeof getInstructionSchema>;

interface GetInstructionOutput {
  found: boolean;
  id: number | null;
  branchName: string;
  instructionMd: string | null;
}

export function getInstructionInfo(
  input: GetInstructionInput
): GetInstructionOutput {
  const existing = getInstruction(input.repoId, input.branchName);

  if (!existing) {
    return {
      found: false,
      id: null,
      branchName: input.branchName,
      instructionMd: null,
    };
  }

  return {
    found: true,
    id: existing.id,
    branchName: existing.branch_name ?? input.branchName,
    instructionMd: existing.instruction_md,
  };
}

export const updateInstructionSchema = z.object({
  repoId: z.string().describe("Repository ID (owner/repo format)"),
  branchName: z.string().describe("Branch name"),
  instructionMd: z.string().describe("New instruction content in Markdown"),
});

export type UpdateInstructionInput = z.infer<typeof updateInstructionSchema>;

interface UpdateInstructionOutput {
  success: boolean;
  id: number;
  branchName: string;
  instructionMd: string;
}

export function updateInstruction(
  input: UpdateInstructionInput
): UpdateInstructionOutput {
  const db = getDb();
  const now = new Date().toISOString();

  // Check if instruction exists
  const existing = getInstruction(input.repoId, input.branchName);

  let result: { id: number };

  if (existing) {
    // Update existing
    db.prepare(
      `UPDATE task_instructions
       SET instruction_md = ?, updated_at = ?
       WHERE id = ?`
    ).run(input.instructionMd, now, existing.id);
    result = { id: existing.id };
  } else {
    // Create new
    const stmt = db.prepare(
      `INSERT INTO task_instructions (repo_id, task_id, branch_name, instruction_md, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const taskId = `branch-${input.branchName}`;
    const info = stmt.run(
      input.repoId,
      taskId,
      input.branchName,
      input.instructionMd,
      now,
      now
    );
    result = { id: info.lastInsertRowid as number };
  }

  // Get updated record
  const updated = db
    .prepare(`SELECT * FROM task_instructions WHERE id = ?`)
    .get(result.id) as {
    id: number;
    repo_id: string;
    task_id: string;
    branch_name: string;
    instruction_md: string;
    created_at: string;
    updated_at: string;
  };

  // Broadcast update
  broadcastInstructionUpdated(input.repoId, {
    id: updated.id,
    repoId: updated.repo_id,
    taskId: updated.task_id,
    branchName: updated.branch_name,
    instructionMd: updated.instruction_md,
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
  });

  return {
    success: true,
    id: updated.id,
    branchName: updated.branch_name,
    instructionMd: updated.instruction_md,
  };
}
