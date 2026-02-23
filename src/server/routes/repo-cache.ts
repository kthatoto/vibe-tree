import { Hono } from "hono";
import { db, schema } from "../../db";
import { execAsync } from "../utils";
import { eq, and, like, or, desc } from "drizzle-orm";
import { z } from "zod";
import { validateOrThrow } from "../../shared/validation";
import { BadRequestError } from "../middleware/error-handler";

export const repoCacheRouter = new Hono();

// Types
interface GitHubLabel {
  name: string;
  color: string;
  description: string;
}

interface GitHubCollaborator {
  login: string;
  name: string | null;
  avatar_url: string;
  role_name: string;
}

interface GitHubTeam {
  slug: string;
  name: string;
  description: string | null;
}

// Validation schemas
const syncSchema = z.object({
  repoId: z.string().min(1),
});

const searchSchema = z.object({
  repoId: z.string().min(1),
  q: z.string().optional(),
});

// Helper: Check if sync is needed (older than 1 hour)
function needsSync(syncedAt: string | null | undefined): boolean {
  if (!syncedAt) return true;
  const lastSync = new Date(syncedAt).getTime();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return lastSync < oneHourAgo;
}

// Helper: Sync labels from GitHub
async function syncLabels(repoId: string): Promise<void> {
  const now = new Date().toISOString();

  try {
    // Fetch all labels using pagination
    const result = (await execAsync(
      `gh label list --repo "${repoId}" --json name,color,description --limit 1000`
    )).trim();

    const labels: GitHubLabel[] = JSON.parse(result || "[]");

    // Upsert labels
    for (const label of labels) {
      const [existing] = await db.select().from(schema.repoLabels)
        .where(and(eq(schema.repoLabels.repoId, repoId), eq(schema.repoLabels.name, label.name)))
        .limit(1);

      if (existing) {
        await db.update(schema.repoLabels)
          .set({
            color: label.color,
            description: label.description || null,
            syncedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.repoLabels.id, existing.id));
      } else {
        await db.insert(schema.repoLabels).values({
          repoId,
          name: label.name,
          color: label.color,
          description: label.description || null,
          syncedAt: now,
          updatedAt: now,
        });
      }
    }

    // Remove labels that no longer exist on GitHub
    const labelNames = new Set(labels.map(l => l.name));
    const cachedLabels = await db.select().from(schema.repoLabels)
      .where(eq(schema.repoLabels.repoId, repoId));

    for (const cached of cachedLabels) {
      if (!labelNames.has(cached.name)) {
        await db.delete(schema.repoLabels).where(eq(schema.repoLabels.id, cached.id));
      }
    }
  } catch (err) {
    console.error(`Failed to sync labels for ${repoId}:`, err);
  }
}

// Helper: Sync collaborators from GitHub
async function syncCollaborators(repoId: string): Promise<void> {
  const now = new Date().toISOString();

  try {
    // Fetch collaborators with affiliation (direct = invited, all = include from org)
    const result = (await execAsync(
      `gh api repos/${repoId}/collaborators --paginate --jq '.[] | {login, avatar_url, role_name: .role_name}'`
    )).trim();

    const lines = result.split('\n').filter(Boolean);
    const collaborators: GitHubCollaborator[] = lines.map(line => JSON.parse(line));

    // Fetch user names in parallel (batch to avoid rate limiting)
    const collaboratorsWithNames = await Promise.all(
      collaborators.map(async (c) => {
        try {
          const userResult = (await execAsync(`gh api users/${c.login} --jq '.name'`)).trim();
          return { ...c, name: userResult || null };
        } catch {
          return { ...c, name: null };
        }
      })
    );

    // Upsert collaborators
    for (const collab of collaboratorsWithNames) {
      const [existing] = await db.select().from(schema.repoCollaborators)
        .where(and(eq(schema.repoCollaborators.repoId, repoId), eq(schema.repoCollaborators.login, collab.login)))
        .limit(1);

      if (existing) {
        await db.update(schema.repoCollaborators)
          .set({
            name: collab.name,
            avatarUrl: collab.avatar_url,
            role: collab.role_name,
            syncedAt: now,
          })
          .where(eq(schema.repoCollaborators.id, existing.id));
      } else {
        await db.insert(schema.repoCollaborators).values({
          repoId,
          login: collab.login,
          name: collab.name,
          avatarUrl: collab.avatar_url,
          role: collab.role_name,
          syncedAt: now,
        });
      }
    }

    // Remove collaborators that no longer exist
    const collabLogins = new Set(collaboratorsWithNames.map(c => c.login));
    const cachedCollabs = await db.select().from(schema.repoCollaborators)
      .where(eq(schema.repoCollaborators.repoId, repoId));

    for (const cached of cachedCollabs) {
      if (!collabLogins.has(cached.login)) {
        await db.delete(schema.repoCollaborators).where(eq(schema.repoCollaborators.id, cached.id));
      }
    }
  } catch (err) {
    console.error(`Failed to sync collaborators for ${repoId}:`, err);
  }
}

