import { mock } from "bun:test";
import type { Mock } from "bun:test";

export interface CommandRoute {
  pattern: RegExp;
  response: string | ((cmd: string) => string);
  error?: boolean;
}

export function createMockExecAsync(routes: CommandRoute[]): Mock<(cmd: string, opts?: unknown) => Promise<string>> {
  return mock(async (cmd: string) => {
    for (const route of routes) {
      if (route.pattern.test(cmd)) {
        const result = typeof route.response === "function" ? route.response(cmd) : route.response;
        if (route.error) {
          throw new Error(result);
        }
        return result;
      }
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
}

// Common git fixtures
export const GIT_FIXTURES = {
  branchList: `main|abc1234|2024-01-01 00:00:00 +0000
feature/auth|def5678|2024-01-02 00:00:00 +0000
feature/ui|ghi9012|2024-01-03 00:00:00 +0000`,

  worktreeListPorcelain: `worktree /repo
HEAD abc1234
branch refs/heads/main

worktree /repo-worktrees/feature-auth
HEAD def5678
branch refs/heads/feature/auth
`,

  statusClean: "",
  statusDirty: " M src/index.ts\n?? new-file.ts",

  defaultBranchRef: "refs/remotes/origin/main",

  currentBranchMain: "main",
  currentBranchFeature: "feature/auth",

  branchListEmpty: "",

  revParseMainExists: "abc1234def5678",

  lsRemoteEmpty: "",
  lsRemoteHasRef: "abc1234def5678\trefs/heads/feature/auth",

  logEmpty: "",
  logOneCommit: "abc1234 Initial commit",

  fetchSuccess: "",
  pushSuccess: "Everything up-to-date",

  rebaseSuccess: "Successfully rebased and updated refs/heads/feature/auth.",
  rebaseConflict: "CONFLICT (content): Merge conflict in src/index.ts\nerror: could not apply abc1234... commit message",
};

// Common gh CLI fixtures
export const GH_FIXTURES = {
  repoList: JSON.stringify([
    {
      name: "vibe-tree",
      nameWithOwner: "owner/vibe-tree",
      url: "https://github.com/owner/vibe-tree",
      description: "A test repo",
      isPrivate: false,
      defaultBranchRef: { name: "main" },
    },
    {
      name: "other-repo",
      nameWithOwner: "owner/other-repo",
      url: "https://github.com/owner/other-repo",
      description: "Another repo",
      isPrivate: true,
      defaultBranchRef: { name: "develop" },
    },
  ]),

  repoView: JSON.stringify({
    name: "vibe-tree",
    nameWithOwner: "owner/vibe-tree",
    url: "https://github.com/owner/vibe-tree",
    description: "A test repo",
    isPrivate: false,
    defaultBranchRef: { name: "main" },
  }),

  prListJson: JSON.stringify([
    {
      number: 1,
      title: "Add auth",
      state: "OPEN",
      url: "https://github.com/owner/repo/pull/1",
      headRefName: "feature/auth",
      isDraft: false,
      labels: [{ name: "enhancement", color: "a2eeef" }],
      assignees: [],
      reviewDecision: "",
      reviewRequests: [],
      reviews: [],
      statusCheckRollup: [],
      additions: 50,
      deletions: 10,
      changedFiles: 3,
    },
  ]),

  issueViewJson: JSON.stringify({
    number: 42,
    title: "Fix login bug",
    state: "open",
    labels: [{ name: "bug", color: "d73a4a" }],
    projectItems: [],
  }),

  prViewJson: JSON.stringify({
    number: 1,
    title: "Add auth",
    state: "OPEN",
    reviewDecision: "",
    statusCheckRollup: [
      { name: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci.example.com" },
    ],
    labels: [{ name: "enhancement", color: "a2eeef" }],
    reviewRequests: [],
    reviews: [],
    projectItems: [],
    baseRefName: "main",
  }),

  repoViewNameWithOwner: "owner/vibe-tree",
};
