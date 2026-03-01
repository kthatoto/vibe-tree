import { describe, test, expect, beforeEach, mock } from "bun:test";
import { GH_FIXTURES } from "../helpers/mock-exec";
import { createTestApp } from "../helpers/test-app";

// Mock execAsync before importing the router
const mockExecAsync = mock<(cmd: string, opts?: unknown) => Promise<string>>();

mock.module("../../server/utils", () => ({
  execAsync: mockExecAsync,
  expandTilde: (p: string) => p,
  getRepoId: async () => "owner/vibe-tree",
}));

// Import router after mocking
const { reposRouter } = await import("../../server/routes/repos");

const app = createTestApp(reposRouter, "/api/repos");

describe("repos router", () => {
  beforeEach(() => {
    mockExecAsync.mockReset();
  });

  describe("GET /api/repos", () => {
    test("returns repos list from gh CLI", async () => {
      mockExecAsync.mockResolvedValueOnce(GH_FIXTURES.repoList);

      const res = await app.request("/api/repos");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveLength(2);
      expect(data[0].fullName).toBe("owner/vibe-tree");
      expect(data[0].defaultBranch).toBe("main");
      expect(data[1].fullName).toBe("owner/other-repo");
      expect(data[1].isPrivate).toBe(true);
    });

    test("returns empty array on gh error", async () => {
      mockExecAsync.mockRejectedValueOnce(new Error("gh: command not found"));

      const res = await app.request("/api/repos");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual([]);
    });

    test("passes limit query param to gh command", async () => {
      mockExecAsync.mockResolvedValueOnce("[]");

      await app.request("/api/repos?limit=10");

      expect(mockExecAsync).toHaveBeenCalledTimes(1);
      const calledCmd = mockExecAsync.mock.calls[0][0];
      expect(calledCmd).toContain("--limit 10");
    });

    test("uses default limit of 30", async () => {
      mockExecAsync.mockResolvedValueOnce("[]");

      await app.request("/api/repos");

      const calledCmd = mockExecAsync.mock.calls[0][0];
      expect(calledCmd).toContain("--limit 30");
    });

    test("handles null defaultBranchRef gracefully", async () => {
      mockExecAsync.mockResolvedValueOnce(JSON.stringify([
        {
          name: "no-default",
          nameWithOwner: "owner/no-default",
          url: "https://github.com/owner/no-default",
          description: null,
          isPrivate: false,
          defaultBranchRef: null,
        },
      ]));

      const res = await app.request("/api/repos");
      const data = await res.json();

      expect(data[0].defaultBranch).toBe("main");
      expect(data[0].description).toBe("");
    });
  });

  describe("GET /api/repos/:owner/:name", () => {
    test("returns single repo info", async () => {
      mockExecAsync.mockResolvedValueOnce(GH_FIXTURES.repoView);

      const res = await app.request("/api/repos/owner/vibe-tree");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.fullName).toBe("owner/vibe-tree");
      expect(data.name).toBe("vibe-tree");
      expect(data.defaultBranch).toBe("main");
    });

    test("returns 404 for non-existent repo", async () => {
      mockExecAsync.mockRejectedValueOnce(new Error("Could not resolve to a Repository"));

      const res = await app.request("/api/repos/owner/nonexistent");
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data.code).toBe("NOT_FOUND");
    });

    test("calls gh repo view with correct repo name", async () => {
      mockExecAsync.mockResolvedValueOnce(GH_FIXTURES.repoView);

      await app.request("/api/repos/owner/vibe-tree");

      const calledCmd = mockExecAsync.mock.calls[0][0];
      expect(calledCmd).toContain("gh repo view owner/vibe-tree");
    });
  });
});
