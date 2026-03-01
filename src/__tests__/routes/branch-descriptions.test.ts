import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { setupTestDb, clearAllTables, closeDb } from "../helpers/test-db";
import { createTestApp, putJson } from "../helpers/test-app";

// Mock execAsync
const mockExecAsync = mock<(cmd: string, opts?: unknown) => Promise<string>>();

mock.module("../../server/utils", () => ({
  execAsync: mockExecAsync,
  expandTilde: (p: string) => p,
  getRepoId: async () => "owner/repo",
}));

// Setup in-memory DB and mock the db module
const { testDb } = setupTestDb();
const schema = await import("../../db/schema");

mock.module("../../db", () => ({
  db: testDb,
  schema,
}));

// Import router after mocking
const { branchDescriptionsRouter } = await import("../../server/routes/branch-descriptions");

const app = createTestApp(branchDescriptionsRouter, "/api/branch-descriptions");

describe("branch-descriptions router", () => {
  beforeAll(() => {
    // Insert a repo pin for getLocalPath lookup
    const now = new Date().toISOString();
    testDb.insert(schema.repoPins).values({
      repoId: "owner/repo",
      localPath: "/repo",
      lastUsedAt: now,
      createdAt: now,
    }).run();
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    mockExecAsync.mockReset();
    // Clear branch descriptions but keep repo pins
    testDb.delete(schema.branchDescriptions).run();
  });

  describe("GET /api/branch-descriptions", () => {
    test("returns description from git config and syncs to DB", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git config branch.feature.description")) {
          return "A feature branch\n";
        }
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await app.request(
        "/api/branch-descriptions?repoId=owner/repo&branchName=feature"
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.description).toBe("A feature branch");
      expect(data.repoId).toBe("owner/repo");
      expect(data.branchName).toBe("feature");
    });

    test("returns null when no git description exists", async () => {
      mockExecAsync.mockImplementation(async () => {
        throw new Error("exit code 1"); // git config returns error for missing keys
      });

      const res = await app.request(
        "/api/branch-descriptions?repoId=owner/repo&branchName=nodesc"
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toBeNull();
    });

    test("returns null when repo pin not found", async () => {
      const res = await app.request(
        "/api/branch-descriptions?repoId=unknown/repo&branchName=feature"
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeNull();
    });

    test("updates existing DB record when git description changes", async () => {
      // Seed DB with old description
      const now = new Date().toISOString();
      testDb.insert(schema.branchDescriptions).values({
        repoId: "owner/repo",
        branchName: "feature",
        description: "Old description",
        createdAt: now,
        updatedAt: now,
      }).run();

      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git config branch.feature.description")) {
          return "New description\n";
        }
        throw new Error(`Unexpected: ${cmd}`);
      });

      const res = await app.request(
        "/api/branch-descriptions?repoId=owner/repo&branchName=feature"
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.description).toBe("New description");
    });
  });

  describe("GET /api/branch-descriptions/batch", () => {
    test("returns descriptions for multiple branches", async () => {
      mockExecAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("branch.feat-a.description")) return "Desc A\n";
        if (cmd.includes("branch.feat-b.description")) return "Desc B\n";
        throw new Error("exit code 1");
      });

      const res = await app.request(
        "/api/branch-descriptions/batch?repoId=owner/repo&branches=feat-a,feat-b,feat-c"
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data["feat-a"]).toBe("Desc A");
      expect(data["feat-b"]).toBe("Desc B");
      expect(data["feat-c"]).toBeUndefined();
    });

    test("returns empty object when no params provided", async () => {
      const res = await app.request("/api/branch-descriptions/batch");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({});
    });
  });

  describe("PUT /api/branch-descriptions", () => {
    test("sets description in git and creates DB record", async () => {
      mockExecAsync.mockImplementation(async () => "");

      const res = await putJson(app, "/api/branch-descriptions", {
        repoId: "owner/repo",
        branchName: "feature",
        description: "New feature description",
      });
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.description).toBe("New feature description");
      expect(data.repoId).toBe("owner/repo");

      // Verify git config was called
      expect(mockExecAsync).toHaveBeenCalled();
      const gitCall = mockExecAsync.mock.calls.find((c) =>
        c[0].includes("git config branch.feature.description")
      );
      expect(gitCall).toBeDefined();
    });

    test("updates existing DB record", async () => {
      const now = new Date().toISOString();
      testDb.insert(schema.branchDescriptions).values({
        repoId: "owner/repo",
        branchName: "update-me",
        description: "Old",
        createdAt: now,
        updatedAt: now,
      }).run();

      mockExecAsync.mockImplementation(async () => "");

      const res = await putJson(app, "/api/branch-descriptions", {
        repoId: "owner/repo",
        branchName: "update-me",
        description: "Updated",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.description).toBe("Updated");
    });

    test("returns validation error for missing fields", async () => {
      const res = await putJson(app, "/api/branch-descriptions", {
        repoId: "owner/repo",
      });
      expect(res.status).toBe(400);
    });
  });
});
