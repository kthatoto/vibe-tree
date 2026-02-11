import { z } from "zod";
import { getDb, getSession, PlanningSessionRow } from "../db/client";
import { broadcastRefinementTasksUpdated } from "../ws/notifier";
import { randomUUID } from "crypto";

// Types
interface TaskNode {
  id: string;
  title: string;
  description?: string;
  branchName?: string;
  issueUrl?: string;
}

interface TaskEdge {
  parent: string;
  child: string;
}

// Helper to generate serial edges from nodes array
function generateSerialEdges(nodes: TaskNode[]): TaskEdge[] {
  const edges: TaskEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const current = nodes[i];
    const next = nodes[i + 1];
    if (current && next) {
      edges.push({
        parent: current.id,
        child: next.id,
      });
    }
  }
  return edges;
}

// Helper to update session in DB
function updateSessionNodes(
  sessionId: string,
  nodes: TaskNode[],
  edges: TaskEdge[]
): PlanningSessionRow {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE planning_sessions
     SET nodes_json = ?, edges_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(nodes), JSON.stringify(edges), now, sessionId);

  const updated = getSession(sessionId);
  if (!updated) {
    throw new Error(`Session not found after update: ${sessionId}`);
  }
  return updated;
}

// ============================================================
// get_refinement_tasks
// ============================================================
export const getRefinementTasksSchema = z.object({
  planningSessionId: z.string().min(1).describe("Planning session ID"),
});

export type GetRefinementTasksInput = z.infer<typeof getRefinementTasksSchema>;

interface RefinementTask {
  id: string;
  title: string;
  description: string | null;
  branchName: string | null;
  issueUrl: string | null;
  order: number;
}

interface GetRefinementTasksOutput {
  planningSessionId: string;
  status: string;
  tasks: RefinementTask[];
}

export function getRefinementTasks(
  input: GetRefinementTasksInput
): GetRefinementTasksOutput {
  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Session not found: ${input.planningSessionId}`);
  }

  const nodes = JSON.parse(session.nodes_json) as TaskNode[];

  return {
    planningSessionId: session.id,
    status: session.status,
    tasks: nodes.map((node, index) => ({
      id: node.id,
      title: node.title,
      description: node.description || null,
      branchName: node.branchName || null,
      issueUrl: node.issueUrl || null,
      order: index,
    })),
  };
}

// ============================================================
// add_refinement_task
// ============================================================
export const addRefinementTaskSchema = z.object({
  planningSessionId: z.string().min(1).describe("Planning session ID"),
  title: z.string().min(1).describe("Task title"),
  description: z.string().optional().describe("Task description"),
  branchName: z.string().optional().describe("Branch name (auto-generated if omitted)"),
  issueUrl: z.string().optional().describe("GitHub issue URL to link"),
});

export type AddRefinementTaskInput = z.infer<typeof addRefinementTaskSchema>;

interface AddRefinementTaskOutput {
  task: RefinementTask;
  totalTasks: number;
}

export function addRefinementTask(
  input: AddRefinementTaskInput
): AddRefinementTaskOutput {
  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Session not found: ${input.planningSessionId}`);
  }

  if (session.status !== "draft") {
    throw new Error(`Cannot modify non-draft session (status: ${session.status})`);
  }

  const nodes = JSON.parse(session.nodes_json) as TaskNode[];

  // Create new task (only include optional fields if they have values)
  const newTask: TaskNode = {
    id: randomUUID(),
    title: input.title,
  };
  if (input.description) newTask.description = input.description;
  if (input.branchName) newTask.branchName = input.branchName;
  if (input.issueUrl) newTask.issueUrl = input.issueUrl;

  // Add to end of array
  nodes.push(newTask);

  // Generate serial edges
  const edges = generateSerialEdges(nodes);

  // Update DB
  updateSessionNodes(input.planningSessionId, nodes, edges);

  // Broadcast update
  broadcastRefinementTasksUpdated(session.repo_id, input.planningSessionId, nodes, edges);

  return {
    task: {
      id: newTask.id,
      title: newTask.title,
      description: newTask.description || null,
      branchName: newTask.branchName || null,
      issueUrl: newTask.issueUrl || null,
      order: nodes.length - 1,
    },
    totalTasks: nodes.length,
  };
}

// ============================================================
// update_refinement_task
// ============================================================
export const updateRefinementTaskSchema = z.object({
  planningSessionId: z.string().min(1).describe("Planning session ID"),
  taskId: z.string().min(1).describe("Task ID to update"),
  title: z.string().optional().describe("New task title"),
  description: z.string().optional().describe("New task description"),
  branchName: z.string().optional().describe("New branch name"),
  issueUrl: z.string().optional().describe("New GitHub issue URL"),
});

export type UpdateRefinementTaskInput = z.infer<typeof updateRefinementTaskSchema>;

