/**
 * Claude API pricing (USD per million tokens) and cost math.
 *
 * These are ESTIMATES taken from Anthropic's published list prices (the
 * claude-api reference, 2026-10-06); check anthropic.com/pricing. Cache
 * writes are priced at 1.25x input (5-minute TTL), cache reads as listed.
 *
 * The API's `input_tokens` already EXCLUDES cache reads and cache writes, so
 * the four token counts are simply priced separately and added. Nothing is
 * subtracted.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPrice extends Rates {
  label: string;
  /** Higher rates for prompts above `threshold` tokens (Haiku 5.5). */
  longContext?: Rates & { threshold: number };
  /** Rates we could not confirm from a published source. */
  unverified?: string;
  legacy?: boolean;
}

const CACHE_WRITE_MULT = 1.25;

function rates(input: number, output: number, cacheRead: number): Rates {
  return { input, output, cacheRead, cacheWrite: input * CACHE_WRITE_MULT };
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  'claude-opus-5-5': { label: 'Opus 5.5', ...rates(4, 20, 0.2), unverified: 'cache write (1.25x input) assumed' },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5', ...rates(2, 10, 0.2), unverified: 'cache write (1.25x input) assumed' },
  'claude-haiku-5-5': {
    label: 'Haiku 5.5',
    ...rates(0.1, 0.5, 0.01),
    longContext: { threshold: 100_000, ...rates(0.5, 2.5, 0.05) },
    unverified: 'cache read (0.1x input) and cache write (1.25x input) assumed',
  },
  // Legacy models, kept so old usage records are priced correctly.
  'claude-opus-4-6': { label: 'Opus 4.6', ...rates(5, 25, 0.5), legacy: true },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6', ...rates(3, 15, 0.3), legacy: true },
  'claude-haiku-4-5': { label: 'Haiku 4.5', ...rates(1, 5, 0.1), legacy: true },
};

/** Look up a model's price; accepts a dated snapshot ID. Unknown → null (never a guess). */
export function priceFor(model: string): ModelPrice | null {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const undated = model.replace(/-\d{8}$/, '');
  return MODEL_PRICING[undated] ?? null;
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Cost of ONE API response (one round). Returns null when the model's price
 * is unknown. For a multi-round tool loop, sum the per-round costs.
 */
export function calculateCost(model: string, usage: TokenUsage): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const input = n(usage.inputTokens);
  const output = n(usage.outputTokens);
  const cacheRead = n(usage.cacheReadTokens);
  const cacheWrite = n(usage.cacheWriteTokens);
  const promptTokens = input + cacheRead + cacheWrite;
  const r: Rates = price.longContext && promptTokens > price.longContext.threshold ? price.longContext : price;
  return (input * r.input + output * r.output + cacheRead * r.cacheRead + cacheWrite * r.cacheWrite) / 1_000_000;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + n(b.inputTokens),
    outputTokens: a.outputTokens + n(b.outputTokens),
    cacheReadTokens: a.cacheReadTokens + n(b.cacheReadTokens),
    cacheWriteTokens: a.cacheWriteTokens + n(b.cacheWriteTokens),
  };
}

/** Map an SDK `usage` object to our shape. */
export function usageFromApi(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
} | null | undefined): TokenUsage {
  return {
    inputTokens: n(u?.input_tokens),
    outputTokens: n(u?.output_tokens),
    cacheReadTokens: n(u?.cache_read_input_tokens),
    cacheWriteTokens: n(u?.cache_creation_input_tokens),
  };
}

/** The table shown in the usage panel. */
export function pricingTable(): { model: string; label: string; input: number; output: number; cacheRead: number; cacheWrite: number; note?: string; legacy?: boolean }[] {
  return Object.entries(MODEL_PRICING).map(([model, p]) => ({
    model,
    label: p.label,
    input: p.input,
    output: p.output,
    cacheRead: p.cacheRead,
    cacheWrite: p.cacheWrite,
    note: [
      p.longContext ? `above ${p.longContext.threshold / 1000}K-token prompts: $${p.longContext.input} / $${p.longContext.output}` : '',
      p.unverified ?? '',
    ].filter(Boolean).join('; ') || undefined,
    legacy: p.legacy,
  }));
}
