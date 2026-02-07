/**
 * Parser for AI-suggested ToDo updates
 *
 * Format:
 * <todo-update>
 *   <item action="complete" id="1" />
 *   <item action="add" status="pending">新しいタスク</item>
 *   <item action="update" id="2" status="in_progress" />
 *   <item action="delete" id="3" />
 * </todo-update>
 */

export interface TodoUpdateItem {
  action: "add" | "complete" | "update" | "delete";
  id?: number;
  title?: string;
  description?: string;
  status?: "pending" | "in_progress" | "completed";
}

export interface TodoUpdate {
  items: TodoUpdateItem[];
}

/**
 * Extract todo update suggestions from AI response content
 */
export function extractTodoUpdates(content: string): TodoUpdate | null {
  // Match <todo-update>...</todo-update>
  const todoUpdateMatch = content.match(
    /<todo-update>([\s\S]*?)<\/todo-update>/
  );
  if (!todoUpdateMatch) return null;

  const innerContent = todoUpdateMatch[1];
  const items: TodoUpdateItem[] = [];

  // Match <item ...>...</item> or <item ... />
  const itemRegex = /<item\s+([^>]*?)(?:\/>|>(.*?)<\/item>)/g;
  let match;

  while ((match = itemRegex.exec(innerContent)) !== null) {
    const attributes = match[1];
    const innerText = match[2]?.trim();

    // Parse attributes
    const actionMatch = attributes.match(/action="([^"]+)"/);
    const idMatch = attributes.match(/id="([^"]+)"/);
    const statusMatch = attributes.match(/status="([^"]+)"/);
    const descriptionMatch = attributes.match(/description="([^"]+)"/);

    if (!actionMatch) continue;

    const action = actionMatch[1] as TodoUpdateItem["action"];
    const item: TodoUpdateItem = { action };

    if (idMatch) {
      item.id = parseInt(idMatch[1], 10);
    }

    if (innerText) {
      item.title = innerText;
    }

    if (statusMatch) {
      const status = statusMatch[1];
      if (status === "pending" || status === "in_progress" || status === "completed") {
        item.status = status;
      }
    }

    if (descriptionMatch) {
      item.description = descriptionMatch[1];
    }

    // Validate item based on action
    if (action === "add" && item.title) {
      items.push(item);
    } else if ((action === "complete" || action === "update" || action === "delete") && item.id !== undefined) {
      items.push(item);
    }
  }

  if (items.length === 0) return null;

  return { items };
}

/**
 * Remove todo-update tags from content for display
 */
export function removeTodoUpdateTags(content: string): string {
  return content.replace(/<todo-update>[\s\S]*?<\/todo-update>/g, "").trim();
}
