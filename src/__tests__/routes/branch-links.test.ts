import { describe, test, expect, afterAll, beforeEach, mock } from "bun:test";
import { setupTestDb, clearAllTables, closeDb } from "../helpers/test-db";
import { createTestApp, postJson, patchJson } from "../helpers/test-app";

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

// Setup in-memory DB
const { testDb } = setupTestDb();
const schema = await import("../../db/schema");

mock.module("../../db", () => ({
  db: testDb,
  schema,
}));

// Import router after mocking
const { branchLinksRouter } = await import("../../server/routes/branch-links");

const app = createTestApp(branchLinksRouter, "/api/branch-links");

describe("branch-links router", () => {
  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    mockExecAsync.mockReset();
    mockBroadcast.mockReset();
    clearAllTables();
  });

  describe("GET /api/branch-links", () => {
    test("returns links for a branch", async () => {
      const now = new Date().toISOString();
      testDb.insert(schema.branchLinks).values({
        repoId: "owner/repo",
        branchName: "feature/auth",
        linkType: "pr",
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        title: "Add auth",
        status: "open",
        createdAt: now,
        updatedAt: now,
      }).run();

      const res = await app.request(
        "/api/branch-links?repoId=owner/repo&branchName=feature/auth"
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toBeArray();
      expect(data).toHaveLength(1);
      expect(data[0].number).toBe(1);
      expect(data[0].linkType).toBe("pr");
    });

    test("returns empty array when no links exist", async () => {
      const res = await app.request(
        "/api/branch-links?repoId=owner/repo&branchName=no-links"
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual([]);
    });
  });

  describe("POST /api/branch-links", () => {
    test("creates a PR link with GitHub info auto-fetch", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("gh pr view")) {
          return JSON.stringify({
            number: 5,
            title: "New feature PR",
            state: "OPEN",
            reviewDecision: "",
            statusCheckRollup: [],
            labels: [{ name: "feature", color: "0e8a16" }],
            reviewRequests: [],
            reviews: [],
            projectItems: [],
            baseRefName: "main",
          });
        }
        if (cmd.includes("gh api repos/")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch-links", {
        repoId: "owner/repo",
        branchName: "feature/new",
        linkType: "pr",
        url: "https://github.com/owner/repo/pull/5",
        number: 5,
      });
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.number).toBe(5);
      expect(data.title).toBe("New feature PR");
      expect(data.linkType).toBe("pr");
    });

    test("creates an issue link with GitHub info auto-fetch", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("gh issue view")) {
          return JSON.stringify({
            number: 42,
            title: "Bug report",
            state: "open",
            labels: [{ name: "bug", color: "d73a4a" }],
            projectItems: [],
          });
        }
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, "/api/branch-links", {
        repoId: "owner/repo",
        branchName: "fix/bug",
        linkType: "issue",
        url: "https://github.com/owner/repo/issues/42",
        number: 42,
      });
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.number).toBe(42);
      expect(data.title).toBe("Bug report");
    });

    test("returns validation error for invalid URL", async () => {
      const res = await postJson(app, "/api/branch-links", {
        repoId: "owner/repo",
        branchName: "feature",
        linkType: "pr",
        url: "not-a-url",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/branch-links/:id/labels/add", () => {
    test("adds label to PR via gh API", async () => {
      const now = new Date().toISOString();
      const [link] = testDb.insert(schema.branchLinks).values({
        repoId: "owner/repo",
        branchName: "feature/auth",
        linkType: "pr",
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        title: "Add auth",
        status: "open",
        labels: JSON.stringify([{ name: "existing", color: "888888" }]),
        createdAt: now,
        updatedAt: now,
      }).returning().all();

      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("labels")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, `/api/branch-links/${link.id}/labels/add`, {
        labelName: "enhancement",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      const labelNames = data.labels.map((l: { name: string }) => l.name);
      expect(labelNames).toContain("enhancement");
      expect(labelNames).toContain("existing");
    });
  });

  describe("POST /api/branch-links/:id/labels/remove", () => {
    test("removes label from PR via gh API", async () => {
      const now = new Date().toISOString();
      const [link] = testDb.insert(schema.branchLinks).values({
        repoId: "owner/repo",
        branchName: "feature/auth",
        linkType: "pr",
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        title: "Add auth",
        status: "open",
        labels: JSON.stringify([
          { name: "bug", color: "d73a4a" },
          { name: "enhancement", color: "a2eeef" },
        ]),
        createdAt: now,
        updatedAt: now,
      }).returning().all();

      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("DELETE")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, `/api/branch-links/${link.id}/labels/remove`, {
        labelName: "bug",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      const labelNames = data.labels.map((l: { name: string }) => l.name);
      expect(labelNames).not.toContain("bug");
      expect(labelNames).toContain("enhancement");
    });
  });

  describe("POST /api/branch-links/:id/reviewers/add", () => {
    test("adds reviewer to PR via gh API", async () => {
      const now = new Date().toISOString();
      const [link] = testDb.insert(schema.branchLinks).values({
        repoId: "owner/repo",
        branchName: "feature/auth",
        linkType: "pr",
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        title: "Add auth",
        status: "open",
        reviewers: JSON.stringify([]),
        createdAt: now,
        updatedAt: now,
      }).returning().all();

      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("requested_reviewers")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await postJson(app, `/api/branch-links/${link.id}/reviewers/add`, {
        reviewer: "alice",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.reviewers).toContain("alice");
    });
  });

  describe("PATCH /api/branch-links/:id/base-branch", () => {
    test("changes PR base branch via gh CLI", async () => {
      const now = new Date().toISOString();
      const [link] = testDb.insert(schema.branchLinks).values({
        repoId: "owner/repo",
        branchName: "feature/auth",
        linkType: "pr",
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        title: "Add auth",
        status: "open",
        baseBranch: "main",
        createdAt: now,
        updatedAt: now,
      }).returning().all();

      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("gh pr edit") && cmd.includes("--base")) return "";
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await patchJson(app, `/api/branch-links/${link.id}/base-branch`, {
        baseBranch: "develop",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.baseBranch).toBe("develop");
    });
  });
});
