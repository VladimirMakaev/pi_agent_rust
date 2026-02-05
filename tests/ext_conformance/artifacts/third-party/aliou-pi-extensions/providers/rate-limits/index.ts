import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ProviderRateLimits } from "../types";
import { fetchClaudeRateLimits } from "./claude";
import { fetchCodexRateLimits } from "./codex";
import { fetchOpencodeRateLimits } from "./opencode";
import { fetchOpenRouterRateLimits } from "./openrouter";

export async function fetchAllProviderRateLimits(
  authStorage: AuthStorage,
  signal?: AbortSignal,
): Promise<ProviderRateLimits[]> {
  const [claude, codex, opencode, openrouter] = await Promise.all([
    fetchClaudeRateLimits(authStorage, signal),
    fetchCodexRateLimits(authStorage, signal),
    fetchOpencodeRateLimits(signal),
    fetchOpenRouterRateLimits(authStorage, "openrouter", "OpenRouter", signal),
  ]);
  return [claude, codex, opencode, openrouter];
}
