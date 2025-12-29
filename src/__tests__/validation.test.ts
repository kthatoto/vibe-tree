import { describe, test, expect } from "bun:test";
import {
  updateBranchNamingSchema,
  startPlanSchema,
  updatePlanSchema,
  commitPlanSchema,
  scanSchema,
  logInstructionSchema,
  repoIdQuerySchema,
  restartPromptQuerySchema,
  updateTreeSpecSchema,
  validateOrThrow,
  ValidationError,
} from "../shared/validation";

describe("updateBranchNamingSchema", () => {
  test("accepts valid input", () => {
    const result = updateBranchNamingSchema.safeParse({
      repoId: "owner/repo",
      pattern: "vt/{planId}/{taskSlug}",
      description: "Test description",
      examples: ["vt/1/feature"],
    });
    expect(result.success).toBe(true);
  });

  test("uses defaults for optional fields", () => {
    const result = updateBranchNamingSchema.safeParse({
      repoId: "owner/repo",
      pattern: "vt/{planId}/{taskSlug}",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("");
      expect(result.data.examples).toEqual([]);
    }
  });

  test("rejects invalid repoId format", () => {
    const result = updateBranchNamingSchema.safeParse({
      repoId: "invalid",
      pattern: "vt/{planId}/{taskSlug}",
    });
    expect(result.success).toBe(false);
  });

  test("rejects repoId with multiple slashes", () => {
    const result = updateBranchNamingSchema.safeParse({
      repoId: "owner/repo/extra",
      pattern: "vt/{planId}/{taskSlug}",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty pattern", () => {
    const result = updateBranchNamingSchema.safeParse({
      repoId: "owner/repo",
      pattern: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("startPlanSchema", () => {
  test("accepts valid input", () => {
    const result = startPlanSchema.safeParse({
      repoId: "owner/repo",
      title: "My Plan",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty title", () => {
    const result = startPlanSchema.safeParse({
      repoId: "owner/repo",
      title: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects too long title", () => {
    const result = startPlanSchema.safeParse({
      repoId: "owner/repo",
      title: "a".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  test("accepts title at max length", () => {
    const result = startPlanSchema.safeParse({
      repoId: "owner/repo",
      title: "a".repeat(200),
    });
    expect(result.success).toBe(true);
  });
});

describe("updatePlanSchema", () => {
  test("accepts valid input", () => {
    const result = updatePlanSchema.safeParse({
      planId: 1,
      contentMd: "# Plan content",
    });
    expect(result.success).toBe(true);
  });

  test("uses default for missing contentMd", () => {
    const result = updatePlanSchema.safeParse({
      planId: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contentMd).toBe("");
    }
  });

  test("rejects invalid planId", () => {
    const result = updatePlanSchema.safeParse({
      planId: 0,
      contentMd: "content",
    });
    expect(result.success).toBe(false);
  });
});

describe("commitPlanSchema", () => {
  test("accepts valid input with planId and localPath", () => {
    const result = commitPlanSchema.safeParse({
      planId: 1,
      localPath: "/path/to/repo",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid planId", () => {
    const result = commitPlanSchema.safeParse({
      planId: 0,
      localPath: "/path/to/repo",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing planId", () => {
    const result = commitPlanSchema.safeParse({
      localPath: "/path/to/repo",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing localPath", () => {
    const result = commitPlanSchema.safeParse({
      planId: 1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty localPath", () => {
    const result = commitPlanSchema.safeParse({
      planId: 1,
      localPath: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("scanSchema", () => {
  test("accepts valid localPath", () => {
    const result = scanSchema.safeParse({
      localPath: "/path/to/repo",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty localPath", () => {
    const result = scanSchema.safeParse({
      localPath: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing localPath", () => {
    const result = scanSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("logInstructionSchema", () => {
  test("accepts valid user_instruction", () => {
    const result = logInstructionSchema.safeParse({
      repoId: "owner/repo",
      kind: "user_instruction",
      contentMd: "Do something",
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid director_suggestion", () => {
    const result = logInstructionSchema.safeParse({
      repoId: "owner/repo",
      kind: "director_suggestion",
      contentMd: "Suggestion content",
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid system_note", () => {
    const result = logInstructionSchema.safeParse({
      repoId: "owner/repo",
      kind: "system_note",
      contentMd: "System note",
    });
    expect(result.success).toBe(true);
  });

  test("accepts optional fields", () => {
    const result = logInstructionSchema.safeParse({
      repoId: "owner/repo",
      planId: 5,
      worktreePath: "/path/to/worktree",
      branchName: "feature-branch",
      kind: "user_instruction",
      contentMd: "Content",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid kind", () => {
    const result = logInstructionSchema.safeParse({
      repoId: "owner/repo",
      kind: "invalid_kind",
      contentMd: "Content",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty contentMd", () => {
    const result = logInstructionSchema.safeParse({
      repoId: "owner/repo",
      kind: "user_instruction",
      contentMd: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("repoIdQuerySchema", () => {
  test("accepts valid repoId format", () => {
    const result = repoIdQuerySchema.safeParse({ repoId: "owner/repo" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repoId).toBe("owner/repo");
    }
  });

  test("accepts repoId with dashes and underscores", () => {
    const result = repoIdQuerySchema.safeParse({ repoId: "my-org/my_repo-name" });
    expect(result.success).toBe(true);
  });

  test("rejects repoId without slash", () => {
    const result = repoIdQuerySchema.safeParse({ repoId: "invalid" });
    expect(result.success).toBe(false);
  });

  test("rejects empty repoId", () => {
    const result = repoIdQuerySchema.safeParse({ repoId: "" });
    expect(result.success).toBe(false);
  });
});

describe("restartPromptQuerySchema", () => {
  test("accepts minimal input", () => {
    const result = restartPromptQuerySchema.safeParse({
      repoId: "owner/repo",
      localPath: "/path/to/repo",
    });
    expect(result.success).toBe(true);
  });

  test("accepts all optional fields", () => {
    const result = restartPromptQuerySchema.safeParse({
      repoId: "owner/repo",
      localPath: "/path/to/repo",
      planId: "2",
      worktreePath: "/path/to/worktree",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repoId).toBe("owner/repo");
      expect(result.data.planId).toBe(2);
      expect(result.data.worktreePath).toBe("/path/to/worktree");
    }
  });
});

describe("updateTreeSpecSchema", () => {
  test("accepts valid tree spec (task-based)", () => {
    const result = updateTreeSpecSchema.safeParse({
      repoId: "owner/repo",
      baseBranch: "main",
      nodes: [
        { id: "task-1", title: "Setup auth", status: "todo" },
        { id: "task-2", title: "Implement login", status: "doing", branchName: "feature/auth", intendedIssue: 123 },
      ],
      edges: [{ parent: "task-1", child: "task-2" }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty nodes and edges", () => {
    const result = updateTreeSpecSchema.safeParse({
      repoId: "owner/repo",
      nodes: [],
      edges: [],
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid repoId", () => {
    const result = updateTreeSpecSchema.safeParse({
      repoId: "invalid",
      nodes: [],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing id in nodes", () => {
    const result = updateTreeSpecSchema.safeParse({
      repoId: "owner/repo",
      nodes: [{ title: "Test", status: "todo" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing title in nodes", () => {
    const result = updateTreeSpecSchema.safeParse({
      repoId: "owner/repo",
      nodes: [{ id: "task-1", status: "todo" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("validateOrThrow", () => {
  test("returns data on success", () => {
    const result = validateOrThrow(repoIdQuerySchema, { repoId: "owner/repo" });
    expect(result.repoId).toBe("owner/repo");
  });

  test("throws ValidationError on failure", () => {
    expect(() => {
      validateOrThrow(repoIdQuerySchema, { repoId: "" });
    }).toThrow(ValidationError);
  });

  test("ValidationError has correct message", () => {
    try {
      validateOrThrow(repoIdQuerySchema, {});
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain("repoId");
    }
  });
});
