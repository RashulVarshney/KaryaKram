import { context, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractTraceContext, injectTraceContext } from './tracing';

describe('trace context round-trip', () => {
  const provider = new NodeTracerProvider();

  beforeAll(() => {
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  it('returns null with no active span', () => {
    expect(injectTraceContext()).toBeNull();
  });

  it('serializes the active span as a traceparent string, and extracting it recovers the same trace id', () => {
    const tracer = trace.getTracer('test');
    let captured: string | null = null;
    let originalTraceId = '';

    tracer.startActiveSpan('root', (span) => {
      originalTraceId = span.spanContext().traceId;
      captured = injectTraceContext();
      span.end();
    });

    expect(captured).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

    const extracted = extractTraceContext(captured);
    const spanContext = trace.getSpanContext(extracted);
    expect(spanContext?.traceId).toBe(originalTraceId);
  });

  it('falls back to the active context when given null', () => {
    const extracted = extractTraceContext(null);
    expect(extracted).toBe(context.active());
  });
});
