import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { setupTestDb, clearAllTables, closeDb } from "../helpers/test-db";
import { createTestApp, postJson } from "../helpers/test-app";

// Mock execAsync
const mockExecAsync = mock<(cmd: string, opts?: unknown) => Promise<string>>();

// Mock existsSync
const mockExistsSync = mock<(path: string) => boolean>(() => true);

// Mock exec (child_process) - fire-and-forget
const mockExec = mock<(cmd: string, opts: unknown, cb: Function) => void>(
  (_cmd, _opts, cb) => { if (cb) cb(null, "", ""); }
);

mock.module("../../server/utils", () => ({
  execAsync: mockExecAsync,
  expandTilde: (p: string) => p,
  getRepoId: async () => "owner/repo",
}));

mock.module("fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: () => {},
  readFileSync: () => "{}",
}));

mock.module("child_process", () => ({
  exec: mockExec,
}));

// Setup in-memory DB
const { testDb } = setupTestDb();
const schema = await import("../../db/schema");

mock.module("../../db", () => ({
  db: testDb,
  schema,
}));

// Mock git utility functions
mock.module("../../utils/git", () => ({
  getWorktreePath: async () => null,
  removeWorktree: async () => true,
  branchExists: async () => false,
  worktreeExists: async () => false,
  getDefaultBranch: async () => "main",
}));

// Import router after mocking
const { branchRouter } = await import("../../server/routes/branch");

const app = createTestApp(branchRouter, "/api/branch");

