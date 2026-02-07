// Parse instruction edit suggestions from AI messages

const INSTRUCTION_EDIT_REGEX = /<<INSTRUCTION_EDIT>>([\s\S]*?)<<\/INSTRUCTION_EDIT>>/;
const INSTRUCTION_EDIT_REGEX_GLOBAL = /<<INSTRUCTION_EDIT>>([\s\S]*?)<<\/INSTRUCTION_EDIT>>/g;

export interface InstructionEdit {
  newContent: string;
}

export function extractInstructionEdit(content: string): InstructionEdit | null {
  const match = content.match(INSTRUCTION_EDIT_REGEX);
  if (!match) return null;

  return {
    newContent: match[1].trim(),
  };
}

export function removeInstructionEditTags(content: string): string {
  return content.replace(INSTRUCTION_EDIT_REGEX_GLOBAL, "").trim();
}

// Simple diff: split by lines and compare
export interface DiffLine {
  type: "unchanged" | "added" | "removed";
  content: string;
}

export function computeSimpleDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const lcs = longestCommonSubsequence(oldLines, newLines);

  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (lcsIdx < lcs.length && oldIdx < oldLines.length && oldLines[oldIdx] === lcs[lcsIdx]) {
      // This line is in the common subsequence
      while (newIdx < newLines.length && newLines[newIdx] !== lcs[lcsIdx]) {
        result.push({ type: "added", content: newLines[newIdx] });
        newIdx++;
      }
      result.push({ type: "unchanged", content: oldLines[oldIdx] });
      oldIdx++;
      newIdx++;
      lcsIdx++;
    } else if (oldIdx < oldLines.length) {
      result.push({ type: "removed", content: oldLines[oldIdx] });
      oldIdx++;
    } else if (newIdx < newLines.length) {
      result.push({ type: "added", content: newLines[newIdx] });
      newIdx++;
    }
  }

  return result;
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const lcs: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}
