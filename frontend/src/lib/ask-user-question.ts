// AskUserQuestion tag-based types and parser

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

export interface AskUserQuestionData {
  questions: AskUserQuestion[];
}

// Tag regex for <<ASK_USER_QUESTION>>...<</ASK_USER_QUESTION>>
const ASK_TAG_REGEX = /<<ASK_USER_QUESTION>>([\s\S]*?)<<\/ASK_USER_QUESTION>>/g;

// Extract AskUserQuestion from text content (tag-based format)
export function extractAskUserQuestionFromText(text: string): AskUserQuestionData | null {
  const matches = text.match(ASK_TAG_REGEX);
  if (!matches || matches.length === 0) return null;

  // Take the last match (most recent question)
  const match = matches[matches.length - 1];
  const jsonContent = match
    .replace(/<<ASK_USER_QUESTION>>/, "")
    .replace(/<<\/ASK_USER_QUESTION>>/, "")
    .trim();

  try {
    const parsed = JSON.parse(jsonContent) as {
      questions?: unknown[];
    };

    if (!parsed.questions || !Array.isArray(parsed.questions)) {
      return null;
    }

    return {
      questions: parsed.questions.map((q: unknown) => {
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
  } catch {
    console.error("[AskUserQuestion] Failed to parse JSON:", jsonContent);
    return null;
  }
}

// Remove ASK_USER_QUESTION tags from text
export function removeAskUserQuestionTags(text: string): string {
  // Match both formats: <</TAG>> and </TAG>>
  const regex = /<<ASK_USER_QUESTION>>[\s\S]*?<<\/ASK_USER_QUESTION>>/g;
  return text.replace(regex, "").trim();
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
