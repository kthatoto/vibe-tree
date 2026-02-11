import { Hono } from "hono";
import { NotFoundError } from "../middleware/error-handler";
import { execAsync } from "../utils";

interface GhRepo {
  name: string;
  nameWithOwner: string;
  url: string;
  description: string;
  isPrivate: boolean;
  defaultBranchRef: { name: string } | null;
}

interface RepoInfo {
  id: string;
  name: string;
  fullName: string;
  url: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
}

export const reposRouter = new Hono();

// GET /api/repos - List repos from GitHub
reposRouter.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "30");

  try {
    const output = await execAsync(
      `gh repo list --json name,nameWithOwner,url,description,isPrivate,defaultBranchRef --limit ${limit}`
    );

    const ghRepos: GhRepo[] = JSON.parse(output);

    const repos: RepoInfo[] = ghRepos.map((r) => ({
      id: r.nameWithOwner,
      name: r.name,
      fullName: r.nameWithOwner,
      url: r.url,
      description: r.description ?? "",
      isPrivate: r.isPrivate,
      defaultBranch: r.defaultBranchRef?.name ?? "main",
    }));

    return c.json(repos);
  } catch (error) {
    console.error("Failed to fetch repos from gh:", error);
    return c.json([]);
  }
});

// GET /api/repos/:owner/:name - Get single repo info
reposRouter.get("/:owner/:name", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const fullName = `${owner}/${name}`;

  try {
    const output = await execAsync(
      `gh repo view ${fullName} --json name,nameWithOwner,url,description,isPrivate,defaultBranchRef`
    );

    const r: GhRepo = JSON.parse(output);

    const repo: RepoInfo = {
      id: r.nameWithOwner,
      name: r.name,
      fullName: r.nameWithOwner,
      url: r.url,
      description: r.description ?? "",
      isPrivate: r.isPrivate,
      defaultBranch: r.defaultBranchRef?.name ?? "main",
    };

    return c.json(repo);
  } catch {
    throw new NotFoundError("Repo");
  }
});
