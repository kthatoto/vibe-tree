/**
 * Parser for AI-suggested questions during planning
 *
 * Format:
 * <<QUESTION>>
 * <q branch="feat/auth">Question text here</q>
 * <q branch="feat/api" assumption="If using JWT">Another question</q>
 * <q>General question without branch</q>
 * <</QUESTION>>
 */

export interface QuestionItem {
  question: string;
  branchName?: string;
  assumption?: string;
}

export interface QuestionUpdate {
  items: QuestionItem[];
}

/**
 * Extract questions from AI response content
 */
export function extractQuestions(content: string): QuestionUpdate | null {
  // Match <<QUESTION>>...<</QUESTION>>
  const questionMatch = content.match(/<<QUESTION>>([\s\S]*?)<<\/QUESTION>>/);
  if (!questionMatch) return null;

  const innerContent = questionMatch[1];
  const items: QuestionItem[] = [];

  // Match <q ...>...</q>
  const qRegex = /<q\s*([^>]*)>([\s\S]*?)<\/q>/g;
  let match;

  while ((match = qRegex.exec(innerContent)) !== null) {
    const attributes = match[1];
    const questionText = match[2]?.trim();

    if (!questionText) continue;

    const branchMatch = attributes.match(/branch="([^"]+)"/);
    const assumptionMatch = attributes.match(/assumption="([^"]+)"/);

    const item: QuestionItem = {
      question: questionText,
    };

    if (branchMatch) {
      item.branchName = branchMatch[1];
    }

    if (assumptionMatch) {
      item.assumption = assumptionMatch[1];
    }

    items.push(item);
  }

  if (items.length === 0) return null;

  return { items };
}

/**
 * Remove question tags from content for display
 */
export function removeQuestionTags(content: string): string {
  return content.replace(/<<QUESTION>>[\s\S]*?<<\/QUESTION>>/g, "").trim();
}
