import { z } from "zod";
import { getDb, getSession } from "../db/client";
import { broadcastTaskAdvanced } from "../ws/notifier";

// Get focused branch schema
export const getFocusedBranchSchema = z.object({
  planningSessionId: z.string().describe("Planning session ID"),
});

export type GetFocusedBranchInput = z.infer<typeof getFocusedBranchSchema>;

interface GetFocusedBranchOutput {
  focusedBranch: string | null;
  focusedIndex: number;
  allBranches: string[];
  totalBranches: number;
}

export function getFocusedBranch(input: GetFocusedBranchInput): GetFocusedBranchOutput {
  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Planning session not found: ${input.planningSessionId}`);
  }

  const executeBranches = session.execute_branches_json
    ? (JSON.parse(session.execute_branches_json) as string[])
    : [];
  const currentIndex = session.current_execute_index ?? 0;

  return {
    focusedBranch: executeBranches[currentIndex] ?? null,
    focusedIndex: currentIndex,
    allBranches: executeBranches,
    totalBranches: executeBranches.length,
  };
}

// Set focused branch schema
export const setFocusedBranchSchema = z.object({
  planningSessionId: z.string().describe("Planning session ID"),
  branchName: z.string().describe("Branch name to focus on"),
});

export type SetFocusedBranchInput = z.infer<typeof setFocusedBranchSchema>;

export function setFocusedBranch(input: SetFocusedBranchInput): GetFocusedBranchOutput {
  const result = switchBranch({
    planningSessionId: input.planningSessionId,
    branchName: input.branchName,
  });

  return {
    focusedBranch: result.currentBranch,
    focusedIndex: result.currentIndex,
    allBranches: result.allBranches,
    totalBranches: result.allBranches.length,
  };
}

export const switchBranchSchema = z.object({
  planningSessionId: z.string().describe("Planning session ID"),
  branchName: z
    .string()
    .optional()
    .describe("Specific branch name to switch to"),
  direction: z
    .enum(["next", "previous", "specific"])
    .optional()
    .describe("Direction to switch (if not specifying branchName)"),
});

export const markBranchCompleteSchema = z.object({
  planningSessionId: z.string().describe("Planning session ID"),
  autoAdvance: z
    .boolean()
    .optional()
    .default(true)
    .describe("Automatically advance to next branch"),
});

export type SwitchBranchInput = z.infer<typeof switchBranchSchema>;
export type MarkBranchCompleteInput = z.infer<typeof markBranchCompleteSchema>;

interface SwitchBranchOutput {
  success: boolean;
  currentBranch: string | null;
  currentIndex: number;
  allBranches: string[];
  isComplete: boolean;
}

function toSession(row: {
  id: string;
  repo_id: string;
  title: string;
  type: string;
  base_branch: string;
  status: string;
  nodes_json: string;
  edges_json: string;
  chat_session_id: string | null;
  execute_branches_json: string | null;
  current_execute_index: number;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    repoId: row.repo_id,
    title: row.title,
    type: row.type,
    baseBranch: row.base_branch,
    status: row.status,
    nodes: JSON.parse(row.nodes_json),
    edges: JSON.parse(row.edges_json),
    chatSessionId: row.chat_session_id,
    executeBranches: row.execute_branches_json
      ? JSON.parse(row.execute_branches_json)
      : null,
    currentExecuteIndex: row.current_execute_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function switchBranch(input: SwitchBranchInput): SwitchBranchOutput {
  const db = getDb();
  const now = new Date().toISOString();

  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Planning session not found: ${input.planningSessionId}`);
  }

  const executeBranches = session.execute_branches_json
    ? (JSON.parse(session.execute_branches_json) as string[])
    : [];
  let currentIndex = session.current_execute_index ?? 0;

  if (executeBranches.length === 0) {
    return {
      success: false,
      currentBranch: null,
      currentIndex: 0,
      allBranches: [],
      isComplete: true,
    };
  }

  // Determine new index
  if (input.branchName) {
    const branchIndex = executeBranches.indexOf(input.branchName);
    if (branchIndex === -1) {
      throw new Error(`Branch not found in session: ${input.branchName}`);
    }
    currentIndex = branchIndex;
  } else if (input.direction === "next") {
    currentIndex = Math.min(currentIndex + 1, executeBranches.length - 1);
  } else if (input.direction === "previous") {
    currentIndex = Math.max(currentIndex - 1, 0);
  }

  // Update session
  db.prepare(
    `UPDATE planning_sessions SET current_execute_index = ?, updated_at = ? WHERE id = ?`
  ).run(currentIndex, now, input.planningSessionId);

  const currentBranch = executeBranches[currentIndex] ?? null;
  const isComplete = currentIndex >= executeBranches.length - 1;

  // Broadcast update
  const updated = getSession(input.planningSessionId)!;
  broadcastTaskAdvanced(session.repo_id, {
    ...toSession(updated),
    previousIndex: session.current_execute_index,
    newIndex: currentIndex,
    currentBranch,
  });

  return {
    success: true,
    currentBranch,
    currentIndex,
    allBranches: executeBranches,
    isComplete,
  };
}

export function markBranchComplete(
  input: MarkBranchCompleteInput
): SwitchBranchOutput {
  // For now, marking complete just advances to the next branch
  if (input.autoAdvance) {
    return switchBranch({
      planningSessionId: input.planningSessionId,
      direction: "next",
    });
  }

  // If not auto-advancing, just return current state
  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Planning session not found: ${input.planningSessionId}`);
  }

  const executeBranches = session.execute_branches_json
    ? (JSON.parse(session.execute_branches_json) as string[])
    : [];
  const currentIndex = session.current_execute_index ?? 0;

  return {
    success: true,
    currentBranch: executeBranches[currentIndex] ?? null,
    currentIndex,
    allBranches: executeBranches,
    isComplete: currentIndex >= executeBranches.length - 1,
  };
}