interface UpdateRefinementTaskOutput {
  task: RefinementTask;
}

export function updateRefinementTask(
  input: UpdateRefinementTaskInput
): UpdateRefinementTaskOutput {
  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Session not found: ${input.planningSessionId}`);
  }

  if (session.status !== "draft") {
    throw new Error(`Cannot modify non-draft session (status: ${session.status})`);
  }

  const nodes = JSON.parse(session.nodes_json) as TaskNode[];
  const taskIndex = nodes.findIndex((n) => n.id === input.taskId);
  const task = nodes[taskIndex];

  if (taskIndex === -1 || !task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  // Update fields
  if (input.title !== undefined) task.title = input.title;
  if (input.description !== undefined) task.description = input.description;
  if (input.branchName !== undefined) task.branchName = input.branchName;
  if (input.issueUrl !== undefined) task.issueUrl = input.issueUrl;

  // Edges don't change for update (order unchanged)
  const edges = JSON.parse(session.edges_json) as TaskEdge[];

  // Update DB
  updateSessionNodes(input.planningSessionId, nodes, edges);

  // Broadcast update
  broadcastRefinementTasksUpdated(session.repo_id, input.planningSessionId, nodes, edges);

  return {
    task: {
      id: task.id,
      title: task.title,
      description: task.description || null,
      branchName: task.branchName || null,
      issueUrl: task.issueUrl || null,
      order: taskIndex,
    },
  };
}

// ============================================================
// delete_refinement_task
// ============================================================
export const deleteRefinementTaskSchema = z.object({
  planningSessionId: z.string().min(1).describe("Planning session ID"),
  taskId: z.string().min(1).describe("Task ID to delete"),
});

export type DeleteRefinementTaskInput = z.infer<typeof deleteRefinementTaskSchema>;

interface DeleteRefinementTaskOutput {
  success: boolean;
  remainingTasks: number;
}

export function deleteRefinementTask(
  input: DeleteRefinementTaskInput
): DeleteRefinementTaskOutput {
  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Session not found: ${input.planningSessionId}`);
  }

  if (session.status !== "draft") {
    throw new Error(`Cannot modify non-draft session (status: ${session.status})`);
  }

  const nodes = JSON.parse(session.nodes_json) as TaskNode[];
  const taskIndex = nodes.findIndex((n) => n.id === input.taskId);

  if (taskIndex === -1) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  // Remove task
  nodes.splice(taskIndex, 1);

  // Regenerate serial edges
  const edges = generateSerialEdges(nodes);

  // Update DB
  updateSessionNodes(input.planningSessionId, nodes, edges);

  // Broadcast update
  broadcastRefinementTasksUpdated(session.repo_id, input.planningSessionId, nodes, edges);

  return {
    success: true,
    remainingTasks: nodes.length,
  };
}

// ============================================================
// reorder_refinement_tasks
// ============================================================
export const reorderRefinementTasksSchema = z.object({
  planningSessionId: z.string().min(1).describe("Planning session ID"),
  taskIds: z.array(z.string()).min(1).describe("Task IDs in new order"),
});

export type ReorderRefinementTasksInput = z.infer<typeof reorderRefinementTasksSchema>;

interface ReorderRefinementTasksOutput {
  tasks: RefinementTask[];
}

export function reorderRefinementTasks(
  input: ReorderRefinementTasksInput
): ReorderRefinementTasksOutput {
  const session = getSession(input.planningSessionId);
  if (!session) {
    throw new Error(`Session not found: ${input.planningSessionId}`);
  }

  if (session.status !== "draft") {
    throw new Error(`Cannot modify non-draft session (status: ${session.status})`);
  }

  const nodes = JSON.parse(session.nodes_json) as TaskNode[];

  // Validate all task IDs exist
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const taskId of input.taskIds) {
    if (!nodeMap.has(taskId)) {
      throw new Error(`Task not found: ${taskId}`);
    }
  }

  // Check all existing tasks are in the new order
  if (input.taskIds.length !== nodes.length) {
    throw new Error(
      `Task count mismatch: expected ${nodes.length}, got ${input.taskIds.length}`
    );
  }

  // Reorder nodes
  const reorderedNodes = input.taskIds.map((id) => nodeMap.get(id)!);

  // Regenerate serial edges
  const edges = generateSerialEdges(reorderedNodes);

  // Update DB
  updateSessionNodes(input.planningSessionId, reorderedNodes, edges);

  // Broadcast update
  broadcastRefinementTasksUpdated(session.repo_id, input.planningSessionId, reorderedNodes, edges);

  return {
    tasks: reorderedNodes.map((node, index) => ({
      id: node.id,
      title: node.title,
      description: node.description || null,
      branchName: node.branchName || null,
      issueUrl: node.issueUrl || null,
      order: index,
    })),
  };
}