describe("branch router", () => {
  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    mockExecAsync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockImplementation(() => true);
    mockExec.mockReset();
    mockExec.mockImplementation((_cmd, _opts, cb) => { if (cb) cb(null, "", ""); });
    clearAllTables();
  });

  describe("POST /api/branch/create", () => {
    test("creates a new branch successfully", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return ""; // doesn't exist
        if (cmd.includes("git branch \"feature/new\"")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/create", {
        localPath: "/repo",
        branchName: "feature/new",
        baseBranch: "main",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.branchName).toBe("feature/new");
      expect(data.baseBranch).toBe("main");
    });

    test("returns error when branch already exists", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return "  feature/existing\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/create", {
        localPath: "/repo",
        branchName: "feature/existing",
        baseBranch: "main",
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain("already exists");
    });

    test("returns error for invalid branch name", async () => {
      const res = await postJson(app, "/api/branch/create", {
        localPath: "/repo",
        branchName: "invalid branch name!",
        baseBranch: "main",
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain("Invalid branch name");
    });

    test("returns error when local path does not exist", async () => {
      mockExistsSync.mockImplementation(() => false);

      const res = await postJson(app, "/api/branch/create", {
        localPath: "/nonexistent",
        branchName: "feature/new",
        baseBranch: "main",
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain("does not exist");
    });
  });

  describe("POST /api/branch/push", () => {
    test("pushes branch successfully", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "feature/auth\n";
        if (cmd.includes("git push")) return "Everything up-to-date\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/push", {
        localPath: "/repo",
        branchName: "feature/auth",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.branchName).toBe("feature/auth");
    });

    test("pushes with force-with-lease when force is true", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "feature/auth\n";
        if (cmd.includes("git push")) {
          expect(cmd).toContain("--force-with-lease");
          return "Forced update\n";
        }
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/push", {
        localPath: "/repo",
        branchName: "feature/auth",
        force: true,
      });
      expect(res.status).toBe(200);
    });

    test("returns error when push is rejected", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "feature/auth\n";
        if (cmd.includes("git push")) throw new Error("rejected non-fast-forward");
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/push", {
        localPath: "/repo",
        branchName: "feature/auth",
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain("rejected");
    });

    test("uses worktree path when provided", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git push") && cmd.includes("/worktree")) return "ok\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/push", {
        localPath: "/repo",
        branchName: "feature/auth",
        worktreePath: "/worktree",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/branch/rebase", () => {
    test("rebases branch successfully", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "feature/auth\n";
        if (cmd.includes("git status --porcelain")) return "";
        if (cmd.includes("git fetch origin")) return "";
        if (cmd.includes('git rev-parse "origin/main"')) return "abc123\n";
        if (cmd.includes("git rebase")) return "Successfully rebased\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/rebase", {
        localPath: "/repo",
        branchName: "feature/auth",
        parentBranch: "main",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test("aborts and returns error on conflict", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "feature/auth\n";
        if (cmd.includes("git status --porcelain")) return "";
        if (cmd.includes("git fetch origin")) return "";
        if (cmd.includes('git rev-parse "origin/main"')) return "abc123\n";
        if (cmd.includes("git rebase") && !cmd.includes("--abort")) {
          throw new Error("CONFLICT (content): Merge conflict");
        }
        if (cmd.includes("git rebase --abort")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/rebase", {
        localPath: "/repo",
        branchName: "feature/auth",
        parentBranch: "main",
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain("conflict");
    });

    test("returns error when uncommitted changes exist", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "feature/auth\n";
        if (cmd.includes("git status --porcelain")) return " M src/index.ts\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/rebase", {
        localPath: "/repo",
        branchName: "feature/auth",
        parentBranch: "main",
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain("uncommitted changes");
    });

    test("returns error when required params are missing", async () => {
      const res = await postJson(app, "/api/branch/rebase", {
        localPath: "/repo",
        branchName: "feature/auth",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/branch/check-deletable", () => {
    test("returns deletable true for branch with no commits", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return "  feature/empty\n";
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "main\n";
        if (cmd.includes("git ls-remote --heads")) return "";
        if (cmd.includes("git rev-parse --verify main")) return "abc123\n";
        if (cmd.includes("git log")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/check-deletable", {
        localPath: "/repo",
        branchName: "feature/empty",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.deletable).toBe(true);
    });

    test("returns not deletable when branch has commits", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return "  feature/work\n";
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "main\n";
        if (cmd.includes("git ls-remote --heads")) return "";
        if (cmd.includes("git rev-parse --verify main")) return "abc123\n";
        if (cmd.includes("git log")) return "abc1234 Some commit\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/check-deletable", {
        localPath: "/repo",
        branchName: "feature/work",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.deletable).toBe(false);
      expect(data.reason).toBe("has_commits");
    });

    test("returns not deletable when currently checked out", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return "  feature/current\n";
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "feature/current\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/check-deletable", {
        localPath: "/repo",
        branchName: "feature/current",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.deletable).toBe(false);
      expect(data.reason).toBe("currently_checked_out");
    });

    test("returns not deletable when pushed to remote", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return "  feature/pushed\n";
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "main\n";
        if (cmd.includes("git ls-remote --heads")) return "abc123\trefs/heads/feature/pushed\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/check-deletable", {
        localPath: "/repo",
        branchName: "feature/pushed",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.deletable).toBe(false);
      expect(data.reason).toBe("pushed_to_remote");
    });

    test("returns not deletable when branch not found", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/check-deletable", {
        localPath: "/repo",
        branchName: "nonexistent",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.deletable).toBe(false);
      expect(data.reason).toBe("branch_not_found");
    });
  });

  describe("POST /api/branch/delete", () => {
    test("deletes branch and returns reparented edges", async () => {
      // Seed treeSpec with edges
      const now = new Date().toISOString();
      testDb.insert(schema.repoPins).values({
        repoId: "owner/repo",
        localPath: "/repo",
        lastUsedAt: now,
        createdAt: now,
      }).run();
      testDb.insert(schema.treeSpecs).values({
        repoId: "owner/repo",
        baseBranch: "main",
        specJson: JSON.stringify({
          nodes: [],
          edges: [
            { parent: "main", child: "feature/parent" },
            { parent: "feature/parent", child: "feature/child" },
          ],
        }),
        createdAt: now,
        updatedAt: now,
      }).run();

      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return "  feature/parent\n";
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "main\n";
        if (cmd.includes("git worktree list")) return "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n";
        if (cmd.includes("git branch -d")) return "";
        if (cmd.includes("git push origin --delete")) return "";
        if (cmd.includes("gh repo view")) return "owner/repo\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/delete", {
        localPath: "/repo",
        branchName: "feature/parent",
        force: false,
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.reparentedEdges).toBeArray();
      expect(data.reparentedEdges).toContainEqual({
        child: "feature/child",
        newParent: "main",
      });
    });

    test("returns error when currently checked out", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git branch --list")) return "  feature/current\n";
        if (cmd.includes("git rev-parse --abbrev-ref HEAD")) return "feature/current\n";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch/delete", {
        localPath: "/repo",
        branchName: "feature/current",
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain("currently checked out");
    });

    test("returns error when required params missing", async () => {
      const res = await postJson(app, "/api/branch/delete", {
        localPath: "/repo",
      });
      expect(res.status).toBe(400);
    });
  });
});
