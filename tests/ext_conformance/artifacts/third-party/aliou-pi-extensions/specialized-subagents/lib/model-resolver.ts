/**
 * Model resolution helper for subagents.
 *
 * All subagents use OpenRouter exclusively. Resolution is a direct lookup
 * by model ID + provider.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PROVIDER } from "./constants";

/**
 * Find a model by ID from OpenRouter.
 *
 * @param modelId - OpenRouter model ID (e.g., "anthropic/claude-haiku-4.5")
 * @param ctx - Extension context with modelRegistry
 * @returns The resolved model
 * @throws Error if model not found or OpenRouter API key not configured
 */
export function resolveModel(
  modelId: string,
  ctx: ExtensionContext,
  // biome-ignore lint/suspicious/noExplicitAny: Model type requires any for generic API
): Model<any> {
  const available = ctx.modelRegistry.getAvailable();
  const model = available.find(
    (m) => m.id === modelId && m.provider === PROVIDER,
  );

  if (model) {
    return model;
  }

  // Check if the model exists but the API key is missing
  const all = ctx.modelRegistry.getAll();
  const existsWithoutKey = all.some(
    (m) => m.id === modelId && m.provider === PROVIDER,
  );

  if (existsWithoutKey) {
    throw new Error(
      `Model "${modelId}" exists on OpenRouter but no valid API key is configured. Set the OPENROUTER_API_KEY environment variable.`,
    );
  }

  throw new Error(`Model "${modelId}" not found on OpenRouter.`);
}
