import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { reposRouter } from "./routes/repos";
import { projectRulesRouter } from "./routes/project-rules";
import { planRouter } from "./routes/plan";
import { scanRouter } from "./routes/scan";
import { instructionsRouter } from "./routes/instructions";
import { treeSpecRouter } from "./routes/tree-spec";
import { repoPinsRouter } from "./routes/repo-pins";
import { aiRouter } from "./routes/ai";
import { chatRouter } from "./routes/chat";
import { branchRouter } from "./routes/branch";
import { termRouter } from "./routes/term";
import { requirementsRouter } from "./routes/requirements";
import { externalLinksRouter } from "./routes/external-links";
import { planningSessionsRouter } from "./routes/planning-sessions";
import { branchLinksRouter } from "./routes/branch-links";
import { todosRouter } from "./routes/todos";
import { questionsRouter } from "./routes/questions";
import { errorHandler } from "./middleware/error-handler";
import { ptyManager } from "./pty-manager";
import { handleWsMessage, addClient, removeClient, broadcast, type WSClient } from "./ws";

const app = new Hono();

// Logging
app.use("*", logger());

// Debug: Log all incoming requests
app.use("*", async (c, next) => {
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}`);
  await next();
});

// Error handling
app.use("*", errorHandler);

// CORS for frontend
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true,
  })
);

// Health check
app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// Mount routers
app.route("/api/repos", reposRouter);
app.route("/api/project-rules", projectRulesRouter);
app.route("/api/plan", planRouter);
app.route("/api/scan", scanRouter);
app.route("/api/instructions", instructionsRouter);
app.route("/api/tree-spec", treeSpecRouter);
app.route("/api/repo-pins", repoPinsRouter);
app.route("/api/ai", aiRouter);
app.route("/api/chat", chatRouter);
app.route("/api/branch", branchRouter);
app.route("/api/term", termRouter);
app.route("/api/requirements", requirementsRouter);
app.route("/api/external-links", externalLinksRouter);
app.route("/api/planning-sessions", planningSessionsRouter);
app.route("/api/branch-links", branchLinksRouter);
app.route("/api/todos", todosRouter);
app.route("/api/questions", questionsRouter);

// Internal broadcast endpoint for MCP server
app.post("/api/internal/broadcast", async (c) => {
  try {
    const body = await c.req.json();
    const { type, repoId, planningSessionId, data } = body;

    if (!type) {
      return c.json({ error: "type is required" }, 400);
    }

    broadcast({
      type,
      repoId,
      planningSessionId,
      data,
    });

    return c.json({ success: true });
  } catch (error) {
    console.error("[Internal broadcast] Error:", error);
    return c.json({ error: "Failed to broadcast" }, 500);
  }
});

// 404 handler for API routes
app.notFound((c) => {
  return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

console.log(`Starting Vibe Tree server...`);

// WebSocket data type
type WsData = { type: "main" } | { type: "term"; sessionId: string };

// Terminal WebSocket clients map
const terminalClients = new Map<WebSocket, { sessionId: string; unsubscribe: () => void }>();

Bun.serve<WsData>({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade for main ws
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: { type: "main" } });
      if (upgraded) {
        return undefined;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Handle WebSocket upgrade for terminal
    if (url.pathname === "/ws/term") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return new Response("sessionId required", { status: 400 });
      }
      const upgraded = server.upgrade(req, { data: { type: "term", sessionId } });
      if (upgraded) {
        return undefined;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Handle HTTP requests with Hono
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      if (ws.data.type === "term") {
        const sessionId = ws.data.sessionId;
        console.log(`Terminal WebSocket connected for session: ${sessionId}`);

        // Subscribe to PTY output
        const unsubscribe = ptyManager.onData(sessionId, (output) => {
          try {
            ws.send(JSON.stringify({ type: "data", data: output }));
          } catch {
            // Client disconnected
          }
        });

        // Subscribe to PTY exit
        const unsubscribeExit = ptyManager.onExit(sessionId, (code) => {
          try {
            ws.send(JSON.stringify({ type: "exit", code }));
          } catch {
            // Client disconnected
          }
        });

        terminalClients.set(ws as unknown as WebSocket, {
          sessionId,
          unsubscribe: () => {
            unsubscribe();
            unsubscribeExit();
          },
        });

        // Send current buffer if any
        const buffer = ptyManager.getOutputBuffer(sessionId);
        if (buffer) {
          ws.send(JSON.stringify({ type: "data", data: buffer }));
        }
      } else {
        addClient(ws as unknown as WSClient);
        console.log("WebSocket client connected");
      }
    },
    message(ws, message) {
      if (ws.data.type === "term") {
        const sessionId = ws.data.sessionId;
        try {
          const msg = JSON.parse(message.toString());
          if (msg.type === "input") {
            ptyManager.write(sessionId, msg.data);
          } else if (msg.type === "resize") {
            ptyManager.resize(sessionId, msg.cols, msg.rows);
          }
        } catch {
          // Invalid message
        }
      } else {
        handleWsMessage(ws as unknown as WSClient, message);
      }
    },
    close(ws) {
      if (ws.data.type === "term") {
        const client = terminalClients.get(ws as unknown as WebSocket);
        if (client) {
          client.unsubscribe();
          terminalClients.delete(ws as unknown as WebSocket);
        }
        console.log(`Terminal WebSocket disconnected for session: ${ws.data.sessionId}`);
      } else {
        removeClient(ws as unknown as WSClient);
        console.log("WebSocket client disconnected");
      }
    },
  },
});

console.log(`Server running at http://localhost:${port}`);
console.log(`WebSocket available at ws://localhost:${port}/ws`);
