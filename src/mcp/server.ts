import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Import tool implementations
import {
  getContextSchema,
  getCurrentContext,
  getSessionSchema,
  getSessionInfo,
  updateSessionTitleSchema,
  updateSessionTitle,
  getInstructionSchema,
  getInstructionInfo,
  updateInstructionSchema,
  updateInstruction,
  getTodosSchema,
  getTodosList,
  addTodoSchema,
  addTodo,
  updateTodoSchema,
  updateTodo,
  completeTodoSchema,
  completeTodo,
  deleteTodoSchema,
  deleteTodo,
  addQuestionSchema,
  addQuestion,
  switchBranchSchema,
  switchBranch,
  markBranchCompleteSchema,
  markBranchComplete,
} from "./tools";

// Create MCP server
export function createServer() {
  const server = new Server(
    {
      name: "vibe-tree",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "get_current_context",
          description:
            "Get the current planning context including branch, instruction, todos, and questions",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "The planning session ID",
              },
              branchName: {
                type: "string",
                description:
                  "Specific branch name (defaults to current branch in session)",
              },
            },
            required: ["planningSessionId"],
          },
        },
        {
          name: "get_session",
          description: "Get session information including title, type, status, and branches",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "The planning session ID",
              },
            },
            required: ["planningSessionId"],
          },
        },
        {
          name: "update_session_title",
          description: "Update the session title",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "The planning session ID",
              },
              title: {
                type: "string",
                description: "New session title",
              },
            },
            required: ["planningSessionId", "title"],
          },
        },
        {
          name: "get_instruction",
          description: "Get the task instruction for a specific branch",
          inputSchema: {
            type: "object",
            properties: {
              repoId: {
                type: "string",
                description: "Repository ID (owner/repo format)",
              },
              branchName: {
                type: "string",
                description: "Branch name",
              },
            },
            required: ["repoId", "branchName"],
          },
        },
        {
          name: "update_instruction",
          description: "Update the task instruction for a branch. Parameters: repoId (owner/repo), branchName, instructionMd (Markdown content)",
          inputSchema: {
            type: "object",
            properties: {
              repoId: {
                type: "string",
                description: "Repository ID in owner/repo format (e.g. 'myorg/myrepo')",
              },
              branchName: {
                type: "string",
                description: "Git branch name (e.g. 'feat_123_feature_name')",
              },
              instructionMd: {
                type: "string",
                description: "Full instruction content in Markdown format",
              },
            },
            required: ["repoId", "branchName", "instructionMd"],
          },
        },
        {
          name: "get_todos",
          description: "Get all todo items for a specific branch",
          inputSchema: {
            type: "object",
            properties: {
              repoId: {
                type: "string",
                description: "Repository ID (owner/repo format)",
              },
              branchName: {
                type: "string",
                description: "Branch name",
              },
            },
            required: ["repoId", "branchName"],
          },
        },
        {
          name: "add_todo",
          description: "Add a new todo item. Required: repoId, branchName, title. Optional: description, planningSessionId",
          inputSchema: {
            type: "object",
            properties: {
              repoId: {
                type: "string",
                description: "Repository ID in owner/repo format",
              },
              branchName: {
                type: "string",
                description: "Git branch name",
              },
              title: {
                type: "string",
                description: "Todo item title (required)",
              },
              description: {
                type: "string",
                description: "Todo item description (optional)",
              },
              planningSessionId: {
                type: "string",
                description: "Planning session ID (optional)",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Initial status (default: pending)",
              },
            },
            required: ["repoId", "branchName", "title"],
          },
        },
        {
          name: "update_todo",
          description: "Update an existing todo item",
          inputSchema: {
            type: "object",
            properties: {
              todoId: {
                type: "number",
                description: "Todo ID",
              },
              title: {
                type: "string",
                description: "New title",
              },
              description: {
                type: "string",
                description: "New description",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "New status",
              },
            },
            required: ["todoId"],
          },
        },
        {
          name: "complete_todo",
          description: "Mark a todo as completed",
          inputSchema: {
            type: "object",
            properties: {
              todoId: {
                type: "number",
                description: "Todo ID to mark as completed",
              },
            },
            required: ["todoId"],
          },
        },
        {
          name: "delete_todo",
          description: "Delete a todo item",
          inputSchema: {
            type: "object",
            properties: {
              todoId: {
                type: "number",
                description: "Todo ID to delete",
              },
            },
            required: ["todoId"],
          },
        },
        {
          name: "add_question",
          description:
            "Add a question that needs to be answered during planning",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              branchName: {
                type: "string",
                description: "Branch name this question relates to",
              },
              question: {
                type: "string",
                description: "The question text",
              },
              assumption: {
                type: "string",
                description:
                  "What we are assuming if no answer is provided",
              },
            },
            required: ["planningSessionId", "question"],
          },
        },
        {
          name: "switch_branch",
          description: "Switch to a different branch in the execute session",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              branchName: {
                type: "string",
                description: "Specific branch name to switch to",
              },
              direction: {
                type: "string",
                enum: ["next", "previous", "specific"],
                description: "Direction to switch (if not specifying branchName)",
              },
            },
            required: ["planningSessionId"],
          },
        },
        {
          name: "mark_branch_complete",
          description:
            "Mark the current branch as complete and optionally advance to the next",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              autoAdvance: {
                type: "boolean",
                description: "Automatically advance to next branch",
                default: true,
              },
            },
            required: ["planningSessionId"],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "get_current_context": {
          const input = getContextSchema.parse(args);
          const result = getCurrentContext(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "get_session": {
          const input = getSessionSchema.parse(args);
          const result = getSessionInfo(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "update_session_title": {
          const input = updateSessionTitleSchema.parse(args);
          const result = updateSessionTitle(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "get_instruction": {
          const input = getInstructionSchema.parse(args);
          const result = getInstructionInfo(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "update_instruction": {
          const input = updateInstructionSchema.parse(args);
          const result = updateInstruction(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "get_todos": {
          const input = getTodosSchema.parse(args);
          const result = getTodosList(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "add_todo": {
          const input = addTodoSchema.parse(args);
          const result = addTodo(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "update_todo": {
          const input = updateTodoSchema.parse(args);
          const result = updateTodo(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "complete_todo": {
          const input = completeTodoSchema.parse(args);
          const result = completeTodo(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "delete_todo": {
          const input = deleteTodoSchema.parse(args);
          const result = deleteTodo(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "add_question": {
          const input = addQuestionSchema.parse(args);
          const result = addQuestion(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "switch_branch": {
          const input = switchBranchSchema.parse(args);
          const result = switchBranch(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "mark_branch_complete": {
          const input = markBranchCompleteSchema.parse(args);
          const result = markBranchComplete(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function runServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] vibe-tree server started");
}
