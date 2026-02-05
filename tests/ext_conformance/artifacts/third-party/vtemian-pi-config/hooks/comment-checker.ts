/**
 * Comment Checker Hook
 *
 * Analyzes edited code for unnecessary comments (explains what, not why).
 * Appends warnings to Edit tool results.
 */

import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";

// Patterns that indicate excessive/unnecessary comments
const EXCESSIVE_COMMENT_PATTERNS = [
  /\/\/\s*(increment|decrement|add|subtract|set|get|return|call|create|initialize|init)\s+/i,
  /\/\/\s*(the|this|a|an)\s+(following|above|below|next|previous)/i,
  /\/\/\s*[-=]{3,}/,
  /\/\/\s*#{3,}/,
  /\/\/\s*$/,
  /\/\/\s*end\s+(of|function|class|method|if|loop|for|while)/i,
];

const VALID_COMMENT_PATTERNS = [
  /\/\/\s*(TODO|FIXME|NOTE|HACK|XXX|BUG|WARN):/i,
  /^\s*\*|\/\*\*/,
  /\/\/\s*@|\/\/\s*eslint|\/\/\s*prettier|\/\/\s*ts-|\/\/\s*type:/i,
  /\/\/\s*(copyright|license|spdx)/i,
  /\/\/\s*(given|when|then|and|but|describe|it|should|expect)/i,
  /\/\/\s*https?:\/\//i,
  /\/\/\s*regex|\/\/\s*pattern/i,
];

interface CommentIssue {
  line: number;
  comment: string;
  reason: string;
}

function analyzeComments(content: string): CommentIssue[] {
  const issues: CommentIssue[] = [];
  const lines = content.split("\n");

  let consecutiveComments = 0;
  let lastCommentLine = -2;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      if (VALID_COMMENT_PATTERNS.some((p) => p.test(trimmed))) continue;

      for (const pattern of EXCESSIVE_COMMENT_PATTERNS) {
        if (pattern.test(trimmed)) {
          issues.push({
            line: i + 1,
            comment: trimmed.slice(0, 60) + (trimmed.length > 60 ? "..." : ""),
            reason: "Explains what, not why",
          });
          break;
        }
      }

      if (i === lastCommentLine + 1) {
        consecutiveComments++;
        if (consecutiveComments > 5) {
          issues.push({ line: i + 1, comment: trimmed.slice(0, 60), reason: "Excessive consecutive comments" });
        }
      } else {
        consecutiveComments = 1;
      }
      lastCommentLine = i;
    }
  }

  return issues;
}

export default function (pi: HookAPI) {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit") return undefined;

    const newString = (event.input as { new_string?: string }).new_string;
    if (!newString) return undefined;

    const issues = analyzeComments(newString);
    if (issues.length === 0) return undefined;

    const warning = `\n\n[Comment Check] Found ${issues.length} potentially unnecessary comment(s):\n${issues
      .slice(0, 3)
      .map((i) => `- Line ${i.line}: "${i.comment}" (${i.reason})`)
      .join("\n")}${issues.length > 3 ? `\n...and ${issues.length - 3} more` : ""}\n\nComments should explain WHY, not WHAT.`;

    const textContent = event.content.find((c) => c.type === "text");
    if (textContent && "text" in textContent) {
      return {
        content: [
          ...event.content.filter((c) => c !== textContent),
          { type: "text" as const, text: textContent.text + warning },
        ],
      };
    }

    return undefined;
  });
}
