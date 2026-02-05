import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { TruncatedText } from "@mariozechner/pi-tui";
import type { SubagentToolCall } from "../../lib/types";
import { INDICATOR } from "../../lib/ui/spinner";
import type { ToolCallFormatter } from "./ToolCallList";

/**
 * Renders only failed tool calls:
 *   [x] Edit src/broken.ts
 *   [x] Bash npm test
 */
export class FailedToolCalls implements Component {
  constructor(
    private toolCalls: SubagentToolCall[],
    private formatter: ToolCallFormatter,
    private theme: Theme,
  ) {}

  handleInput(_data: string): boolean {
    return false;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const failed = this.toolCalls.filter((tc) => tc.status === "error");
    if (failed.length === 0) return [];

    const th = this.theme;
    const lines: string[] = [];
    for (const tc of failed) {
      const { label, detail } = this.formatter(tc);
      const text = detail ? `${th.bold(label)} ${detail}` : th.bold(label);
      const line = new TruncatedText(
        `${th.fg("error", INDICATOR.error)} ${text}`,
      );
      lines.push(...line.render(width));
    }
    return lines;
  }
}
