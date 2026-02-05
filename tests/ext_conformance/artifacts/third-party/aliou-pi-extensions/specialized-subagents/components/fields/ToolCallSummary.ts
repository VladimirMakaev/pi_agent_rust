import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { TruncatedText } from "@mariozechner/pi-tui";
import type { SubagentToolCall } from "../../lib/types";
import { pluralize } from "../../lib/ui/stats";
import type { ToolCallFormatter } from "./ToolCallList";

/**
 * Renders a one-line summary:
 *   7 tool calls: Read x3, Write x2, Bash x1, Edit x1
 */
export class ToolCallSummary implements Component {
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
    if (this.toolCalls.length === 0) return [];

    const th = this.theme;
    const toolNames = this.toolCalls.map((tc) => this.formatter(tc).label);
    const counts: Record<string, number> = {};
    for (const name of toolNames) {
      counts[name] = (counts[name] || 0) + 1;
    }
    const summary = Object.entries(counts)
      .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
      .join(", ");

    const prefix = `${this.toolCalls.length} ${pluralize(this.toolCalls.length, "tool call")}`;
    const line = new TruncatedText(th.fg("muted", `${prefix}: `) + summary);
    return line.render(width);
  }
}
