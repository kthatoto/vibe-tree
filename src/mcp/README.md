# vibe-tree MCP Server

MCP (Model Context Protocol) server for vibe-tree. This allows Claude Code to directly interact with vibe-tree's database for managing tasks, instructions, todos, and questions.

## Usage

The MCP server is integrated into vibe-tree. Run it with:

```bash
bun run mcp
```

## Claude Code Configuration

Add the following to your Claude Code MCP settings:

**For user-level settings** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "vibe-tree": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/path/to/vibe-tree",
      "env": {
        "VIBE_TREE_DB": "/path/to/.vibetree/vibetree.sqlite",
        "VIBE_TREE_API": "http://localhost:3000"
      }
    }
  }
}
```

**For project-level settings** (`.claude/settings.json` in your project):

```json
{
  "mcpServers": {
    "vibe-tree": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/path/to/vibe-tree",
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
│  vibe-tree                                                  │
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

## Note

MCP servers communicate via STDIO, so `console.log` outputs are not visible. Use `console.error` for debugging.
