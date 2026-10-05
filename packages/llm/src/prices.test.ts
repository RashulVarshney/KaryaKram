import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE_TABLE, estimateCostUsd, loadPriceTable } from './prices';

describe('price table', () => {
  it('computes cost per million tokens', () => {
    // mock-1 is 1 USD in / 2 USD out per MTok
    expect(estimateCostUsd('mock-1', 1_000_000, 500_000, DEFAULT_PRICE_TABLE)).toBeCloseTo(2, 10);
  });

  it('returns null — not zero — for an unknown model', () => {
    expect(estimateCostUsd('nope', 10, 10, DEFAULT_PRICE_TABLE)).toBeNull();
  });

  it('lets KARYAKRAM_LLM_PRICES add and override entries', () => {
    const table = loadPriceTable({
      KARYAKRAM_LLM_PRICES:
        '{"mock-1":{"inputPerMTokUsd":10,"outputPerMTokUsd":10},"x":{"inputPerMTokUsd":1,"outputPerMTokUsd":1}}',
    });
    expect(estimateCostUsd('mock-1', 1_000_000, 0, table)).toBe(10);
    expect(estimateCostUsd('x', 1_000_000, 0, table)).toBe(1);
    expect(table['claude-opus-5-5']).toBeDefined();
  });
});
