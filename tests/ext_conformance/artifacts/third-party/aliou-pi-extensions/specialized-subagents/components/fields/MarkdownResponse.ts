import type { Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import type { Component, MarkdownTheme } from "@mariozechner/pi-tui";
import { Markdown, Text } from "@mariozechner/pi-tui";

/**
 * Renders:
 *   ──────────────── (full-width dynamic border)
 *   (empty line)
 *   <markdown content>
 *   (empty line)
 */
export class MarkdownResponse implements Component {
  private border: DynamicBorder;
  private md: Markdown | null = null;
  private cachedTheme: MarkdownTheme | null = null;

  constructor(
    private content: string,
    theme: Theme,
  ) {
    this.border = new DynamicBorder((s) => theme.fg("muted", s));
  }

  handleInput(_data: string): boolean {
    return false;
  }

  /**
   * Updates the content. If a cached Markdown exists, updates it via setText
   * instead of creating a new instance.
   */
  setContent(content: string): void {
    this.content = content;
    if (this.md) {
      this.md.setText(content);
    }
  }

  invalidate(): void {
    this.md?.invalidate();
  }

  render(width: number): string[] {
    if (!this.content) return [];

    const lines: string[] = [];

    lines.push(...this.border.render(width));
    lines.push("");

    try {
      // Cache the theme, call getMarkdownTheme() only once
      if (!this.cachedTheme) {
        this.cachedTheme = getMarkdownTheme();
      }

      // Create Markdown instance only on first render, reuse on subsequent renders
      if (!this.md) {
        this.md = new Markdown(this.content, 0, 0, this.cachedTheme);
      }

      lines.push(...this.md.render(width));
    } catch {
      const text = new Text(this.content, 0, 0);
      lines.push(...text.render(width));
    }

    lines.push("");
    return lines;
  }
}
