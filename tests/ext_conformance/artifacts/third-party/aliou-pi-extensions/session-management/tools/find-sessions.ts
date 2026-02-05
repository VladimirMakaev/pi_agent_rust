/**
 * Find Sessions tool - search past Pi sessions by keyword with optional filters.
 *
 * Uses ripgrep-based search for efficient scanning across session files.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  type SearchOptions,
  type SessionSearchResult,
  searchSessions,
} from "../lib/session-search";

const FindSessionsParams = Type.Object({
  query: Type.String({
    description: "Keyword to search for in sessions",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Filter to sessions from this working directory",
    }),
  ),
  after: Type.Optional(
    Type.String({
      description:
        "Filter to sessions modified after this date (ISO or relative: '7d', '2w', '1m')",
    }),
  ),
  before: Type.Optional(
    Type.String({
      description:
        "Filter to sessions modified before this date (ISO or relative: '7d', '2w', '1m')",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Maximum number of sessions to return (default: 10)",
      minimum: 1,
      maximum: 100,
    }),
  ),
});

type FindSessionsParamsType = {
  query: string;
  cwd?: string;
  after?: string;
  before?: string;
  limit?: number;
};

interface FindSessionsDetails {
  query: string;
  filters: {
    cwd?: string;
    after?: string;
    before?: string;
    limit?: number;
  };
  resultCount: number;
  results: SessionSearchResult[];
}

type ExecuteResult = AgentToolResult<FindSessionsDetails>;

export const FIND_SESSIONS_GUIDANCE = `
## find_sessions

Use find_sessions when the user explicitly asks to find or search for a previous session or conversation.

**When to use:**
- User asks to find a past conversation ("find the session where we discussed X")
- User wants to locate sessions by topic, date, or project

**When NOT to use:**
- Questions about the current session
- General codebase search (use lookout/grep)
`;

/**
 * Setup the find_sessions tool for discovering sessions by keyword.
 */
export function setupFindSessionsTool(pi: ExtensionAPI) {
  pi.registerTool<typeof FindSessionsParams, FindSessionsDetails>({
    name: "find_sessions",
    label: "Find Sessions",
    description: `Search through past Pi coding sessions by keyword or phrase.

WHEN TO USE:
- Locate previous sessions by topic ("database", "auth", "bug fix")
- Find sessions from a specific project directory
- Search sessions within a date range
- Retrieve recent work to continue from

RESULTS: Returns matching sessions with metadata including name, directory, date, and matched snippet.
Uses fast keyword search (ripgrep) across 2000+ session files.`,

    parameters: FindSessionsParams,

    async execute(
      _toolCallId: string,
      params: FindSessionsParamsType,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<ExecuteResult> {
      const { query, cwd, after, before, limit } = params;

      // Get current session ID to filter it out
      const currentSessionId = ctx.sessionManager.getSessionId();

      // Build search options
      const searchOpts: SearchOptions = {
        query,
        cwd,
        after,
        before,
        limit: limit || 10,
      };

      // Execute search
      let results: SessionSearchResult[] = [];
      try {
        results = await searchSessions(searchOpts);
        // Filter out current session - users searching for sessions want to find other sessions, not the one they're in
        results = results.filter((r) => r.id !== currentSessionId);
      } catch (err) {
        console.error("[find-sessions] Search error:", err);
        // Return empty results rather than failing
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                query,
                resultCount: 0,
                results: [],
                error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          details: {
            query,
            filters: { cwd, after, before, limit },
            resultCount: 0,
            results: [],
          },
        };
      }

      // Format result for LLM
      const resultJson = JSON.stringify({
        query,
        resultCount: results.length,
        results: results.map((r) => ({
          id: r.id,
          path: r.path,
          cwd: r.cwd,
          name: r.name,
          created: r.created,
          modified: r.modified,
          messageCount: r.messageCount,
          firstMessage: r.firstMessage,
          matchedSnippet: r.matchedSnippet,
        })),
      });

      return {
        content: [{ type: "text", text: resultJson }],
        details: {
          query,
          filters: { cwd, after, before, limit },
          resultCount: results.length,
          results,
        },
      };
    },

    renderCall(args: FindSessionsParamsType, theme: Theme): Text {
      let text = theme.fg("toolTitle", theme.bold("find_sessions"));
      text += ` ${theme.fg("accent", `"${args.query}"`)}`;

      const filters: string[] = [];
      if (args.cwd) filters.push(`cwd: ${args.cwd}`);
      if (args.after) filters.push(`after: ${args.after}`);
      if (args.before) filters.push(`before: ${args.before}`);
      if (args.limit) filters.push(`limit: ${args.limit}`);

      if (filters.length > 0) {
        text += ` [${filters.join(", ")}]`;
      }

      return new Text(text, 0, 0);
    },

    renderResult(
      result: AgentToolResult<FindSessionsDetails>,
      _options: ToolRenderResultOptions,
      theme: Theme,
    ): Text {
      const { details } = result;

      if (!details) {
        const text = result.content[0];
        const content = text?.type === "text" ? text.text : "No result";
        return new Text(content, 0, 0);
      }

      const { query, resultCount, results } = details;

      if (resultCount === 0) {
        return new Text(
          theme.fg("muted", `No sessions found matching "${query}"`),
          0,
          0,
        );
      }

      // Format results for display
      const lines: string[] = [
        theme.fg(
          "success",
          `Found ${resultCount} session${resultCount === 1 ? "" : "s"} matching "${query}"`,
        ),
      ];

      for (const session of results.slice(0, 5)) {
        // Show first 5 results
        const name = session.name ? ` (${session.name})` : "";
        const date = new Date(session.modified).toLocaleDateString();
        const msgCount = `${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`;

        lines.push(
          theme.fg(
            "muted",
            `  • ${session.id.slice(0, 8)}${name} - ${date} - ${msgCount}`,
          ),
        );

        if (session.firstMessage) {
          const preview =
            session.firstMessage.length > 60
              ? `${session.firstMessage.slice(0, 60)}...`
              : session.firstMessage;
          lines.push(theme.fg("muted", `    "${preview}"`));
        }
      }

      if (resultCount > 5) {
        lines.push(theme.fg("muted", `  ... and ${resultCount - 5} more`));
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
