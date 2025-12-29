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
import { errorHandler } from "./middleware/error-handler";
import { handleWsMessage, addClient, removeClient, type WSClient } from "./ws";

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

// 404 handler for API routes
app.notFound((c) => {
  return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

console.log(`Starting Vibe Tree server...`);

Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
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
      addClient(ws as unknown as WSClient);
      console.log("WebSocket client connected");
    },
    message(ws, message) {
      handleWsMessage(ws as unknown as WSClient, message);
    },
    close(ws) {
      removeClient(ws as unknown as WSClient);
      console.log("WebSocket client disconnected");
    },
  },
});

console.log(`Server running at http://localhost:${port}`);
console.log(`WebSocket available at ws://localhost:${port}/ws`);
