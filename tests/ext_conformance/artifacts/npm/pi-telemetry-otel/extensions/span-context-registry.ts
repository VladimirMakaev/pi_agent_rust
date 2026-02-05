import type { SpanContextLike } from "../lib/trace-env";

/**
 * Holds the currently active span context for a given pi session.
 *
 * This is intentionally stored on globalThis under a Symbol.for key so that
 * multiple copies / versions of this package can share the same registry.
 */
export const ACTIVE_SPAN_CONTEXT_REGISTRY_SYMBOL = Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1");

type Registry = Map<string, SpanContextLike>;

function getRegistry(): Registry {
  const globalAny = globalThis as unknown as { [ACTIVE_SPAN_CONTEXT_REGISTRY_SYMBOL]?: Registry };
  if (!globalAny[ACTIVE_SPAN_CONTEXT_REGISTRY_SYMBOL]) {
    globalAny[ACTIVE_SPAN_CONTEXT_REGISTRY_SYMBOL] = new Map();
  }
  return globalAny[ACTIVE_SPAN_CONTEXT_REGISTRY_SYMBOL]!;
}

export function setActiveSpanContext(sessionId: string, spanContext: SpanContextLike): void {
  getRegistry().set(sessionId, spanContext);
}

export function clearActiveSpanContext(sessionId: string): void {
  getRegistry().delete(sessionId);
}

export function getActiveSpanContext(sessionId: string): SpanContextLike | undefined {
  return getRegistry().get(sessionId);
}
