# vibe-tree MCP Server

MCP (Model Context Protocol) server for vibe-tree. This allows Claude Code to directly interact with vibe-tree's database for managing tasks, instructions, todos, and questions.

## Installation

```bash
cd mcp-server
bun install
```

## Configuration

Add the following to your Claude Code MCP settings (`~/.config/claude-code/settings.json`):

```json
{
  "mcpServers": {
    "vibe-tree": {
      "command": "bun",
      "args": ["run", "/path/to/vibe-tree/mcp-server/src/index.ts"],
      "env": {
        "VIBE_TREE_DB": "/path/to/.vibetree/vibetree.sqlite",
        "VIBE_TREE_API": "http://localhost:3000"
      }
    }
  }
}
```

## Environment Variables

- `VIBE_TREE_DB`: Path to the SQLite database file
- `VIBE_TREE_API`: URL of the vibe-tree API server (for WebSocket notifications)

## Available Tools

### Context

- `get_current_context` - Get the current planning context including branch, instruction, todos, and questions

### Instructions

- `update_instruction` - Update the task instruction for a branch

### Todos

- `add_todo` - Add a new todo item to a branch
- `update_todo` - Update an existing todo item
- `complete_todo` - Mark a todo as completed
- `delete_todo` - Delete a todo item

### Questions

- `add_question` - Add a question that needs to be answered during planning

### Branch Operations

- `switch_branch` - Switch to a different branch in the execute session
- `mark_branch_complete` - Mark the current branch as complete and optionally advance to the next

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  vibe-tree (Existing)                                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Frontend    │◄───│  Hono API    │◄───│  SQLite DB   │  │
│  │  (React)     │    │  Server      │    │              │  │
│  └──────────────┘    └──────────────┘    └───────┬──────┘  │
│         ▲                    ▲                    │         │
│         │ WebSocket          │ HTTP broadcast     │         │
└─────────┼────────────────────┼────────────────────┼─────────┘
          │                    │                    │
          │              ┌─────┴─────┐              │
          │              │ MCP Server │◄─────────────┘
          │              │ (STDIO)    │ DB access
          │              └─────┬─────┘
          │                    │
          └────────────────────┼────────────────────
                         ┌─────┴─────┐
                         │ Claude    │
                         │ Code      │
                         └───────────┘
```

## Development

```bash
# Run in development mode with hot reload
bun run dev

# Run directly
bun run start
```

Note: MCP servers run via STDIO, so `console.log` is not available. Use `console.error` for debugging.
