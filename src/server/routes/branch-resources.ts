import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../../db";
import { branchExternalLinks, branchFiles } from "../../db/schema";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError, NotFoundError } from "../middleware/error-handler";
import { broadcast } from "../ws";
import path from "path";
import fs from "fs";
import crypto from "crypto";

export const branchResourcesRouter = new Hono();

// Storage directory for uploaded files
const STORAGE_DIR = path.join(process.cwd(), ".vibetree", "storage");

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

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
  return "url";
}

// ============================================================
// External Links Endpoints
// ============================================================

const addLinkSchema = z.object({
  repoId: z.string().min(1),
  branchName: z.string().min(1),
  url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const updateLinkSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});

// GET /api/branch-resources/links?repoId=X&branchName=Y
branchResourcesRouter.get("/links", async (c) => {
  const repoId = c.req.query("repoId");
  const branchName = c.req.query("branchName");

  if (!repoId || !branchName) {
    throw new BadRequestError("repoId and branchName are required");
  }

  const links = await db
    .select()
    .from(branchExternalLinks)
    .where(
      and(
        eq(branchExternalLinks.repoId, repoId),
        eq(branchExternalLinks.branchName, branchName)
      )
    )
    .orderBy(branchExternalLinks.createdAt);

  return c.json(links);
});

// GET /api/branch-resources/links/batch?repoId=X&branches=a,b,c
branchResourcesRouter.get("/links/batch", async (c) => {
  const repoId = c.req.query("repoId");
  const branches = c.req.query("branches");

  if (!repoId || !branches) {
    throw new BadRequestError("repoId and branches are required");
  }

  const branchNames = branches.split(",").filter(Boolean);
  if (branchNames.length === 0) {
    return c.json({});
  }

  const links = await db
    .select()
    .from(branchExternalLinks)
    .where(
      and(
        eq(branchExternalLinks.repoId, repoId),
        inArray(branchExternalLinks.branchName, branchNames)
      )
    );

  // Group by branch name
  const grouped: Record<string, typeof links> = {};
  for (const link of links) {
    const key = link.branchName;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key]!.push(link);
  }

  return c.json(grouped);
});

// POST /api/branch-resources/links
branchResourcesRouter.post("/links", async (c) => {
  const body = await c.req.json();
  const { repoId, branchName, url, title, description } = validateOrThrow(addLinkSchema, body);

  const linkType = detectLinkType(url);
  const now = new Date().toISOString();

  const [inserted] = await db
    .insert(branchExternalLinks)
    .values({
      repoId,
      branchName,
      url,
      linkType,
      title: title || null,
      description: description || null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  broadcast({
    type: "branch-resource.link.created",
    repoId,
    branchName,
    data: inserted,
  });

  return c.json(inserted, 201);
});

// PATCH /api/branch-resources/links/:id
branchResourcesRouter.patch("/links/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const body = await c.req.json();
  const { title, description } = validateOrThrow(updateLinkSchema, body);

  const [existing] = await db
    .select()
    .from(branchExternalLinks)
    .where(eq(branchExternalLinks.id, id));

  if (!existing) {
    throw new NotFoundError("Link not found");
  }

  const now = new Date().toISOString();

  const [updated] = await db
    .update(branchExternalLinks)
    .set({
      title,
      description,
      updatedAt: now,
    })
    .where(eq(branchExternalLinks.id, id))
    .returning();

  broadcast({
    type: "branch-resource.link.updated",
    repoId: existing.repoId,
    branchName: existing.branchName,
    data: updated,
  });

  return c.json(updated);
});

// DELETE /api/branch-resources/links/:id
branchResourcesRouter.delete("/links/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const [link] = await db
    .select()
    .from(branchExternalLinks)
    .where(eq(branchExternalLinks.id, id));

  if (!link) {
    throw new NotFoundError("Link not found");
  }

  await db.delete(branchExternalLinks).where(eq(branchExternalLinks.id, id));

  broadcast({
    type: "branch-resource.link.deleted",
    repoId: link.repoId,
    branchName: link.branchName,
    data: { id },
  });

  return c.json({ success: true });
});

// ============================================================
// Files Endpoints
// ============================================================

// GET /api/branch-resources/files?repoId=X&branchName=Y
branchResourcesRouter.get("/files", async (c) => {
  const repoId = c.req.query("repoId");
  const branchName = c.req.query("branchName");

  if (!repoId || !branchName) {
    throw new BadRequestError("repoId and branchName are required");
  }

  const files = await db
    .select()
    .from(branchFiles)
    .where(
      and(
        eq(branchFiles.repoId, repoId),
        eq(branchFiles.branchName, branchName)
      )
    )
    .orderBy(branchFiles.createdAt);

  return c.json(files);
});

