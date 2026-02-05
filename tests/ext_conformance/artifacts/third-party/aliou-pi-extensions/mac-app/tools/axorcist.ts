import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { runCommand } from "../utils";

export type MatchType =
  | "exact"
  | "contains"
  | "regex"
  | "containsAny"
  | "prefix"
  | "suffix";

export interface CriterionInput {
  attribute: string;
  value: string;
  matchType?: MatchType;
}

export interface AxorcRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsed?: unknown;
}

export function buildLocator(
  criteria: CriterionInput[],
  matchAll?: boolean,
): {
  criteria: { attribute: string; value: string; match_type?: MatchType }[];
  match_all?: boolean;
} {
  return {
    criteria: criteria.map((criterion) => ({
      attribute: criterion.attribute,
      value: criterion.value,
      match_type: criterion.matchType,
    })),
    match_all: matchAll,
  };
}

export async function runAxorc(
  payload: Record<string, unknown>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<AxorcRunResult> {
  const input = `${JSON.stringify(payload)}\n`;
  const result = await runCommand("axorc", ["--stdin"], ctx.cwd, signal, input);
  const output = result.stdout.trim();
  let parsed: unknown;

  if (output) {
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = undefined;
    }
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed,
  };
}
