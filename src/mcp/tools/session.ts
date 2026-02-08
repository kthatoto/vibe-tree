import { z } from "zod";
import { getDb, getSession } from "../db/client";
import { broadcastSessionUpdated } from "../ws/notifier";

// Get session schema
export const getSessionSchema = z.object({
  planningSessionId: z.string().describe("The planning session ID"),
});

export type GetSessionInput = z.infer<typeof getSessionSchema>;

interface SessionOutput {
  id: string;
  repoId: string;
  title: string;
  type: string;
  baseBranch: string;
  status: string;
  currentExecuteIndex: number;
  executeBranches: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export function getSessionInfo(input: GetSessionInput): SessionOutput {
  const session = getSession(input.planningSessionId);

  if (!session) {
    throw new Error(`Planning session not found: ${input.planningSessionId}`);
  }

  return {
    id: session.id,
    repoId: session.repo_id,
    title: session.title,
    type: session.type,
    baseBranch: session.base_branch,
    status: session.status,
    currentExecuteIndex: session.current_execute_index,
    executeBranches: session.execute_branches_json
      ? JSON.parse(session.execute_branches_json)
      : null,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}

// Update session title schema
export const updateSessionTitleSchema = z.object({
  planningSessionId: z.string().describe("The planning session ID"),
  title: z.string().describe("New session title"),
});

export type UpdateSessionTitleInput = z.infer<typeof updateSessionTitleSchema>;

interface UpdateSessionTitleOutput {
  success: boolean;
  title: string;
}

export function updateSessionTitle(
  input: UpdateSessionTitleInput
): UpdateSessionTitleOutput {
  const db = getDb();
  const now = new Date().toISOString();

  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Planning session not found: ${input.planningSessionId}`);
  }

  db.prepare(
    `UPDATE planning_sessions SET title = ?, updated_at = ? WHERE id = ?`
  ).run(input.title, now, input.planningSessionId);

  // Broadcast update
  const updated = getSession(input.planningSessionId)!;
  broadcastSessionUpdated(session.repo_id, {
    id: updated.id,
    repoId: updated.repo_id,
    title: updated.title,
    type: updated.type,
    baseBranch: updated.base_branch,
    status: updated.status,
    currentExecuteIndex: updated.current_execute_index,
    executeBranches: updated.execute_branches_json
      ? JSON.parse(updated.execute_branches_json)
      : null,
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
  });

  return {
    success: true,
    title: input.title,
  };
}