// Helper: Sync teams from GitHub (for org repos only)
async function syncTeams(repoId: string): Promise<void> {
  const now = new Date().toISOString();

  try {
    // Check if this is an org repo by trying to fetch teams
    const result = (await execAsync(
      `gh api repos/${repoId}/teams --paginate --jq '.[] | {slug, name, description}'`
    )).trim();

    if (!result) {
      // No teams or not an org repo - clear any existing teams
      await db.delete(schema.repoTeams).where(eq(schema.repoTeams.repoId, repoId));
      return;
    }

    const lines = result.split('\n').filter(Boolean);
    const teams: GitHubTeam[] = lines.map(line => JSON.parse(line));

    // Upsert teams
    for (const team of teams) {
      const [existing] = await db.select().from(schema.repoTeams)
        .where(and(eq(schema.repoTeams.repoId, repoId), eq(schema.repoTeams.slug, team.slug)))
        .limit(1);

      if (existing) {
        await db.update(schema.repoTeams)
          .set({
            name: team.name,
            description: team.description,
            syncedAt: now,
          })
          .where(eq(schema.repoTeams.id, existing.id));
      } else {
        await db.insert(schema.repoTeams).values({
          repoId,
          slug: team.slug,
          name: team.name,
          description: team.description,
          syncedAt: now,
        });
      }
    }

    // Remove teams that no longer exist
    const teamSlugs = new Set(teams.map(t => t.slug));
    const cachedTeams = await db.select().from(schema.repoTeams)
      .where(eq(schema.repoTeams.repoId, repoId));

    for (const cached of cachedTeams) {
      if (!teamSlugs.has(cached.slug)) {
        await db.delete(schema.repoTeams).where(eq(schema.repoTeams.id, cached.id));
      }
    }
  } catch (err) {
    // Expected to fail for personal repos - just clear teams
    console.log(`Teams sync skipped for ${repoId} (probably personal repo)`);
    await db.delete(schema.repoTeams).where(eq(schema.repoTeams.repoId, repoId));
  }
}

// POST /api/repo-cache/sync - Sync all cache data
repoCacheRouter.post("/sync", async (c) => {
  const body = await c.req.json();
  const input = validateOrThrow(syncSchema, body);

  // Sync all in parallel
  await Promise.all([
    syncLabels(input.repoId),
    syncCollaborators(input.repoId),
    syncTeams(input.repoId),
  ]);

  return c.json({ success: true });
});

// GET /api/repo-cache/sync-status - Check if sync is needed
repoCacheRouter.get("/sync-status", async (c) => {
  const repoId = c.req.query("repoId");
  if (!repoId) {
    throw new BadRequestError("repoId is required");
  }

  // Check labels sync
  const [label] = await db.select({ syncedAt: schema.repoLabels.syncedAt })
    .from(schema.repoLabels)
    .where(eq(schema.repoLabels.repoId, repoId))
    .limit(1);

  // Check collaborators sync
  const [collab] = await db.select({ syncedAt: schema.repoCollaborators.syncedAt })
    .from(schema.repoCollaborators)
    .where(eq(schema.repoCollaborators.repoId, repoId))
    .limit(1);

  const labelNeedsSync = needsSync(label?.syncedAt);
  const collabNeedsSync = needsSync(collab?.syncedAt);

  return c.json({
    needsSync: labelNeedsSync || collabNeedsSync,
    labels: {
      syncedAt: label?.syncedAt ?? null,
      needsSync: labelNeedsSync,
    },
    collaborators: {
      syncedAt: collab?.syncedAt ?? null,
      needsSync: collabNeedsSync,
    },
  });
});

// GET /api/repo-cache/labels - Get labels (with optional search)
repoCacheRouter.get("/labels", async (c) => {
  const query = validateOrThrow(searchSchema, {
    repoId: c.req.query("repoId"),
    q: c.req.query("q"),
  });

  let labels;
  if (query.q && query.q.length > 0) {
    const searchTerm = `%${query.q.toLowerCase()}%`;
    labels = await db.select().from(schema.repoLabels)
      .where(and(
        eq(schema.repoLabels.repoId, query.repoId),
        or(
          like(schema.repoLabels.name, searchTerm),
          like(schema.repoLabels.description, searchTerm)
        )
      ))
      .orderBy(schema.repoLabels.name);

    // If no results, try GitHub search
    if (labels.length === 0) {
      try {
        const result = (await execAsync(
          `gh label list --repo "${query.repoId}" --search "${query.q}" --json name,color,description --limit 20`
        )).trim();
        const githubLabels: GitHubLabel[] = JSON.parse(result || "[]");

        // Cache the results
        const now = new Date().toISOString();
        for (const label of githubLabels) {
          const [existing] = await db.select().from(schema.repoLabels)
            .where(and(eq(schema.repoLabels.repoId, query.repoId), eq(schema.repoLabels.name, label.name)))
            .limit(1);

          if (!existing) {
            await db.insert(schema.repoLabels).values({
              repoId: query.repoId,
              name: label.name,
              color: label.color,
              description: label.description || null,
              syncedAt: now,
              updatedAt: now,
            });
          }
        }

        // Return fresh results from DB
        labels = await db.select().from(schema.repoLabels)
          .where(and(
            eq(schema.repoLabels.repoId, query.repoId),
            or(
              like(schema.repoLabels.name, searchTerm),
              like(schema.repoLabels.description, searchTerm)
            )
          ))
          .orderBy(schema.repoLabels.name);
      } catch (err) {
        console.error("GitHub label search failed:", err);
      }
    }
  } else {
    labels = await db.select().from(schema.repoLabels)
      .where(eq(schema.repoLabels.repoId, query.repoId))
      .orderBy(schema.repoLabels.name);
  }

  return c.json(labels.map(l => ({
    name: l.name,
    color: l.color,
    description: l.description || "",
  })));
});

