import { z } from "zod";
import { getDb, getSession, getQuestions } from "../db/client";
import { broadcastQuestionCreated, broadcastQuestionUpdated } from "../ws/notifier";

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
  acknowledged: boolean;
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
        acknowledged: number;
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
    acknowledged: Boolean(row.acknowledged),
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

// Schema for acknowledging an answered question
export const acknowledgeAnswerSchema = z.object({
  questionId: z.number().describe("ID of the question to acknowledge"),
});

export type AcknowledgeAnswerInput = z.infer<typeof acknowledgeAnswerSchema>;

export function acknowledgeAnswer(input: AcknowledgeAnswerInput): QuestionOutput {
  const db = getDb();
  const now = new Date().toISOString();

  // Get the question
  const question = getQuestionById(input.questionId);
  if (!question) {
    throw new Error(`Question not found: ${input.questionId}`);
  }

  // Verify it's answered
  if (question.status !== "answered") {
    throw new Error(`Question is not answered yet. Current status: ${question.status}`);
  }

  // Get session for repoId
  const session = getSession(question.planning_session_id);
  if (!session) {
    throw new Error(`Planning session not found: ${question.planning_session_id}`);
  }

  // Update the question
  db.prepare(
    `UPDATE planning_questions SET acknowledged = 1, updated_at = ? WHERE id = ?`
  ).run(now, input.questionId);

  const updated = getQuestionById(input.questionId);
  const output = toQuestionOutput(updated);

  broadcastQuestionUpdated(session.repo_id, {
    ...output,
    createdAt: question.created_at,
    updatedAt: now,
  });

  return output;
}

// Schema for getting unanswered questions that need acknowledgment
export const getPendingAnswersSchema = z.object({
  planningSessionId: z.string().describe("Planning session ID"),
  branchName: z.string().optional().describe("Filter by branch name"),
});

export type GetPendingAnswersInput = z.infer<typeof getPendingAnswersSchema>;

interface PendingAnswersOutput {
  questions: QuestionOutput[];
  count: number;
}

export function getPendingAnswers(input: GetPendingAnswersInput): PendingAnswersOutput {
  const db = getDb();

  let query = `SELECT * FROM planning_questions
    WHERE planning_session_id = ?
    AND status = 'answered'
    AND acknowledged = 0`;
  const params: (string | number)[] = [input.planningSessionId];

  if (input.branchName) {
    query += ` AND branch_name = ?`;
    params.push(input.branchName);
  }

  query += ` ORDER BY order_index ASC`;

  const rows = db.prepare(query).all(...params) as ReturnType<typeof getQuestionById>[];
  const questions = rows.map((row) => toQuestionOutput(row));

  return {
    questions,
    count: questions.length,
  };
}
