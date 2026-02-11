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
  acknowledgeAnswerSchema,
  acknowledgeAnswer,
  getPendingAnswersSchema,
  getPendingAnswers,
  getFocusedBranchSchema,
  getFocusedBranch,
  setFocusedBranchSchema,
  setFocusedBranch,
  switchBranchSchema,
  switchBranch,
  markBranchCompleteSchema,
  markBranchComplete,
  // Branch resource tools
  getSessionLinksSchema,
  getSessionLinks,
  addBranchLinkSchema,
  addBranchLink,
  listBranchLinksSchema,
  listBranchLinks,
  removeBranchLinkSchema,
  removeBranchLink,
  saveImageToBranchSchema,
  saveImageToBranch,
  listBranchFilesSchema,
  listBranchFiles,
  // Refinement task tools
  getRefinementTasksSchema,
  getRefinementTasks,
  addRefinementTaskSchema,
  addRefinementTask,
  updateRefinementTaskSchema,
  updateRefinementTask,
  deleteRefinementTaskSchema,
  deleteRefinementTask,
  reorderRefinementTasksSchema,
  reorderRefinementTasks,
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
          name: "acknowledge_answer",
          description: "Mark an answered question as acknowledged/consumed. Call this after reading and incorporating a user's answer into your work.",
          inputSchema: {
            type: "object",
            properties: {
              questionId: {
                type: "number",
                description: "ID of the question to acknowledge",
              },
            },
            required: ["questionId"],
          },
        },
        {
          name: "get_pending_answers",
          description: "Get answered questions that haven't been acknowledged yet. Use this to find answers you need to incorporate.",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              branchName: {
                type: "string",
                description: "Filter by branch name (optional)",
              },
            },
            required: ["planningSessionId"],
          },
        },
        {
          name: "get_focused_branch",
          description: "Get the currently focused branch in a planning session. Returns: focusedBranch, focusedIndex, allBranches",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
            },
            required: ["planningSessionId"],
          },
        },
        {
          name: "set_focused_branch",
          description: "Change the focused branch to a specific branch. Required: planningSessionId, branchName",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              branchName: {
                type: "string",
                description: "Branch name to focus on",
              },
            },
            required: ["planningSessionId", "branchName"],
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
        // Branch resource tools
        {
          name: "get_session_links",
          description:
            "Get all external links (Figma, Notion, GitHub, etc.) attached to a planning session. Use this to see what links are available to attach to branches.",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
            },
            required: ["planningSessionId"],
          },
        },
        {
          name: "add_branch_link",
          description:
            "Add an external link (Figma, Notion, GitHub, etc.) to a branch. Use this to associate reference materials with specific tasks.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: {
                type: "string",
                description: "Repository ID (owner/repo format)",
              },
              branchName: {
                type: "string",
                description: "Branch name to attach the link to",
              },
              url: {
                type: "string",
                description: "URL of the external link",
              },
              title: {
                type: "string",
                description: "Title of the link (optional)",
              },
              description: {
                type: "string",
                description: "Description or note about the link (optional)",
              },
            },
            required: ["repoId", "branchName", "url"],
          },
        },
        {
          name: "list_branch_links",
          description: "List all external links attached to a branch",
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
          name: "remove_branch_link",
          description: "Remove an external link from a branch",
          inputSchema: {
            type: "object",
            properties: {
              linkId: {
                type: "number",
                description: "Link ID to remove",
              },
            },
            required: ["linkId"],
          },
        },
        {
          name: "save_image_to_branch",
          description:
            "Save a base64 encoded image to a branch. Use this to attach screenshots, Figma exports, or other images to specific tasks.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: {
                type: "string",
                description: "Repository ID (owner/repo format)",
              },
              branchName: {
                type: "string",
                description: "Branch name to attach the image to",
              },
              imageData: {
                type: "string",
                description: "Base64 encoded image data",
              },
              originalName: {
                type: "string",
                description: "Original file name (e.g., 'design.png')",
              },
              description: {
                type: "string",
                description: "Description of the image (optional)",
              },
              sourceUrl: {
                type: "string",
                description:
                  "Original URL if from external source like Figma (optional)",
              },
            },
            required: ["repoId", "branchName", "imageData", "originalName"],
          },
        },
        {
          name: "list_branch_files",
          description: "List all files (images, etc.) attached to a branch",
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
        // Refinement task tools
        {
          name: "get_refinement_tasks",
          description:
            "Get all tasks in a refinement session. Tasks are ordered serially (each depends on the previous one).",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
            },
            required: ["planningSessionId"],
          },
        },
        {
          name: "add_refinement_task",
          description:
            "Add a new task to the refinement session. Tasks are added to the end and automatically connected in serial order.",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              title: {
                type: "string",
                description: "Task title",
              },
              description: {
                type: "string",
                description: "Task description (optional)",
              },
              branchName: {
                type: "string",
                description: "Branch name (auto-generated if omitted)",
              },
              issueUrl: {
                type: "string",
                description: "GitHub issue URL to link (optional)",
              },
            },
            required: ["planningSessionId", "title"],
          },
        },
        {
          name: "update_refinement_task",
          description: "Update an existing task in the refinement session",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              taskId: {
                type: "string",
                description: "Task ID to update",
              },
              title: {
                type: "string",
                description: "New task title",
              },
              description: {
                type: "string",
                description: "New task description",
              },
              branchName: {
                type: "string",
                description: "New branch name",
              },
              issueUrl: {
                type: "string",
                description: "New GitHub issue URL",
              },
            },
            required: ["planningSessionId", "taskId"],
          },
        },
        {
          name: "delete_refinement_task",
          description: "Delete a task from the refinement session",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              taskId: {
                type: "string",
                description: "Task ID to delete",
              },
            },
            required: ["planningSessionId", "taskId"],
          },
        },
        {
          name: "reorder_refinement_tasks",
          description:
            "Reorder tasks in the refinement session. Provide all task IDs in the new order.",
          inputSchema: {
            type: "object",
            properties: {
              planningSessionId: {
                type: "string",
                description: "Planning session ID",
              },
              taskIds: {
                type: "array",
                items: { type: "string" },
                description: "Task IDs in new order",
              },
            },
            required: ["planningSessionId", "taskIds"],
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

        case "acknowledge_answer": {
          const input = acknowledgeAnswerSchema.parse(args);
          const result = acknowledgeAnswer(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "get_pending_answers": {
          const input = getPendingAnswersSchema.parse(args);
          const result = getPendingAnswers(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "get_focused_branch": {
          const input = getFocusedBranchSchema.parse(args);
          const result = getFocusedBranch(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "set_focused_branch": {
          const input = setFocusedBranchSchema.parse(args);
          const result = setFocusedBranch(input);
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

        // Branch resource tools
        case "get_session_links": {
          const input = getSessionLinksSchema.parse(args);
          const result = getSessionLinks(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "add_branch_link": {
          const input = addBranchLinkSchema.parse(args);
          const result = addBranchLink(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "list_branch_links": {
          const input = listBranchLinksSchema.parse(args);
          const result = listBranchLinks(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "remove_branch_link": {
          const input = removeBranchLinkSchema.parse(args);
          const result = removeBranchLink(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "save_image_to_branch": {
          const input = saveImageToBranchSchema.parse(args);
          const result = saveImageToBranch(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "list_branch_files": {
          const input = listBranchFilesSchema.parse(args);
          const result = listBranchFiles(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        // Refinement task tools
        case "get_refinement_tasks": {
          const input = getRefinementTasksSchema.parse(args);
          const result = getRefinementTasks(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "add_refinement_task": {
          const input = addRefinementTaskSchema.parse(args);
          const result = addRefinementTask(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "update_refinement_task": {
          const input = updateRefinementTaskSchema.parse(args);
          const result = updateRefinementTask(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "delete_refinement_task": {
          const input = deleteRefinementTaskSchema.parse(args);
          const result = deleteRefinementTask(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "reorder_refinement_tasks": {
          const input = reorderRefinementTasksSchema.parse(args);
          const result = reorderRefinementTasks(input);
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
