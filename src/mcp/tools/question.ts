import { z } from "zod";
import { getDb, getSession, getQuestions } from "../db/client";
import { broadcastQuestionCreated } from "../ws/notifier";

export const addQuestionSchema = z.object({
  planningSessionId: z.string().describe("Planning session ID"),
  branchName: z
    .string()
    .optional()
    .describe("Branch name this question relates to"),
  question: z.string().describe("The question text"),
  assumption: z
    .string()
    .optional()
    .describe("What we are assuming if no answer is provided"),
});

export type AddQuestionInput = z.infer<typeof addQuestionSchema>;

interface QuestionOutput {
  id: number;
  planningSessionId: string;
  branchName: string | null;
  question: string;
  assumption: string | null;
  status: string;
  answer: string | null;
  orderIndex: number;
}

// Get question by ID helper
function getQuestionById(id: number) {
  const db = getDb();
  return db.prepare(`SELECT * FROM planning_questions WHERE id = ?`).get(id) as
    | {
        id: number;
        planning_session_id: string;
        branch_name: string | null;
        question: string;
        assumption: string | null;
        status: string;
        answer: string | null;
        order_index: number;
        created_at: string;
        updated_at: string;
      }
    | undefined;
}

function toQuestionOutput(
  row: ReturnType<typeof getQuestionById>
): QuestionOutput {
  if (!row) throw new Error("Question not found");
  return {
    id: row.id,
    planningSessionId: row.planning_session_id,
    branchName: row.branch_name,
    question: row.question,
    assumption: row.assumption,
    status: row.status,
    answer: row.answer,
    orderIndex: row.order_index,
  };
}

export function addQuestion(input: AddQuestionInput): QuestionOutput {
  const db = getDb();
  const now = new Date().toISOString();

  // Verify session exists and get repoId
  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Planning session not found: ${input.planningSessionId}`);
  }

  // Get max orderIndex for this session
  const existingQuestions = getQuestions(input.planningSessionId);
  const maxOrderIndex =
    existingQuestions.length > 0
      ? Math.max(...existingQuestions.map((q) => q.order_index)) + 1
      : 0;

  const stmt = db.prepare(
    `INSERT INTO planning_questions (planning_session_id, branch_name, question, assumption, status, order_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const info = stmt.run(
    input.planningSessionId,
    input.branchName ?? null,
    input.question,
    input.assumption ?? null,
    "pending",
    maxOrderIndex,
    now,
    now
  );

  const created = getQuestionById(info.lastInsertRowid as number);
  const output = toQuestionOutput(created);

  broadcastQuestionCreated(session.repo_id, {
    ...output,
    createdAt: now,
    updatedAt: now,
  });

  return output;
}
