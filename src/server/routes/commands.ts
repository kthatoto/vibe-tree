import { Hono } from "hono";
import { spawn } from "child_process";
import { expandTilde } from "../utils";
import { broadcast } from "../ws";

export const commandsRouter = new Hono();

// POST /api/commands/run - Run a custom command
commandsRouter.post("/run", async (c) => {
  const body = await c.req.json();
  const { localPath: rawLocalPath, repoId, command, label } = body as {
    localPath: string;
    repoId: string;
    command: string;
    label: string;
  };

  if (!rawLocalPath || !command) {
    return c.json({ error: "localPath and command are required" }, 400);
  }

  const localPath = expandTilde(rawLocalPath);

  // Run the command asynchronously
  const startedAt = new Date().toISOString();

  // Broadcast start
  broadcast({
    type: "command.started",
    repoId,
    data: { label, command, startedAt },
  });

  // Run in background and broadcast result
  const child = spawn("sh", ["-c", command], {
    cwd: localPath,
    env: { ...process.env },
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr?.on("data", (data) => {
    stderr += data.toString();
  });

  child.on("close", (exitCode) => {
    const completedAt = new Date().toISOString();
    broadcast({
      type: "command.completed",
      repoId,
      data: {
        label,
        command,
        exitCode,
        stdout: stdout.slice(-2000), // Last 2000 chars
        stderr: stderr.slice(-2000),
        startedAt,
        completedAt,
      },
    });
  });

  return c.json({ success: true, label, command });
});
