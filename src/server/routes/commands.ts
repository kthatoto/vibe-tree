import { Hono } from "hono";
import { spawn } from "child_process";
import { expandTilde, execAsync } from "../utils";
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

// GET /api/commands/workflows?repoId=... - List available workflows
commandsRouter.get("/workflows", async (c) => {
  const repoId = c.req.query("repoId");
  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  try {
    const output = await execAsync(
      `gh workflow list --repo "${repoId}" --json name,id,state --all`
    );
    const workflows = JSON.parse(output.trim() || "[]") as Array<{
      name: string;
      id: number;
      state: string;
    }>;
    return c.json({ workflows });
  } catch (err) {
    console.error("Failed to fetch workflows:", err);
    return c.json({ workflows: [] });
  }
});

// GET /api/commands/actions?repoId=...&workflows=a,b - Get recent GitHub Actions runs
commandsRouter.get("/actions", async (c) => {
  const repoId = c.req.query("repoId");
  const workflowFilter = c.req.query("workflows"); // comma-separated workflow names
  if (!repoId) {
    return c.json({ error: "repoId is required" }, 400);
  }

  try {
    // Fetch runs for each monitored workflow (or all if no filter)
    const filterNames = workflowFilter ? workflowFilter.split(",").map((s) => s.trim()).filter(Boolean) : [];

    let allRuns: Array<{
      databaseId: number;
      name: string;
      status: string;
      conclusion: string | null;
      event: string;
      headBranch: string;
      createdAt: string;
      updatedAt: string;
      actor: { login: string };
      url: string;
      workflowName: string;
    }> = [];

    if (filterNames.length > 0) {
      // Fetch per-workflow for better results
      const results = await Promise.all(
        filterNames.map(async (wf) => {
          try {
            const output = await execAsync(
              `gh run list --repo "${repoId}" --workflow "${wf}" --limit 10 --json databaseId,name,status,conclusion,event,headBranch,createdAt,updatedAt,actor,url,workflowName`
            );
            return JSON.parse(output.trim() || "[]");
          } catch {
            return [];
          }
        })
      );
      allRuns = results.flat();
    } else {
      const output = await execAsync(
        `gh run list --repo "${repoId}" --limit 20 --json databaseId,name,status,conclusion,event,headBranch,createdAt,updatedAt,actor,url,workflowName`
      );
      allRuns = JSON.parse(output.trim() || "[]");
    }

    // Sort by createdAt descending
    allRuns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({
      runs: allRuns.slice(0, 20).map((r) => ({
        id: r.databaseId,
        name: r.name,
        workflow: r.workflowName,
        status: r.status,
        conclusion: r.conclusion,
        event: r.event,
        branch: r.headBranch,
        actor: r.actor?.login ?? "unknown",
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        url: r.url,
      })),
    });
  } catch (err) {
    console.error("Failed to fetch Actions runs:", err);
    return c.json({ runs: [] });
  }
});
