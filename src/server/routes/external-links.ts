import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { execSync } from "child_process";
import { db } from "../../db";
import { externalLinks } from "../../db/schema";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";
import { broadcast } from "../ws";

export const externalLinksRouter = new Hono();

// Link type detection
function detectLinkType(url: string): string {
  if (url.includes("notion.so") || url.includes("notion.site")) {
    return "notion";
  }
  if (url.includes("figma.com")) {
    return "figma";
  }
  if (url.includes("github.com") && url.includes("/issues/")) {
    return "github_issue";
  }
  if (url.includes("github.com") && url.includes("/pull/")) {
    return "github_pr";
  }
  return "url";
}

// GitHub item data
interface GitHubItemData {
  title: string;
  body: string;
  state: string;
  author: string;
}

interface SubIssue {
  number: number;
  title: string;
  state: string;
  body: string;
}

// Fetch a single GitHub issue/PR
function fetchSingleGitHubItem(owner: string, repo: string, type: "issue" | "pr", number: string): GitHubItemData | null {
  try {
    const ghType = type === "pr" ? "pr" : "issue";
    const cmd = `gh ${ghType} view ${number} --repo ${owner}/${repo} --json title,body,state,author`;

    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });

    const data = JSON.parse(output) as {
      title?: string;
      body?: string;
      state?: string;
      author?: { login?: string };
    };

    return {
      title: data.title || "",
      body: data.body || "",
      state: data.state || "unknown",
      author: data.author?.login || "unknown",
    };
  } catch (error) {
    console.error(`Failed to fetch GitHub ${type} #${number}:`, error);
    return null;
  }
}

// Fetch sub-issues using GraphQL trackedIssues
function fetchTrackedSubIssues(owner: string, repo: string, issueNumber: string): SubIssue[] {
  try {
    // Try direct trackedIssues first
    const query = `
      query {
        repository(owner: "${owner}", name: "${repo}") {
          issue(number: ${issueNumber}) {
            trackedIssues(first: 50) {
              nodes {
                number
                title
                state
                body
              }
            }
          }
        }
      }
    `;

    const cmd = `gh api graphql -f query='${query.replace(/'/g, "'\\''")}'`;
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });

    const data = JSON.parse(output) as {
      data?: {
        repository?: {
          issue?: {
            trackedIssues?: {
              nodes?: Array<{
                number?: number;
                title?: string;
                state?: string;
                body?: string;
              }>;
            };
          };
        };
      };
    };

    const nodes = data?.data?.repository?.issue?.trackedIssues?.nodes || [];
    const results = nodes
      .filter((n): n is { number: number; title: string; state: string; body: string } =>
        n?.number !== undefined && n?.title !== undefined
      )
      .map(n => ({
        number: n.number,
        title: n.title || "",
        state: n.state || "OPEN",
        body: n.body || "",
      }));

    if (results.length > 0) {
      return results;
    }

    // If no trackedIssues found, try reverse lookup: find issues that track THIS issue
    console.log(`[GitHub] No direct trackedIssues, trying reverse lookup...`);
    return fetchIssuesTrackingThis(owner, repo, issueNumber);
  } catch (error) {
    console.error("Failed to fetch tracked sub-issues via GraphQL:", error);
    return [];
  }
}

// Fetch issues that are tracking the given issue (reverse lookup)
function fetchIssuesTrackingThis(owner: string, repo: string, parentIssueNumber: string): SubIssue[] {
  try {
    // Get all open issues in the repo and check which ones track this issue
    const query = `
      query {
        repository(owner: "${owner}", name: "${repo}") {
          issues(first: 50, states: OPEN) {
            nodes {
              number
              title
              state
              body
              trackedInIssues(first: 10) {
                nodes {
                  number
                }
              }
            }
          }
        }
      }
    `;

    const cmd = `gh api graphql -f query='${query.replace(/'/g, "'\\''")}'`;
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });

    const data = JSON.parse(output) as {
      data?: {
        repository?: {
          issues?: {
            nodes?: Array<{
              number?: number;
              title?: string;
              state?: string;
              body?: string;
              trackedInIssues?: {
                nodes?: Array<{ number?: number }>;
              };
            }>;
          };
        };
      };
    };

    const allIssues = data?.data?.repository?.issues?.nodes || [];
    const parentNum = parseInt(parentIssueNumber, 10);

    // Filter issues that are tracked by the parent issue
    const subIssues = allIssues.filter(issue => {
      if (!issue || issue.number === parentNum) return false;
      const trackedIn = issue.trackedInIssues?.nodes || [];
      return trackedIn.some(t => t?.number === parentNum);
    });

    console.log(`[GitHub] Found ${subIssues.length} issues tracking #${parentIssueNumber}`);

    return subIssues
      .filter(n => n?.number !== undefined && n?.title !== undefined)
      .map(n => ({
        number: n.number as number,
        title: n.title || "",
        state: n.state || "OPEN",
        body: n.body || "",
      }));
  } catch (error) {
    console.error("Failed to fetch issues tracking this issue:", error);
    return [];
  }
}

