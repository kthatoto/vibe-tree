import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

const DB_DIR = path.join(process.cwd(), ".vibetree");
const DB_PATH = path.join(DB_DIR, "vibetree.sqlite");

// Ensure .vibetree directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite, { schema });

export { schema };

// One-time migration: set type for existing planning sessions
// based on title pattern (Planning: prefix = "planning", otherwise "refinement")
try {
  sqlite.exec(`
    UPDATE planning_sessions
    SET type = CASE
      WHEN title LIKE 'Planning:%' THEN 'planning'
      ELSE 'refinement'
    END
    WHERE type IS NULL OR type = '' OR type NOT IN ('refinement', 'planning', 'execute')
  `);
} catch {
  // Ignore if type column doesn't exist yet (will be created on first db:push)
}
