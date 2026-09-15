/* ============================================================================
 * tokens.ts — approximate token counting and cost.
 *
 * There is no tokeniser here on purpose: shipping tiktoken would add a wasm
 * blob and a per-model vocabulary for a number that only has to be good
 * enough to answer "am I about to blow the context window" and "roughly what
 * has this conversation cost". Everything derived from these is labelled as
 * an estimate in the UI.
 *
 * The heuristic: BPE lands near 4 characters per token on English prose and
 * closer to 3 on code and symbol-dense maths, so weight by how much
 * non-alphabetic material is in the string.
 * ========================================================================== */
import type { Turn, Usage } from "@/types/chat";
import type { ModelPrice } from "@/types/chat";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const symbols = (text.match(/[^A-Za-z0-9\s]/g) || []).length;
  const density = symbols / Math.max(chars, 1);
  // 4.0 chars/token for prose, sliding to ~2.8 for symbol-heavy text
  const perToken = 4 - Math.min(density, 0.5) * 2.4;
  return Math.max(1, Math.ceil(chars / perToken));
}

/** A picture, roughly. Providers bill an image by its area — about 750 pixels
 *  a token is the published rule of thumb — and cap what one image can cost,
 *  because anything bigger is downscaled on arrival. With no size known, a
 *  typical screenshot. */
export function estimateImageTokens(dims?: { w: number; h: number }): number {
  if (!dims || !dims.w || !dims.h) return 1000;
  return Math.max(85, Math.min(1600, Math.ceil((dims.w * dims.h) / 750)));
}

export function estimateTurnTokens(turns: Turn[]): number {
  let n = 0;
  for (const t of turns) {
    const v = t.variants[t.active];
    if (v) n += estimateTokens(v.content);
    for (const a of t.attachments || []) n += a.kind === "image" ? estimateImageTokens(a.dims) : estimateTokens(a.text);
    n += 4; // per-message framing overhead
  }
  return n;
}

/** USD for one exchange, when pricing for the model is known. */
export function costOf(usage: Usage | undefined, price: ModelPrice | undefined): number | undefined {
  if (!usage || !price) return undefined;
  return (usage.promptTokens / 1e6) * price.prompt + (usage.completionTokens / 1e6) * price.completion;
}

/** Money is only meaningful to a few significant figures at these scales;
 *  sub-cent amounts get more decimals so they do not all read "$0.00". */
export function formatCost(usd: number | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "$" + usd.toFixed(4);
  if (usd < 1) return "$" + usd.toFixed(3);
  return "$" + usd.toFixed(2);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(1) + "M";
}

export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cost: a.cost == null && b.cost == null ? undefined : (a.cost || 0) + (b.cost || 0)
  };
}
