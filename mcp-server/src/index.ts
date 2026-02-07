#!/usr/bin/env bun
import { runServer } from "./server";

runServer().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});
