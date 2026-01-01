export interface TaskSuggestion {
  label: string;
  description: string;
  parentLabel?: string; // Optional parent task label for hierarchy
  branchName?: string; // Optional branch name suggestion
}

const TASK_REGEX = /<<TASK>>([\s\S]*?)<<\/TASK>>/g;

export function extractTaskSuggestions(content: string): TaskSuggestion[] {
  const suggestions: TaskSuggestion[] = [];
  let match;

  while ((match = TASK_REGEX.exec(content)) !== null) {
    try {
      const json = match[1].trim();
      const parsed = JSON.parse(json);
      if (parsed.label && typeof parsed.label === "string") {
        suggestions.push({
          label: parsed.label,
          description: parsed.description || "",
          parentLabel: parsed.parent || undefined,
          branchName: parsed.branch || undefined,
        });
      }
    } catch {
      // Invalid JSON, skip this suggestion
    }
  }

  // Reset regex lastIndex for future calls
  TASK_REGEX.lastIndex = 0;

  return suggestions;
}

export function removeTaskTags(content: string): string {
  return content.replace(TASK_REGEX, "").trim();
}

export function hasTaskSuggestions(content: string): boolean {
  const result = TASK_REGEX.test(content);
  TASK_REGEX.lastIndex = 0;
  return result;
}
