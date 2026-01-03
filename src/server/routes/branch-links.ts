import { Hono } from "hono";
import { execSync } from "child_process";
import { db, schema } from "../../db";
import { eq, and, desc } from "drizzle-orm";
import { broadcast } from "../ws";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";

export const branchLinksRouter = new Hono();

// Helper: Fetch Issue info from GitHub
interface GitHubIssueInfo {
  number: number;
  title: string;
  status: string;
  labels: string[];
  projectStatus?: string;
}

function fetchGitHubIssueInfo(repoId: string, issueNumber: number): GitHubIssueInfo | null {
  try {
    // Basic issue info
    const result = execSync(
      `gh issue view ${issueNumber} --repo "${repoId}" --json number,title,state,labels,projectItems`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    const data = JSON.parse(result);

    // Extract project status if available
    let projectStatus: string | undefined;
    if (data.projectItems && data.projectItems.length > 0) {
      const item = data.projectItems[0];
      if (item.status) {
        projectStatus = item.status.name || item.status;
      }
    }

    return {
      number: data.number,
      title: data.title,
      status: data.state?.toLowerCase() || "open",
      labels: (data.labels || []).map((l: { name: string }) => l.name),
      projectStatus,
    };
  } catch (err) {
    console.error(`Failed to fetch issue #${issueNumber}:`, err);
    return null;
  }
}

// Helper: Fetch PR info from GitHub
interface GitHubCheck {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

interface GitHubLabel {
  name: string;
  color: string;
}

interface GitHubPRInfo {
  number: number;
  title: string;
  status: string;
  reviewDecision: string | null;
  checksStatus: string;
  checks: GitHubCheck[];
  labels: GitHubLabel[];
  reviewers: string[];
  projectStatus?: string;
}

function fetchGitHubPRInfo(repoId: string, prNumber: number): GitHubPRInfo | null {
  try {
    const result = execSync(
      `gh pr view ${prNumber} --repo "${repoId}" --json number,title,state,reviewDecision,statusCheckRollup,labels,reviewRequests,reviews,projectItems`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    const data = JSON.parse(result);

    // Extract individual checks
    const checks: GitHubCheck[] = [];
    let checksStatus = "pending";
    if (data.statusCheckRollup && data.statusCheckRollup.length > 0) {
      for (const c of data.statusCheckRollup) {
        checks.push({
          name: c.name || c.context || "Unknown",
          status: c.status || "COMPLETED",
          conclusion: c.conclusion || null,
          detailsUrl: c.detailsUrl || c.targetUrl || null,
        });
      }
      const hasFailure = checks.some((c) =>
        c.conclusion === "FAILURE" || c.conclusion === "ERROR"
      );
      const allSuccess = checks.every((c) => c.conclusion === "SUCCESS");
      if (hasFailure) checksStatus = "failure";
      else if (allSuccess) checksStatus = "success";
    }

    // Extract reviewers
    const reviewers: string[] = [];
    if (data.reviewRequests) {
      for (const r of data.reviewRequests) {
        if (r.login) reviewers.push(r.login);
      }
    }
    if (data.reviews) {
      for (const r of data.reviews) {
        if (r.author?.login && !reviewers.includes(r.author.login)) {
          reviewers.push(r.author.login);
        }
      }
    }

    // Extract project status
    let projectStatus: string | undefined;
    if (data.projectItems && data.projectItems.length > 0) {
      const item = data.projectItems[0];
      if (item.status) {
        projectStatus = item.status.name || item.status;
      }
    }

    return {
      number: data.number,
      title: data.title,
      status: data.state?.toLowerCase() || "open",
      reviewDecision: data.reviewDecision || null,
      checksStatus,
      checks,
      labels: (data.labels || []).map((l: { name: string; color: string }) => ({ name: l.name, color: l.color })),
      reviewers,
      projectStatus,
    };
  } catch (err) {
    console.error(`Failed to fetch PR #${prNumber}:`, err);
    return null;
  }
}

// Validation schemas
const getBranchLinksSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
});

const createBranchLinkSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
  linkType: z.enum(["issue", "pr"]),
  url: z.string().url(),
  number: z.number().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
});

const updateBranchLinkSchema = z.object({
  title: z.string().optional(),
  status: z.string().optional(),
});

// GET /api/branch-links?repoId=...&branchName=...
branchLinksRouter.get("/", async (c) => {
  const query = validateOrThrow(getBranchLinksSchema, {
    repoId: c.req.query("repoId"),
    branchName: c.req.query("branchName"),
  });

  const links = await db
    .select()
    .from(schema.branchLinks)
    .where(
      and(
        eq(schema.branchLinks.repoId, query.repoId),
        eq(schema.branchLinks.branchName, query.branchName)
      )
    )
    .orderBy(desc(schema.branchLinks.createdAt));

  return c.json(links);
});

