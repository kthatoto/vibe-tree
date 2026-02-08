import { z } from "zod";
import {
  getSession,
  getInstruction,
  getTodos,
  getQuestions,
} from "../db/client";

export const getContextSchema = z.object({
  planningSessionId: z.string().describe("The planning session ID"),
  branchName: z
    .string()
    .optional()
    .describe("Specific branch name (defaults to current branch in session)"),
});

export type GetContextInput = z.infer<typeof getContextSchema>;

interface ContextOutput {
  currentBranch: string | null;
  currentIndex: number;
  allBranches: string[];
  instruction: string | null;
  todos: Array<{
    id: number;
    title: string;
    status: string;
    description: string | null;
  }>;
  questions: Array<{
    id: number;
    question: string;
    status: string;
    answer: string | null;
    assumption: string | null;
  }>;
  sessionType: string;
  sessionStatus: string;
}

export function getCurrentContext(input: GetContextInput): ContextOutput {
  const session = getSession(input.planningSessionId);

  if (!session) {
    throw new Error(`Planning session not found: ${input.planningSessionId}`);
  }

  const executeBranches = session.execute_branches_json
    ? (JSON.parse(session.execute_branches_json) as string[])
    : [];
  const currentIndex = session.current_execute_index ?? 0;

  // Determine current branch
  let currentBranch: string | null = null;
  if (input.branchName) {
    currentBranch = input.branchName;
  } else if (executeBranches.length > 0 && currentIndex < executeBranches.length) {
    currentBranch = executeBranches[currentIndex] ?? null;
  }

  // Get instruction for current branch
  let instruction: string | null = null;
  if (currentBranch) {
    const inst = getInstruction(session.repo_id, currentBranch);
    instruction = inst?.instruction_md ?? null;
  }

  // Get todos for current branch
  const todoRows = currentBranch
    ? getTodos(session.repo_id, currentBranch)
    : [];
  const todos = todoRows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    description: t.description,
  }));

  // Get questions (optionally filtered by branch)
  const questionRows = getQuestions(input.planningSessionId, currentBranch ?? undefined);
  const questions = questionRows.map((q) => ({
    id: q.id,
    question: q.question,
    status: q.status,
    answer: q.answer,
    assumption: q.assumption,
  }));

  return {
    currentBranch,
    currentIndex,
    allBranches: executeBranches,
    instruction,
    todos,
    questions,
    sessionType: session.type,
    sessionStatus: session.status,
  };
}
