export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Defaults. `mock-1` is a synthetic price so cost plumbing can be tested
 * without a network; it is not a real rate. The Claude rates are the
 * Anthropic list prices as of 2026-09-25 and WILL drift — override the
 * whole table with KARYAKRAM_LLM_PRICES (JSON) rather than trusting these.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  'mock-1': { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
  'claude-opus-5-5': { inputPerMTokUsd: 4, outputPerMTokUsd: 20 },
  'claude-sonnet-5-5': { inputPerMTokUsd: 2, outputPerMTokUsd: 10 },
  'claude-haiku-4-5': { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
};

export function loadPriceTable(env: NodeJS.ProcessEnv = process.env): PriceTable {
  const raw = env['KARYAKRAM_LLM_PRICES'];
  if (!raw) return DEFAULT_PRICE_TABLE;
  const parsed = JSON.parse(raw) as PriceTable;
  return { ...DEFAULT_PRICE_TABLE, ...parsed };
}

/** `null` when the model isn't in the table — an unknown price is not a zero price. */
export function estimateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  table: PriceTable,
): number | null {
  const price = table[model];
  if (!price) return null;
  return (tokensIn * price.inputPerMTokUsd + tokensOut * price.outputPerMTokUsd) / 1_000_000;
}
