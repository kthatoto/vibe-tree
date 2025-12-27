import { Hono } from "hono";
import { cors } from "hono/cors";
import { reposRouter } from "./routes/repos";
import { projectRulesRouter } from "./routes/project-rules";
import { planRouter } from "./routes/plan";
import { scanRouter } from "./routes/scan";
import { instructionsRouter } from "./routes/instructions";
import { handleWsMessage, addClient, removeClient, type WSClient } from "./ws";

const app = new Hono();

// CORS for frontend
app.use(
  "/api/*",
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Mount routers
app.route("/api/repos", reposRouter);
app.route("/api/project-rules", projectRulesRouter);
app.route("/api/plan", planRouter);
app.route("/api/scan", scanRouter);
app.route("/api/instructions", instructionsRouter);

const port = 3000;
console.log(`Starting Vibe Tree server on http://localhost:${port}`);

Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { repoId: undefined },
      });
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