// Extract sub-issue references from issue body (fallback method)
function extractSubIssueRefs(body: string, defaultOwner: string, defaultRepo: string): Array<{ owner: string; repo: string; number: string }> {
  const refs: Array<{ owner: string; repo: string; number: string }> = [];
  const seen = new Set<string>();

  let match;

  // Pattern 1: Task list with same repo - [ ] #123 or - [x] #123
  const taskListPattern = /- \[[x ]\] #(\d+)/gi;
  while ((match = taskListPattern.exec(body)) !== null) {
    const num = match[1];
    if (num) {
      const key = `${defaultOwner}/${defaultRepo}#${num}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ owner: defaultOwner, repo: defaultRepo, number: num });
      }
    }
  }

  // Pattern 2: Task list with cross repo - [ ] owner/repo#123
  const taskListCrossRepoPattern = /- \[[x ]\] ([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#(\d+)/gi;
  while ((match = taskListCrossRepoPattern.exec(body)) !== null) {
    const [, o, r, n] = match;
    if (o && r && n) {
      const key = `${o}/${r}#${n}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ owner: o, repo: r, number: n });
      }
    }
  }

  // Pattern 3: Task list with URL - [ ] https://github.com/owner/repo/issues/123
  const taskListUrlPattern = /- \[[x ]\] https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/gi;
  while ((match = taskListUrlPattern.exec(body)) !== null) {
    const [, o, r, n] = match;
    if (o && r && n) {
      const key = `${o}/${r}#${n}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ owner: o, repo: r, number: n });
      }
    }
  }

  // Pattern 4: Simple bullet list with #123 (- #123 or * #123)
  const simpleBulletPattern = /^[\s]*[-*]\s+#(\d+)/gm;
  while ((match = simpleBulletPattern.exec(body)) !== null) {
    const num = match[1];
    if (num) {
      const key = `${defaultOwner}/${defaultRepo}#${num}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ owner: defaultOwner, repo: defaultRepo, number: num });
      }
    }
  }

  // Pattern 5: Inline issue references (standalone #123 at word boundary)
  const inlineRefPattern = /(?:^|[\s,])#(\d+)(?=[\s,.]|$)/gm;
  while ((match = inlineRefPattern.exec(body)) !== null) {
    const num = match[1];
    if (num) {
      const key = `${defaultOwner}/${defaultRepo}#${num}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ owner: defaultOwner, repo: defaultRepo, number: num });
      }
    }
  }

  // Pattern 6: Full GitHub issue URLs anywhere in body
  const fullUrlPattern = /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/gi;
  while ((match = fullUrlPattern.exec(body)) !== null) {
    const [, o, r, n] = match;
    if (o && r && n) {
      const key = `${o}/${r}#${n}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ owner: o, repo: r, number: n });
      }
    }
  }

  return refs;
}

