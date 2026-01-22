// AskUserQuestion tool types and parser

export interface AskUserQuestionOption {
  label: string;
  description: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionTool {
  questions: AskUserQuestion[];
}

// Extract AskUserQuestion from tool_use chunks
export function extractAskUserQuestion(
  chunks: Array<{ type: string; toolName?: string; toolInput?: Record<string, unknown> }>
): AskUserQuestionTool | null {
  for (const chunk of chunks) {
    if (chunk.type === "tool_use" && chunk.toolName === "AskUserQuestion" && chunk.toolInput) {
      const input = chunk.toolInput as { questions?: unknown[] };
      if (input.questions && Array.isArray(input.questions)) {
        return {
          questions: input.questions.map((q: unknown) => {
            const question = q as {
              question?: string;
              header?: string;
              multiSelect?: boolean;
              options?: Array<{ label?: string; description?: string }>;
            };
            return {
              question: question.question || "",
              header: question.header || "",
              multiSelect: question.multiSelect || false,
              options: (question.options || []).map((opt) => ({
                label: opt.label || "",
                description: opt.description || "",
              })),
            };
          }),
        };
      }
    }
  }
  return null;
}

// Format answers for sending back to Claude
export function formatAnswers(
  questions: AskUserQuestion[],
  selections: Map<number, Set<string>>,
  otherInputs: Map<number, string>
): string {
  const lines: string[] = [];

  questions.forEach((q, index) => {
    const selected = selections.get(index) || new Set();
    const otherInput = otherInputs.get(index) || "";

    lines.push(`【${q.header}】`);

    if (selected.size === 0 && !otherInput) {
      lines.push("  (回答なし)");
    } else {
      const answers: string[] = [];

      // Add selected options
      q.options.forEach((opt) => {
        if (selected.has(opt.label)) {
          answers.push(opt.label);
        }
      });

      // Add "other" input if present
      if (otherInput) {
        answers.push(`その他: ${otherInput}`);
      }

      answers.forEach((a) => lines.push(`  - ${a}`));
    }

    lines.push("");
  });

  return lines.join("\n");
}