// POST /api/branch-links
branchLinksRouter.post("/", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(createBranchLinkSchema, body);
  const now = new Date().toISOString();

  // Check for duplicate
  const [existing] = await db
    .select()
    .from(schema.branchLinks)
    .where(
      and(
        eq(schema.branchLinks.repoId, input.repoId),
        eq(schema.branchLinks.branchName, input.branchName),
        eq(schema.branchLinks.url, input.url)
      )
    )
    .limit(1);

  if (existing) {
    // Update existing link instead of creating duplicate
    await db
      .update(schema.branchLinks)
      .set({
        title: input.title ?? existing.title,
        status: input.status ?? existing.status,
        updatedAt: now,
      })
      .where(eq(schema.branchLinks.id, existing.id));

    const [updated] = await db
      .select()
      .from(schema.branchLinks)
      .where(eq(schema.branchLinks.id, existing.id));

    broadcast({
      type: "branchLink.updated",
      repoId: input.repoId,
      data: updated,
    });

    return c.json(updated);
  }

  // Fetch info from GitHub if we have a number
  let title = input.title ?? null;
  let status = input.status ?? null;
  let checksStatus: string | null = null;
  let reviewDecision: string | null = null;
  let checks: string | null = null;
  let labels: string | null = null;
  let reviewers: string | null = null;
  let projectStatus: string | null = null;

  if (input.number) {
    if (input.linkType === "issue") {
      const issueInfo = fetchGitHubIssueInfo(input.repoId, input.number);
      if (issueInfo) {
        title = issueInfo.title;
        status = issueInfo.status;
        labels = JSON.stringify(issueInfo.labels);
        projectStatus = issueInfo.projectStatus ?? null;
      }
    } else if (input.linkType === "pr") {
      const prInfo = fetchGitHubPRInfo(input.repoId, input.number);
      if (prInfo) {
        title = prInfo.title;
        status = prInfo.status;
        checksStatus = prInfo.checksStatus;
        reviewDecision = prInfo.reviewDecision;
        checks = JSON.stringify(prInfo.checks);
        labels = JSON.stringify(prInfo.labels);
        reviewers = JSON.stringify(prInfo.reviewers);
        projectStatus = prInfo.projectStatus ?? null;
      }
    }
  }

  const result = await db
    .insert(schema.branchLinks)
    .values({
      repoId: input.repoId,
      branchName: input.branchName,
      linkType: input.linkType,
      url: input.url,
      number: input.number ?? null,
      title,
      status,
      checksStatus,
      reviewDecision,
      checks,
      labels,
      reviewers,
      projectStatus,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const link = result[0];
  if (!link) {
    throw new BadRequestError("Failed to create branch link");
  }

  broadcast({
    type: "branchLink.created",
    repoId: input.repoId,
    data: link,
  });

  return c.json(link, 201);
});

// PATCH /api/branch-links/:id
branchLinksRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const body = await c.req.json();
  const input = validateOrThrow(updateBranchLinkSchema, body);
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(schema.branchLinks)
    .where(eq(schema.branchLinks.id, id))
    .limit(1);

  if (!existing) {
    throw new NotFoundError("Branch link not found");
  }

  await db
    .update(schema.branchLinks)
    .set({
      title: input.title ?? existing.title,
      status: input.status ?? existing.status,
      updatedAt: now,
    })
    .where(eq(schema.branchLinks.id, id));

  const [updated] = await db
    .select()
    .from(schema.branchLinks)
    .where(eq(schema.branchLinks.id, id));

  broadcast({
    type: "branchLink.updated",
    repoId: existing.repoId,
    data: updated,
  });

  return c.json(updated);
});

// DELETE /api/branch-links/:id
branchLinksRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const [existing] = await db
    .select()
    .from(schema.branchLinks)
    .where(eq(schema.branchLinks.id, id))
    .limit(1);

  if (!existing) {
    throw new NotFoundError("Branch link not found");
  }

  await db.delete(schema.branchLinks).where(eq(schema.branchLinks.id, id));

  broadcast({
    type: "branchLink.deleted",
    repoId: existing.repoId,
    data: { id },
  });

  return c.json({ success: true });
});

// POST /api/branch-links/:id/refresh - Re-fetch data from GitHub
branchLinksRouter.post("/:id/refresh", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const [existing] = await db
    .select()
    .from(schema.branchLinks)
    .where(eq(schema.branchLinks.id, id))
    .limit(1);

  if (!existing) {
    throw new NotFoundError("Branch link not found");
  }

  if (!existing.number) {
    throw new BadRequestError("Cannot refresh link without number");
  }

  const now = new Date().toISOString();
  let title = existing.title;
  let status = existing.status;
  let checksStatus = existing.checksStatus;
  let reviewDecision = existing.reviewDecision;
  let checks = existing.checks;
  let labels = existing.labels;
  let reviewers = existing.reviewers;
  let projectStatus = existing.projectStatus;

  if (existing.linkType === "issue") {
    const issueInfo = fetchGitHubIssueInfo(existing.repoId, existing.number);
    if (issueInfo) {
      title = issueInfo.title;
      status = issueInfo.status;
      labels = JSON.stringify(issueInfo.labels);
      projectStatus = issueInfo.projectStatus ?? null;
    }
  } else if (existing.linkType === "pr") {
    const prInfo = fetchGitHubPRInfo(existing.repoId, existing.number);
    if (prInfo) {
      title = prInfo.title;
      status = prInfo.status;
      checksStatus = prInfo.checksStatus;
      reviewDecision = prInfo.reviewDecision;
      checks = JSON.stringify(prInfo.checks);
      labels = JSON.stringify(prInfo.labels);
      reviewers = JSON.stringify(prInfo.reviewers);
      projectStatus = prInfo.projectStatus ?? null;
    }
  }

  await db
    .update(schema.branchLinks)
    .set({
      title,
      status,
      checksStatus,
      reviewDecision,
      checks,
      labels,
      reviewers,
      projectStatus,
      updatedAt: now,
    })
    .where(eq(schema.branchLinks.id, id));

  const [updated] = await db
    .select()
    .from(schema.branchLinks)
    .where(eq(schema.branchLinks.id, id));

  broadcast({
    type: "branchLink.updated",
    repoId: existing.repoId,
    data: updated,
  });

  return c.json(updated);
});