// Fetch GitHub content using gh command (with sub-issues support)
function fetchGitHubContent(owner: string, repo: string, type: "issue" | "pr", number: string): { title?: string; content?: string } {
  try {
    // Fetch main issue/PR
    const mainItem = fetchSingleGitHubItem(owner, repo, type, number);
    if (!mainItem) {
      console.log(`[GitHub] Failed to fetch ${type} #${number} from ${owner}/${repo}`);
      return {};
    }

    console.log(`[GitHub] Fetched ${type} #${number}: "${mainItem.title}" (body length: ${mainItem.body?.length || 0})`);

    let content = `# ${mainItem.title}\n\n${mainItem.body}\n\n---\nState: ${mainItem.state}\nAuthor: ${mainItem.author}`;

    // For issues, check for sub-issues
    if (type === "issue") {
      // First, try to get tracked sub-issues via GraphQL
      console.log(`[GitHub] Checking for tracked sub-issues...`);
      const trackedSubIssues = fetchTrackedSubIssues(owner, repo, number);
      console.log(`[GitHub] Found ${trackedSubIssues.length} tracked sub-issues via GraphQL`);

      if (trackedSubIssues.length > 0) {
        content += `\n\n---\n\n## Sub-Issues (${trackedSubIssues.length}件)\n`;

        for (const sub of trackedSubIssues) {
          const subState = sub.state === "OPEN" ? "🔵" : "✅";
          content += `\n### ${subState} #${sub.number}: ${sub.title}\n`;
          if (sub.body) {
            // Truncate long sub-issue bodies
            const truncatedBody = sub.body.length > 500
              ? sub.body.slice(0, 500) + "..."
              : sub.body;
            content += `${truncatedBody}\n`;
          }
        }
      } else if (mainItem.body) {
        // Fallback: extract from body text
        console.log(`[GitHub] Trying fallback: extracting issue refs from body...`);
        const subIssueRefs = extractSubIssueRefs(mainItem.body, owner, repo);
        console.log(`[GitHub] Found ${subIssueRefs.length} issue refs in body: ${subIssueRefs.map(r => `#${r.number}`).join(", ")}`);

        if (subIssueRefs.length > 0) {
          content += `\n\n---\n\n## Sub-Issues (${subIssueRefs.length}件)\n`;

          for (const ref of subIssueRefs) {
            const subItem = fetchSingleGitHubItem(ref.owner, ref.repo, "issue", ref.number);
            if (subItem) {
              const subRepo = (ref.owner === owner && ref.repo === repo) ? "" : `${ref.owner}/${ref.repo}`;
              const subState = subItem.state === "OPEN" ? "🔵" : "✅";
              content += `\n### ${subState} ${subRepo}#${ref.number}: ${subItem.title || "Untitled"}\n`;
              if (subItem.body) {
                // Truncate long sub-issue bodies
                const truncatedBody = subItem.body.length > 500
                  ? subItem.body.slice(0, 500) + "..."
                  : subItem.body;
                content += `${truncatedBody}\n`;
              }
            }
          }
        }
      } else {
        console.log(`[GitHub] No sub-issues found (body is empty and no tracked issues)`);
      }
    }

    const result: { title?: string; content?: string } = { content };
    if (mainItem.title) result.title = mainItem.title;
    return result;
  } catch (error) {
    console.error("Failed to fetch GitHub content via gh command:", error);
    return {};
  }
}

// Fetch content from external URL
async function fetchLinkContent(url: string, linkType: string): Promise<{ title?: string; content?: string }> {
  try {
    if (linkType === "github_issue" || linkType === "github_pr") {
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
      if (match && match[1] && match[2] && match[3] && match[4]) {
        const owner = match[1];
        const repo = match[2];
        const type = match[3];
        const number = match[4];
        const ghType = type === "pull" ? "pr" : "issue";
        return fetchGitHubContent(owner, repo, ghType, number);
      }
    }

    if (linkType === "notion") {
      return {
        title: "Notion Page",
        content: `[Notion link: ${url}]\n\nNote: Full Notion content extraction requires NOTION_API_KEY configuration.`,
      };
    }

    if (linkType === "figma") {
      return {
        title: "Figma Design",
        content: `[Figma link: ${url}]\n\nNote: Full Figma content extraction requires FIGMA_TOKEN configuration.`,
      };
    }

    // Generic URL
    const response = await fetch(url, {
      headers: { "User-Agent": "vibe-tree" },
    });
    if (response.ok) {
      const html = await response.text();
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const extractedTitle = titleMatch?.[1]?.trim();
      const textContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000);
      const result: { title?: string; content?: string } = { content: textContent };
      if (extractedTitle) result.title = extractedTitle;
      return result;
    }
  } catch (error) {
    console.error("Failed to fetch link content:", error);
  }
  return {};
}

// Schema
const addLinkSchema = z.object({
  planningSessionId: z.string().min(1),
  branchName: z.string().optional(), // null = session-level, set = branch-specific
  url: z.string().url(),
  title: z.string().optional(),
});

const updateLinkSchema = z.object({
  title: z.string().optional(),
});

// GET /api/external-links?planningSessionId=xxx&branchName=xxx
externalLinksRouter.get("/", async (c) => {
  const planningSessionId = c.req.query("planningSessionId");
  const branchName = c.req.query("branchName");

  if (!planningSessionId) {
    throw new BadRequestError("planningSessionId is required");
  }

  let query = db
    .select()
    .from(externalLinks)
    .where(eq(externalLinks.planningSessionId, planningSessionId))
    .orderBy(externalLinks.createdAt);

  const links = await query;

  // Filter by branchName if provided
  // If branchName is provided, return links for that branch OR session-level links (null branchName)
  const filteredLinks = branchName
    ? links.filter((link) => link.branchName === branchName || link.branchName === null)
    : links;

  return c.json(filteredLinks);
});

