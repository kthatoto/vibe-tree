import { z } from "zod";
import { getDb, getStorageBasePath } from "../db/client";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ============================================================
// Session Links (get links from planning session)
// ============================================================

export const getSessionLinksSchema = z.object({
  planningSessionId: z.string().min(1).describe("Planning session ID"),
});

export type GetSessionLinksInput = z.infer<typeof getSessionLinksSchema>;

interface SessionLinkOutput {
  id: number;
  linkType: string;
  url: string;
  title: string | null;
  branchName: string | null;
}

interface GetSessionLinksOutput {
  planningSessionId: string;
  links: SessionLinkOutput[];
}

export function getSessionLinks(input: GetSessionLinksInput): GetSessionLinksOutput {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, link_type, url, title, branch_name FROM external_links
       WHERE planning_session_id = ?
       ORDER BY created_at DESC`
    )
    .all(input.planningSessionId) as Array<{
    id: number;
    link_type: string;
    url: string;
    title: string | null;
    branch_name: string | null;
  }>;

  return {
    planningSessionId: input.planningSessionId,
    links: rows.map((r) => ({
      id: r.id,
      linkType: r.link_type,
      url: r.url,
      title: r.title,
      branchName: r.branch_name,
    })),
  };
}

// ============================================================
// Branch Links (external links attached to branches)
// ============================================================

export const addBranchLinkSchema = z.object({
  repoId: z.string().min(1).describe("Repository ID (owner/repo format)"),
  branchName: z.string().min(1).describe("Branch name"),
  url: z.string().url().describe("URL of the external link"),
  title: z.string().optional().describe("Title of the link"),
  description: z.string().optional().describe("Description or note about the link"),
});

export type AddBranchLinkInput = z.infer<typeof addBranchLinkSchema>;

interface BranchLinkOutput {
  id: number;
  repoId: string;
  branchName: string;
  linkType: string;
  url: string;
  title: string | null;
  description: string | null;
}

function detectLinkType(url: string): string {
  const lowered = url.toLowerCase();
  if (lowered.includes("figma.com")) return "figma";
  if (lowered.includes("notion.so") || lowered.includes("notion.site"))
    return "notion";
  if (lowered.includes("github.com") && lowered.includes("/issues/"))
    return "github_issue";
  if (lowered.includes("github.com") && lowered.includes("/pull/"))
    return "github_pr";
  return "url";
}

export function addBranchLink(input: AddBranchLinkInput): BranchLinkOutput {
  const db = getDb();
  const now = new Date().toISOString();
  const linkType = detectLinkType(input.url);

  const stmt = db.prepare(
    `INSERT INTO branch_external_links (repo_id, branch_name, link_type, url, title, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const info = stmt.run(
    input.repoId,
    input.branchName,
    linkType,
    input.url,
    input.title ?? null,
    input.description ?? null,
    now,
    now
  );

  const created = db
    .prepare(`SELECT * FROM branch_external_links WHERE id = ?`)
    .get(info.lastInsertRowid as number) as {
    id: number;
    repo_id: string;
    branch_name: string;
    link_type: string;
    url: string;
    title: string | null;
    description: string | null;
  };

  return {
    id: created.id,
    repoId: created.repo_id,
    branchName: created.branch_name,
    linkType: created.link_type,
    url: created.url,
    title: created.title,
    description: created.description,
  };
}

// List branch links
export const listBranchLinksSchema = z.object({
  repoId: z.string().min(1).describe("Repository ID (owner/repo format)"),
  branchName: z.string().min(1).describe("Branch name"),
});

export type ListBranchLinksInput = z.infer<typeof listBranchLinksSchema>;

interface ListBranchLinksOutput {
  branchName: string;
  links: BranchLinkOutput[];
}

export function listBranchLinks(
  input: ListBranchLinksInput
): ListBranchLinksOutput {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT * FROM branch_external_links WHERE repo_id = ? AND branch_name = ? ORDER BY created_at DESC`
    )
    .all(input.repoId, input.branchName) as Array<{
    id: number;
    repo_id: string;
    branch_name: string;
    link_type: string;
    url: string;
    title: string | null;
    description: string | null;
  }>;

  return {
    branchName: input.branchName,
    links: rows.map((r) => ({
      id: r.id,
      repoId: r.repo_id,
      branchName: r.branch_name,
      linkType: r.link_type,
      url: r.url,
      title: r.title,
      description: r.description,
    })),
  };
}

// Remove branch link
export const removeBranchLinkSchema = z.object({
  linkId: z.coerce.number().min(1).describe("Link ID to remove"),
});

export type RemoveBranchLinkInput = z.infer<typeof removeBranchLinkSchema>;

export function removeBranchLink(
  input: RemoveBranchLinkInput
): { success: boolean } {
  const db = getDb();

  const existing = db
    .prepare(`SELECT * FROM branch_external_links WHERE id = ?`)
    .get(input.linkId);
  if (!existing) {
    throw new Error(`Link not found: ${input.linkId}`);
  }

  db.prepare(`DELETE FROM branch_external_links WHERE id = ?`).run(
    input.linkId
  );

  return { success: true };
}

// ============================================================
// Branch Files (images attached to branches)
// ============================================================

export const saveImageToBranchSchema = z.object({
  repoId: z.string().min(1).describe("Repository ID (owner/repo format)"),
  branchName: z.string().min(1).describe("Branch name"),
  imageData: z.string().min(1).describe("Base64 encoded image data"),
  originalName: z.string().min(1).describe("Original file name"),
  description: z.string().optional().describe("Description of the image"),
  sourceUrl: z.string().url().optional().describe("Original URL if from external source (e.g., Figma)"),
});

export type SaveImageToBranchInput = z.infer<typeof saveImageToBranchSchema>;

interface BranchFileOutput {
  id: number;
  repoId: string;
  branchName: string;
  filePath: string;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  description: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
}

function detectMimeType(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function getStorageDir(): string {
  // Store in .vibetree/storage/branch-files/ (relative to DB location)
  const basePath = getStorageBasePath();
  const storageDir = path.join(basePath, "branch-files");
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  return storageDir;
}

export function saveImageToBranch(input: SaveImageToBranchInput): BranchFileOutput {
  const db = getDb();
  const now = new Date().toISOString();

  // Decode base64 image with error handling
  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(input.imageData, "base64");
  } catch {
    throw new Error("Invalid base64 image data");
  }

  // Validate that it's actually image data (not empty)
  if (imageBuffer.length === 0) {
    throw new Error("Empty image data");
  }

  const fileSize = imageBuffer.length;
  // Use basename to handle cases where originalName might contain path
  const safeOriginalName = path.basename(input.originalName);
  const mimeType = detectMimeType(safeOriginalName);

  // Generate unique filename with sanitization
  const hash = crypto.createHash("md5").update(imageBuffer).digest("hex").slice(0, 8);
  const ext = path.extname(safeOriginalName) || ".png";
  // Sanitize branch name to prevent path traversal
  const sanitizedBranch = input.branchName
    .replace(/\.\./g, "_") // Prevent path traversal
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 50); // Limit length
  const fileName = `${sanitizedBranch}_${Date.now()}_${hash}${ext}`;

  // Save file to storage
  const storageDir = getStorageDir();
  const filePath = path.join(storageDir, fileName);

  try {
    fs.writeFileSync(filePath, imageBuffer);
  } catch (err) {
    throw new Error(`Failed to save image: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Relative path for DB storage (relative to storage base)
  const basePath = getStorageBasePath();
  const relativeFilePath = path.relative(path.dirname(basePath), filePath);

  // Determine source type
  const sourceType = input.sourceUrl
    ? input.sourceUrl.includes("figma.com")
      ? "figma_mcp"
      : "screenshot"
    : "upload";

  const stmt = db.prepare(
    `INSERT INTO branch_files (repo_id, branch_name, file_path, original_name, mime_type, file_size, description, source_type, source_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const info = stmt.run(
    input.repoId,
    input.branchName,
    relativeFilePath,
    safeOriginalName,
    mimeType,
    fileSize,
    input.description ?? null,
    sourceType,
    input.sourceUrl ?? null,
    now
  );

  const created = db
    .prepare(`SELECT * FROM branch_files WHERE id = ?`)
    .get(info.lastInsertRowid as number) as {
    id: number;
    repo_id: string;
    branch_name: string;
    file_path: string;
    original_name: string | null;
    mime_type: string | null;
    file_size: number | null;
    description: string | null;
    source_type: string | null;
    source_url: string | null;
  };

  return {
    id: created.id,
    repoId: created.repo_id,
    branchName: created.branch_name,
    filePath: created.file_path,
    originalName: created.original_name,
    mimeType: created.mime_type,
    fileSize: created.file_size,
    description: created.description,
    sourceType: created.source_type,
    sourceUrl: created.source_url,
  };
}

// List branch files
export const listBranchFilesSchema = z.object({
  repoId: z.string().min(1).describe("Repository ID (owner/repo format)"),
  branchName: z.string().min(1).describe("Branch name"),
});

export type ListBranchFilesInput = z.infer<typeof listBranchFilesSchema>;

interface ListBranchFilesOutput {
  branchName: string;
  files: BranchFileOutput[];
}

export function listBranchFiles(
  input: ListBranchFilesInput
): ListBranchFilesOutput {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT * FROM branch_files WHERE repo_id = ? AND branch_name = ? ORDER BY created_at DESC`
    )
    .all(input.repoId, input.branchName) as Array<{
    id: number;
    repo_id: string;
    branch_name: string;
    file_path: string;
    original_name: string | null;
    mime_type: string | null;
    file_size: number | null;
    description: string | null;
    source_type: string | null;
    source_url: string | null;
  }>;

  return {
    branchName: input.branchName,
    files: rows.map((r) => ({
      id: r.id,
      repoId: r.repo_id,
      branchName: r.branch_name,
      filePath: r.file_path,
      originalName: r.original_name,
      mimeType: r.mime_type,
      fileSize: r.file_size,
      description: r.description,
      sourceType: r.source_type,
      sourceUrl: r.source_url,
    })),
  };
}
