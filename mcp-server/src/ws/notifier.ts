// WebSocket notification via HTTP to vibe-tree server
// MCP server runs as STDIO, so we can't directly access WebSocket clients
// Instead, we POST to an internal endpoint that broadcasts to clients

const API_BASE = process.env.VIBE_TREE_API || "http://localhost:3000";

interface BroadcastMessage {
  type: string;
  repoId?: string;
  planningSessionId?: string;
  data?: unknown;
}

export async function broadcast(message: BroadcastMessage): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/internal/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      // Log to stderr (allowed in MCP server)
      console.error(
        `[MCP] Broadcast failed: ${response.status} ${response.statusText}`
      );
    }
  } catch (error) {
    // Best effort - don't throw if broadcast fails
    console.error(`[MCP] Broadcast error:`, error);
  }
}

// Convenience functions for common broadcasts
export function broadcastTodoCreated(repoId: string, todo: unknown) {
  return broadcast({ type: "todo.created", repoId, data: todo });
}

export function broadcastTodoUpdated(repoId: string, todo: unknown) {
  return broadcast({ type: "todo.updated", repoId, data: todo });
}

export function broadcastTodoDeleted(repoId: string, data: { id: number; branchName: string }) {
  return broadcast({ type: "todo.deleted", repoId, data });
}

export function broadcastQuestionCreated(repoId: string, question: unknown) {
  return broadcast({ type: "question.created", repoId, data: question });
}

export function broadcastQuestionUpdated(repoId: string, question: unknown) {
  return broadcast({ type: "question.updated", repoId, data: question });
}

export function broadcastQuestionDeleted(repoId: string, data: { id: number; planningSessionId: string }) {
  return broadcast({ type: "question.deleted", repoId, data });
}

export function broadcastInstructionUpdated(repoId: string, instruction: unknown) {
  return broadcast({ type: "taskInstruction.updated", repoId, data: instruction });
}

export function broadcastSessionUpdated(repoId: string, session: unknown) {
  return broadcast({ type: "planning.updated", repoId, data: session });
}

export function broadcastTaskAdvanced(repoId: string, data: unknown) {
  return broadcast({ type: "planning.taskAdvanced", repoId, data });
}