// GET /api/branch-resources/files/batch?repoId=X&branches=a,b,c
branchResourcesRouter.get("/files/batch", async (c) => {
  const repoId = c.req.query("repoId");
  const branches = c.req.query("branches");

  if (!repoId || !branches) {
    throw new BadRequestError("repoId and branches are required");
  }

  const branchNames = branches.split(",").filter(Boolean);
  if (branchNames.length === 0) {
    return c.json({});
  }

  const files = await db
    .select()
    .from(branchFiles)
    .where(
      and(
        eq(branchFiles.repoId, repoId),
        inArray(branchFiles.branchName, branchNames)
      )
    );

  // Group by branch name
  const grouped: Record<string, typeof files> = {};
  for (const file of files) {
    const key = file.branchName;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key]!.push(file);
  }

  return c.json(grouped);
});

// POST /api/branch-resources/files - Upload a file
branchResourcesRouter.post("/files", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const repoId = formData.get("repoId") as string | null;
  const branchName = formData.get("branchName") as string | null;
  const description = formData.get("description") as string | null;
  const sourceType = (formData.get("sourceType") as string | null) || "upload";
  const sourceUrl = formData.get("sourceUrl") as string | null;

  if (!file || !repoId || !branchName) {
    throw new BadRequestError("file, repoId, and branchName are required");
  }

  // Generate unique filename
  const ext = path.extname(file.name);
  const hash = crypto.randomBytes(16).toString("hex");
  const filename = `${hash}${ext}`;
  const repoDir = path.join(STORAGE_DIR, repoId.replace("/", "_"));

  // Ensure repo directory exists
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }

  const filePath = path.join(repoDir, filename);
  const relativePath = path.relative(STORAGE_DIR, filePath);

  // Write file
  const buffer = await file.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(buffer));

  const now = new Date().toISOString();

  const [inserted] = await db
    .insert(branchFiles)
    .values({
      repoId,
      branchName,
      filePath: relativePath,
      originalName: file.name,
      mimeType: file.type || null,
      fileSize: file.size,
      description: description || null,
      sourceType,
      sourceUrl: sourceUrl || null,
      createdAt: now,
    })
    .returning();

  broadcast({
    type: "branch-resource.file.created",
    repoId,
    branchName,
    data: inserted,
  });

  return c.json(inserted, 201);
});

// GET /api/branch-resources/files/:id/download - Download/serve a file
branchResourcesRouter.get("/files/:id/download", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const [file] = await db
    .select()
    .from(branchFiles)
    .where(eq(branchFiles.id, id));

  if (!file) {
    throw new NotFoundError("File not found");
  }

  const absolutePath = path.join(STORAGE_DIR, file.filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new NotFoundError("File not found on disk");
  }

  const data = fs.readFileSync(absolutePath);

  return new Response(data, {
    headers: {
      "Content-Type": file.mimeType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${file.originalName || path.basename(file.filePath)}"`,
    },
  });
});

// DELETE /api/branch-resources/files/:id
branchResourcesRouter.delete("/files/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const [file] = await db
    .select()
    .from(branchFiles)
    .where(eq(branchFiles.id, id));

  if (!file) {
    throw new NotFoundError("File not found");
  }

  // Delete file from disk
  const absolutePath = path.join(STORAGE_DIR, file.filePath);
  if (fs.existsSync(absolutePath)) {
    fs.unlinkSync(absolutePath);
  }

  // Delete record from database
  await db.delete(branchFiles).where(eq(branchFiles.id, id));

  broadcast({
    type: "branch-resource.file.deleted",
    repoId: file.repoId,
    branchName: file.branchName,
    data: { id },
  });

  return c.json({ success: true });
});

// PATCH /api/branch-resources/files/:id - Update file description
branchResourcesRouter.patch("/files/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw new BadRequestError("Invalid id");
  }

  const body = await c.req.json();
  const description = body.description as string | undefined;

  const [existing] = await db
    .select()
    .from(branchFiles)
    .where(eq(branchFiles.id, id));

  if (!existing) {
    throw new NotFoundError("File not found");
  }

  // For branchFiles we don't have updatedAt, but we can still update description
  // We need to use a raw query or modify the schema. Let's keep it simple for now.
  // Actually, branchFiles doesn't have updatedAt. Let's just update description.

  // Note: branchFiles table doesn't have updatedAt column, so we'll just update what we can
  const [updated] = await db
    .update(branchFiles)
    .set({
      description: description || null,
    })
    .where(eq(branchFiles.id, id))
    .returning();

  broadcast({
    type: "branch-resource.file.updated",
    repoId: existing.repoId,
    branchName: existing.branchName,
    data: updated,
  });

  return c.json(updated);
});