// POST /api/external-links - Add a new link
externalLinksRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { planningSessionId, branchName, url, title } = validateOrThrow(addLinkSchema, body);

  const linkType = detectLinkType(url);
  const now = new Date().toISOString();

  // Insert immediately without fetching content (for fast UX)
  const [inserted] = await db
    .insert(externalLinks)
    .values({
      planningSessionId,
      branchName: branchName || null,
      url,
      linkType,
      title: title || null,
      contentCache: null,
      lastFetchedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  broadcast({
    type: "external-link.created",
    planningSessionId,
    branchName: branchName || null,
    data: inserted,
  });

  // Fetch content in background and update
  fetchLinkContent(url, linkType).then(async ({ title: fetchedTitle, content }) => {
    if (fetchedTitle || content) {
      const updateNow = new Date().toISOString();
      const [updated] = await db
        .update(externalLinks)
        .set({
          title: inserted.title || fetchedTitle || null,
          contentCache: content || null,
          lastFetchedAt: updateNow,
          updatedAt: updateNow,
        })
        .where(eq(externalLinks.id, inserted.id))
        .returning();

      broadcast({
        type: "external-link.updated",
        planningSessionId,
        data: updated,
      });
    }
  }).catch((err) => {
    console.error("Background fetch failed for link:", url, err);
  });

  return c.json(inserted, 201);
});

// POST /api/external-links/:id/refresh - Re-fetch content
externalLinksRouter.post("/:id/refresh", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const [link] = await db
    .select()
    .from(externalLinks)
    .where(eq(externalLinks.id, id));

  if (!link) {
    throw new NotFoundError("Link not found");
  }

  const { title, content } = await fetchLinkContent(link.url, link.linkType);
  const now = new Date().toISOString();

  const [updated] = await db
    .update(externalLinks)
    .set({
      title: title || link.title,
      contentCache: content || link.contentCache,
      lastFetchedAt: now,
      updatedAt: now,
    })
    .where(eq(externalLinks.id, id))
    .returning();

  broadcast({
    type: "external-link.updated",
    planningSessionId: link.planningSessionId,
    data: updated,
  });

  return c.json(updated);
});

// PATCH /api/external-links/:id - Update title
externalLinksRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const body = await c.req.json();
  const { title } = validateOrThrow(updateLinkSchema, body);

  const [existing] = await db
    .select()
    .from(externalLinks)
    .where(eq(externalLinks.id, id));

  if (!existing) {
    throw new NotFoundError("Link not found");
  }

  const now = new Date().toISOString();

  const [updated] = await db
    .update(externalLinks)
    .set({
      title,
      updatedAt: now,
    })
    .where(eq(externalLinks.id, id))
    .returning();

  broadcast({
    type: "external-link.updated",
    planningSessionId: existing.planningSessionId,
    data: updated,
  });

  return c.json(updated);
});

// DELETE /api/external-links/:id
externalLinksRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const [link] = await db
    .select()
    .from(externalLinks)
    .where(eq(externalLinks.id, id));

  if (!link) {
    throw new NotFoundError("Link not found");
  }

  await db.delete(externalLinks).where(eq(externalLinks.id, id));

  broadcast({
    type: "external-link.deleted",
    planningSessionId: link.planningSessionId,
    data: { id },
  });

  return c.json({ success: true });
});

// GET /api/external-links/context?planningSessionId=xxx - Get all link contents for Claude context
externalLinksRouter.get("/context", async (c) => {
  const planningSessionId = c.req.query("planningSessionId");
  if (!planningSessionId) {
    throw new BadRequestError("planningSessionId is required");
  }

  const links = await db
    .select()
    .from(externalLinks)
    .where(eq(externalLinks.planningSessionId, planningSessionId));

  // Build context string for Claude
  const contextParts = links
    .filter((link) => link.contentCache)
    .map((link) => {
      return `## ${link.title || link.linkType.toUpperCase()}\nSource: ${link.url}\n\n${link.contentCache}`;
    });

  return c.json({
    links,
    contextMarkdown: contextParts.length > 0
      ? `# External References\n\n${contextParts.join("\n\n---\n\n")}`
      : null,
  });
});
