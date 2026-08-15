import { context, propagation, trace, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TracingHandle {
  tracer: Tracer;
  shutdown: () => Promise<void>;
}

/**
 * Configures one Node tracer provider per process, exporting via OTLP/HTTP
 * to Jaeger (`docker/docker-compose.yml`'s `observability` profile). Every
 * process (worker, scheduler, api, bench) calls this the same way instead
 * of repeating SDK setup — see docs/07-observability.md.
 */
export function startTracing(serviceName: string, otlpEndpoint?: string): TracingHandle {
  const exporter = new OTLPTraceExporter({
    url:
      otlpEndpoint ??
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
      'http://localhost:4318/v1/traces',
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();

  return {
    tracer: trace.getTracer(serviceName),
    shutdown: () => provider.shutdown(),
  };
}

/**
 * Serializes the currently active span's context into a plain string
 * (W3C `traceparent` format) so it can be stored in `tasks.trace_context`
 * — the only way to carry trace identity across the process boundary
 * between `enqueue()` and a later `dequeue()`, since there's no shared
 * call stack to ride on. Returns `null` if there's no active span (e.g.
 * a task enqueued outside any span — a legitimate, expected state).
 */
export function injectTraceContext(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier['traceparent'] ?? null;
}

/**
 * The inverse of `injectTraceContext`: rebuilds a Context from a stored
 * `traceparent` string so a worker can start its execution span as a
 * child of the original trace instead of a disconnected new one.
 */
export function extractTraceContext(traceContext: string | null) {
  if (!traceContext) return context.active();
  return propagation.extract(context.active(), { traceparent: traceContext });
}

/** Runs `fn` inside a span that's a child of `parentContext`, ending it however `fn` settles. */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  parentContext: ReturnType<typeof context.active>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return context.with(parentContext, () =>
    tracer.startActiveSpan(name, async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    }),
  );
}
