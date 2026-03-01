import { describe, test, expect, afterAll, beforeEach, mock } from "bun:test";
import { setupTestDb, clearAllTables, closeDb } from "../helpers/test-db";
import { createTestApp, postJson } from "../helpers/test-app";
import { GIT_FIXTURES } from "../helpers/mock-exec";

// Mock execAsync
const mockExecAsync = mock<(cmd: string, opts?: unknown) => Promise<string>>();

mock.module("../../server/utils", () => ({
  execAsync: mockExecAsync,
  expandTilde: (p: string) => p,
  getRepoId: async () => "owner/repo",
}));

// Mock broadcast
const mockBroadcast = mock<(msg: unknown) => void>(() => {});
mock.module("../../server/ws", () => ({
  broadcast: mockBroadcast,
}));

// Mock existsSync
mock.module("fs", () => ({
  existsSync: () => true,
  readFileSync: () => "{}",
}));

// Setup in-memory DB
const { testDb } = setupTestDb();
const schema = await import("../../db/schema");

mock.module("../../db", () => ({
  db: testDb,
  schema,
}));

// Import router after mocking
const { scanRouter } = await import("../../server/routes/scan");

const app = createTestApp(scanRouter, "/api/scan");

describe("scan router", () => {
  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    mockExecAsync.mockReset();
    mockBroadcast.mockReset();
    clearAllTables();
  });

  describe("GET /api/scan/snapshot/:pinId", () => {
    test("returns cached snapshot from DB", async () => {
      const now = new Date().toISOString();
      const snapshot = {
        repoId: "owner/repo",
        defaultBranch: "main",
        baseBranch: "main",
        branches: ["main", "feature/auth"],
        nodes: [
          { branchName: "main", badges: [], lastCommitAt: now, aheadBehind: { ahead: 0, behind: 0 } },
          { branchName: "feature/auth", badges: [], lastCommitAt: now, aheadBehind: { ahead: 2, behind: 0 } },
        ],
        edges: [{ parent: "main", child: "feature/auth", confidence: "high" }],
        prs: [],
        worktrees: [],
        warnings: [],
      };

      const [pin] = testDb.insert(schema.repoPins).values({
        repoId: "owner/repo",
        localPath: "/repo",
        baseBranch: "main",
        cachedSnapshotJson: JSON.stringify(snapshot),
        cachedSnapshotVersion: 1,
        lastUsedAt: now,
        createdAt: now,
      }).returning().all();

      const res = await app.request(`/api/scan/snapshot/${pin.id}`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.snapshot).toBeDefined();
      expect(data.snapshot.branches).toContain("main");
      expect(data.snapshot.branches).toContain("feature/auth");
      expect(data.version).toBe(1);
    });

    test("overlays planning session edges on cached snapshot", async () => {
      const now = new Date().toISOString();
      const snapshot = {
        repoId: "owner/repo",
        defaultBranch: "main",
        baseBranch: "main",
        branches: ["main", "feature/a", "feature/b"],
        nodes: [],
        edges: [
          { parent: "main", child: "feature/a", confidence: "low" },
          { parent: "main", child: "feature/b", confidence: "low" },
        ],
        prs: [],
        worktrees: [],
        warnings: [],
      };

      const [pin] = testDb.insert(schema.repoPins).values({
        repoId: "owner/repo",
        localPath: "/repo",
        baseBranch: "main",
        cachedSnapshotJson: JSON.stringify(snapshot),
        lastUsedAt: now,
        createdAt: now,
      }).returning().all();

      // Add confirmed planning session with designed edges
      testDb.insert(schema.planningSessions).values({
        id: "session-1",
        repoId: "owner/repo",
        baseBranch: "main",
        status: "confirmed",
        nodesJson: JSON.stringify([
          { id: "task-1", branchName: "feature/a" },
          { id: "task-2", branchName: "feature/b" },
        ]),
        edgesJson: JSON.stringify([
          { parent: "task-1", child: "task-2" },
        ]),
        createdAt: now,
        updatedAt: now,
      }).run();

      const res = await app.request(`/api/scan/snapshot/${pin.id}`);
      expect(res.status).toBe(200);

      const data = await res.json();
      // feature/b should be reparented from main to feature/a
      const edgeB = data.snapshot.edges.find(
        (e: { child: string }) => e.child === "feature/b"
      );
      expect(edgeB.parent).toBe("feature/a");
      expect(edgeB.isDesigned).toBe(true);
    });

    test("returns 400 for invalid pinId", async () => {
      const res = await app.request("/api/scan/snapshot/invalid");
      expect(res.status).toBe(400);
    });

    test("returns 400 when pin not found", async () => {
      const res = await app.request("/api/scan/snapshot/9999");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/scan", () => {
    test("starts background scan and returns immediately", async () => {
      const now = new Date().toISOString();
      testDb.insert(schema.repoPins).values({
        repoId: "owner/repo",
        localPath: "/repo",
        baseBranch: "main",
        lastUsedAt: now,
        createdAt: now,
      }).run();

      mockExecAsync.mockImplementation(async (cmd: string) => {
        // getDefaultBranch
        if (cmd.includes("git symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main\n";
        // getBranches
        if (cmd.includes("git for-each-ref")) {
          return GIT_FIXTURES.branchList;
        }
        // getWorktrees
        if (cmd.includes("git worktree list --porcelain")) {
          return "worktree /repo\nHEAD abc1234\nbranch refs/heads/main\n";
        }
        // git status for worktree dirty check
        if (cmd.includes("git status --porcelain")) return "";
        // getPRs
        if (cmd.includes("gh pr list")) return "[]";
        // calculateAheadBehind / merge-base
        if (cmd.includes("git merge-base")) return "abc1234\n";
        if (cmd.includes("git rev-list --count")) return "0\n";
        // calculateRemoteAheadBehind
        if (cmd.includes("git rev-parse") && cmd.includes("origin/")) {
          throw new Error("no remote tracking");
        }
        if (cmd.includes("git rev-parse")) return "abc1234\n";
        // getRepoId
        if (cmd.includes("gh repo view --json nameWithOwner")) return "owner/repo\n";
        // fetch
        if (cmd.includes("git fetch")) return "";
        // other
        return "";
      });

      const res = await postJson(app, "/api/scan", {
        localPath: "/repo",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      // POST /api/scan returns immediately with { started, repoId }
      expect(data.started).toBe(true);
      expect(data.repoId).toBe("owner/repo");
    });

    test("returns validation error for missing localPath", async () => {
      const res = await postJson(app, "/api/scan", {});
      expect(res.status).toBe(400);
    });
  });
});
