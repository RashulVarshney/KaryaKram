import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@karyakram/llm';
import { startTestDatabase, type TestDatabase } from '../../db/test/testcontainers';
import { defineWorkflow } from '../src/authoring';
import { createSupportToolRegistry } from '../src/examples/supportTools';
import { sendSignal } from '../src/sendSignal';
import { startWorkflow } from '../src/startWorkflow';
import { audit, llmReq, sleep, startCluster, waitForEventType, type Cluster } from './llmHarness';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const flow = defineWorkflow<{ topic: string }, string>('wf-spans', async (input, ctx) => {
  const a = await ctx.llmCall(llmReq(`classify ${input.topic}`, { mockOutput: 'billing' }));
  await ctx.toolCall('lookup_customer', { customerId: 'c-1' });
  await ctx.waitForSignal('go');
  return a.text;
});

describe('llm_call / tool_call spans', () => {
  let db: TestDatabase;
  let cluster: Cluster | null = null;

  beforeAll(async () => {
    provider.register();
    db = await startTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await provider.shutdown();
    await db.stop();
  });
  beforeEach(async () => {
    await db.truncateAll();
    exporter.reset();
  });
  afterEach(async () => {
    await cluster?.stop();
    cluster = null;
  });

  it('emits one live span per step with model/tokens/latency/cost/attempt, plus replayed=true spans on replays', async () => {
    cluster = startCluster(db.pool, {
      provider: new MockProvider({ audit: audit(db.pool), latencyMs: 7 }),
      workflows: [flow],
      registry: createSupportToolRegistry(),
    });
    const id = await startWorkflow(db.pool, flow, { topic: 'invoice' });
    await waitForEventType(db.pool, id, 'TOOL_COMPLETED');
    for (let i = 0; i < 3; i++) {
      await sendSignal(db.pool, id, 'noise', { i }); // each triggers a replay that passes over both steps
      await sleep(100);
    }

    const spans = exporter.getFinishedSpans();
    const llm = spans.filter((s) => s.name === 'llm_call');
    const tool = spans.filter((s) => s.name === 'tool_call');

    const liveLlm = llm.filter((s) => s.attributes['replayed'] === false);
    expect(liveLlm).toHaveLength(1);
    expect(liveLlm[0]?.attributes).toMatchObject({
      'llm.model': 'mock-1',
      'llm.latency_ms': 7,
      attempt: 1,
      'step.id': 'llm-0',
      'workflow.id': id,
    });
    expect(Number(liveLlm[0]?.attributes['llm.tokens_in'])).toBeGreaterThan(0);
    expect(Number(liveLlm[0]?.attributes['llm.tokens_out'])).toBeGreaterThan(0);
    expect(Number(liveLlm[0]?.attributes['llm.cost_usd'])).toBeGreaterThan(0);

    const replayedLlm = llm.filter((s) => s.attributes['replayed'] === true);
    expect(replayedLlm.length).toBeGreaterThanOrEqual(3);
    expect(replayedLlm[0]?.attributes['llm.model']).toBe('mock-1');

    const liveTool = tool.filter((s) => s.attributes['replayed'] === false);
    expect(liveTool).toHaveLength(1);
    expect(liveTool[0]?.attributes).toMatchObject({ 'tool.name': 'lookup_customer', attempt: 1 });
    expect(tool.filter((s) => s.attributes['replayed'] === true).length).toBeGreaterThanOrEqual(3);
  });
});
