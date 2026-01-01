import { Hono } from "hono";
import { eq } from "drizzle-orm";
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

// Fetch content from external URL
async function fetchLinkContent(url: string, linkType: string): Promise<{ title?: string; content?: string }> {
  try {
    if (linkType === "github_issue" || linkType === "github_pr") {
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
      if (match) {
        const [, owner, repo, type, number] = match;
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/${type === "pull" ? "pulls" : "issues"}/${number}`;
        const response = await fetch(apiUrl, {
          headers: {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "vibe-tree",
            ...(process.env.GITHUB_TOKEN ? { "Authorization": `token ${process.env.GITHUB_TOKEN}` } : {}),
          },
        });
        if (response.ok) {
          const data = await response.json() as {
            title?: string;
            body?: string;
            state?: string;
            user?: { login?: string };
          };
          const result: { title?: string; content?: string } = {
            content: `# ${data.title || ""}\n\n${data.body || ""}\n\n---\nState: ${data.state || "unknown"}\nAuthor: ${data.user?.login || "unknown"}`,
          };
          if (data.title) result.title = data.title;
          return result;
        }
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
  url: z.string().url(),
  title: z.string().optional(),
});

const updateLinkSchema = z.object({
  title: z.string().optional(),
});

// GET /api/external-links?planningSessionId=xxx
externalLinksRouter.get("/", async (c) => {
  const planningSessionId = c.req.query("planningSessionId");
  if (!planningSessionId) {
    throw new BadRequestError("planningSessionId is required");
  }

  const links = await db
    .select()
    .from(externalLinks)
    .where(eq(externalLinks.planningSessionId, planningSessionId))
    .orderBy(externalLinks.createdAt);

  return c.json(links);
});

// POST /api/external-links - Add a new link
externalLinksRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { planningSessionId, url, title } = validateOrThrow(addLinkSchema, body);

  const linkType = detectLinkType(url);
  const now = new Date().toISOString();

  // Fetch content
  const { title: fetchedTitle, content } = await fetchLinkContent(url, linkType);

  const [inserted] = await db
    .insert(externalLinks)
    .values({
      planningSessionId,
      url,
      linkType,
      title: title || fetchedTitle || null,
      contentCache: content || null,
      lastFetchedAt: content ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  broadcast({
    type: "external-link.created",
    planningSessionId,
    data: inserted,
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
