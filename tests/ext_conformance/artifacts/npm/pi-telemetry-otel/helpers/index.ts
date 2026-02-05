import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Attributes, type Span, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { getActiveSpanContext } from "../extensions/span-context-registry";
import { getTelemetryRuntime, type TelemetryOtelRuntimeHandle } from "../extensions/runtime-registry";
import {
  TRACE_CONTEXT_ENTRY_TYPE,
  isValidSpanId,
  isValidTraceId,
  readParentSpanContext,
  readParentSpanContextFromEntries,
  type SpanContextLike,
} from "../lib/trace-env";

export interface StartPiSpanOptions {
  /** Initial span attributes. */
  attributes?: Attributes;
  /** Explicit parent span context. When omitted, uses the current pi active span context. */
  parentSpanContext?: SpanContextLike;
  /** Start time (unix ms) or hr-time depending on OTEL impl. */
  startTime?: number;
}

function getSessionId(ctx: ExtensionContext): string | undefined {
  return "getSessionId" in ctx.sessionManager ? ctx.sessionManager.getSessionId() : undefined;
}

/**
 * Returns the telemetry-otel runtime handle for the current pi session (if the telemetry extension is loaded).
 */
export function getPiTelemetryRuntime(ctx: ExtensionContext): TelemetryOtelRuntimeHandle | undefined {
  const sessionId = getSessionId(ctx);
  if (!sessionId) return undefined;
  return getTelemetryRuntime(sessionId);
}

/** Returns the OTEL tracer registered by telemetry-otel for this session (if available). */
export function getPiTracer(ctx: ExtensionContext) {
  return getPiTelemetryRuntime(ctx)?.tracer;
}

/**
 * Get the best available span context to parent child spans under.
 *
 * Preference order:
 * 1) Per-session active span context registry (race-free for in-process concurrency)
 * 2) Session entry trace context (in-process sub-sessions)
 * 3) Env vars PI_AGENT_TRACE_ID / PI_AGENT_SPAN_ID (cross-process propagation)
 */
export function getPiActiveSpanContext(ctx: ExtensionContext): SpanContextLike | undefined {
  const sessionId = getSessionId(ctx);
  const fromRegistry = sessionId ? getActiveSpanContext(sessionId) : undefined;
  if (fromRegistry) return fromRegistry;

  const entries = ctx.sessionManager.getEntries?.() ?? [];
  return readParentSpanContextFromEntries(entries) ?? readParentSpanContext();
}

/**
 * Start a new span as a child of the currently active pi span.
 *
 * Returns undefined if telemetry-otel is not loaded (no tracer runtime registered).
 */
export function startPiSpan(ctx: ExtensionContext, name: string, options: StartPiSpanOptions = {}): Span | undefined {
  const tracer = getPiTracer(ctx);
  if (!tracer) return undefined;

  const parentSpanContext = options.parentSpanContext ?? getPiActiveSpanContext(ctx);
  const parentContext = parentSpanContext ? trace.setSpanContext(context.active(), parentSpanContext) : context.active();

  return tracer.startSpan(
    name,
    {
      attributes: options.attributes,
      startTime: options.startTime,
    },
    parentContext,
  );
}

/**
 * Convenience helper: creates a child span, runs `fn`, records errors, and ends the span.
 */
export async function withPiSpan<T>(
  ctx: ExtensionContext,
  name: string,
  fn: (span: Span | undefined) => Promise<T> | T,
  options: StartPiSpanOptions = {},
): Promise<T> {
  const span = startPiSpan(ctx, name, options);
  try {
    return await fn(span);
  } catch (error) {
    if (span) {
      span.recordException(error as any);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    span?.end();
  }
}

/**
 * Capture the current trace/span IDs for correlation or sub-session propagation.
 */
export function capturePiTraceContext(ctx: ExtensionContext): { traceId: string; spanId: string } | undefined {
  const sc = getPiActiveSpanContext(ctx);
  if (!sc) return undefined;
  if (!isValidTraceId(sc.traceId) || !isValidSpanId(sc.spanId)) return undefined;
  return { traceId: sc.traceId, spanId: sc.spanId };
}

/**
 * Inject current trace context into another SessionManager-like object (in-process sub-sessions).
 */
export function injectPiTraceContextEntry(
  ctx: ExtensionContext,
  sessionManager: { appendCustomEntry: (customType: string, data: unknown) => void },
  options: { serviceName?: string } = {},
): void {
  const captured = capturePiTraceContext(ctx);
  if (!captured) return;

  sessionManager.appendCustomEntry(TRACE_CONTEXT_ENTRY_TYPE, {
    traceId: captured.traceId,
    spanId: captured.spanId,
    serviceName: options.serviceName,
  });
}
