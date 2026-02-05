import type { Tracer } from "@opentelemetry/api";

export type TelemetryOtelRuntimeHandle = {
  tracer: Tracer;
  shutdown: () => Promise<void>;
};

export const RUNTIME_REGISTRY_SYMBOL = Symbol.for("pi.telemetry-otel.runtimeRegistry.v1");

type Registry = Map<string, TelemetryOtelRuntimeHandle>;

function getRegistry(): Registry {
  const globalAny = globalThis as unknown as { [RUNTIME_REGISTRY_SYMBOL]?: Registry };
  if (!globalAny[RUNTIME_REGISTRY_SYMBOL]) {
    globalAny[RUNTIME_REGISTRY_SYMBOL] = new Map();
  }
  return globalAny[RUNTIME_REGISTRY_SYMBOL]!;
}

export function registerTelemetryRuntime(sessionId: string, runtime: TelemetryOtelRuntimeHandle): void {
  getRegistry().set(sessionId, runtime);
}

export function unregisterTelemetryRuntime(sessionId: string): void {
  getRegistry().delete(sessionId);
}

export function getTelemetryRuntime(sessionId: string): TelemetryOtelRuntimeHandle | undefined {
  return getRegistry().get(sessionId);
}