// GET /api/repo-cache/collaborators - Get collaborators (with optional search)
repoCacheRouter.get("/collaborators", async (c) => {
  const query = validateOrThrow(searchSchema, {
    repoId: c.req.query("repoId"),
    q: c.req.query("q"),
  });

  let collaborators;
  if (query.q && query.q.length > 0) {
    const searchTerm = `%${query.q.toLowerCase()}%`;
    collaborators = await db.select().from(schema.repoCollaborators)
      .where(and(
        eq(schema.repoCollaborators.repoId, query.repoId),
        or(
          like(schema.repoCollaborators.login, searchTerm),
          like(schema.repoCollaborators.name, searchTerm)
        )
      ))
      .orderBy(schema.repoCollaborators.login);

    // If no results, try GitHub search
    if (collaborators.length === 0) {
      try {
        // Search users on GitHub
        const result = (await execAsync(
          `gh api "search/users?q=${encodeURIComponent(query.q)}+type:user&per_page=10" --jq '.items[] | {login, avatar_url}'`
        )).trim();

        if (result) {
          const lines = result.split('\n').filter(Boolean);
          const users = lines.map(line => JSON.parse(line));

          // Check if each user is a collaborator and add to cache
          const now = new Date().toISOString();
          for (const user of users) {
            try {
              // Check if user is a collaborator (this will fail if not)
              await execAsync(`gh api repos/${query.repoId}/collaborators/${user.login} --silent`);

              // Get full user info
              const userInfo = (await execAsync(`gh api users/${user.login} --jq '.name'`)).trim();

              const [existing] = await db.select().from(schema.repoCollaborators)
                .where(and(eq(schema.repoCollaborators.repoId, query.repoId), eq(schema.repoCollaborators.login, user.login)))
                .limit(1);

              if (!existing) {
                await db.insert(schema.repoCollaborators).values({
                  repoId: query.repoId,
                  login: user.login,
                  name: userInfo || null,
                  avatarUrl: user.avatar_url,
                  role: null,
                  syncedAt: now,
                });
              }
            } catch {
              // User is not a collaborator, skip
            }
          }

          // Fetch results again
          collaborators = await db.select().from(schema.repoCollaborators)
            .where(and(
              eq(schema.repoCollaborators.repoId, query.repoId),
              or(
                like(schema.repoCollaborators.login, searchTerm),
                like(schema.repoCollaborators.name, searchTerm)
              )
            ))
            .orderBy(schema.repoCollaborators.login);
        }
      } catch (err) {
        console.error("GitHub user search failed:", err);
      }
    }
  } else {
    collaborators = await db.select().from(schema.repoCollaborators)
      .where(eq(schema.repoCollaborators.repoId, query.repoId))
      .orderBy(schema.repoCollaborators.login);
  }

  return c.json(collaborators.map(c => ({
    login: c.login,
    name: c.name,
    avatarUrl: c.avatarUrl,
    role: c.role,
  })));
});

// GET /api/repo-cache/teams - Get teams (with optional search)
repoCacheRouter.get("/teams", async (c) => {
  const query = validateOrThrow(searchSchema, {
    repoId: c.req.query("repoId"),
    q: c.req.query("q"),
  });

  let teams;
  if (query.q && query.q.length > 0) {
    const searchTerm = `%${query.q.toLowerCase()}%`;
    teams = await db.select().from(schema.repoTeams)
      .where(and(
        eq(schema.repoTeams.repoId, query.repoId),
        or(
          like(schema.repoTeams.slug, searchTerm),
          like(schema.repoTeams.name, searchTerm),
          like(schema.repoTeams.description, searchTerm)
        )
      ))
      .orderBy(schema.repoTeams.name);
  } else {
    teams = await db.select().from(schema.repoTeams)
      .where(eq(schema.repoTeams.repoId, query.repoId))
      .orderBy(schema.repoTeams.name);
  }

  return c.json(teams.map(t => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
  })));
});

// GET /api/repo-cache/has-teams - Check if repo has teams (is org repo)
repoCacheRouter.get("/has-teams", async (c) => {
  const repoId = c.req.query("repoId");
  if (!repoId) {
    throw new BadRequestError("repoId is required");
  }

  const [team] = await db.select().from(schema.repoTeams)
    .where(eq(schema.repoTeams.repoId, repoId))
    .limit(1);

  return c.json({ hasTeams: !!team });
});
