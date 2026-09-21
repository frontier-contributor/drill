/* ============================================================================
 * reasoning.ts — the model's own working, and what is kept of it.
 *
 * A reasoning model emits two streams: the scratchpad it thinks in and the
 * answer it settles on. Providers disagree about where the first one hangs off
 * a response and about whether you get it at all — Anthropic and DeepSeek send
 * the real chain, OpenAI's o-series sends a summary of it or nothing, and a
 * model that reasons internally may report only a token count. So there are
 * three states, not two, and the third is the interesting one: *we know it
 * thought and we cannot show you what it thought*. Rounding that down to "no
 * thinking" would be the app claiming a model answered off the cuff when it
 * spent nine seconds and fourteen hundred tokens not doing that.
 *
 * Nothing here reaches the network or the DOM. The phrasing lives here so the
 * live panel and the saved one cannot word the same fact differently.
 * ========================================================================== */
import { formatTokens } from "./tokens";

/**
 * How much of one chain goes on the record.
 *
 * A conversation is one IndexedDB record rewritten whole on every message, so
 * every character kept here is paid for again on each subsequent send. A long
 * chain runs to twenty thousand characters and the middle of it is where a
 * model restates what it already said, so the cap keeps both ends and elides
 * the middle rather than truncating: the opening is the framing and the close
 * is the conclusion, and losing the close would drop the half that explains
 * the answer.
 */
export const REASONING_CAP = 8000;

export interface CappedReasoning {
  text: string;
  /** True when the middle was dropped, so the panel can say so rather than
   *  presenting a spliced chain as a whole one. */
  clipped: boolean;
}

/** Back up to the nearest whitespace, so an elision never cuts a word in
 *  half. Gives up after a short look — a chain with no spaces in 200
 *  characters is code or a hash, and a hard cut is right for those. */
function backUp(s: string, at: number): number {
  for (let i = at; i > at - 200 && i > 0; i--) if (/\s/.test(s[i])) return i;
  return at;
}
function forwardTo(s: string, at: number): number {
  for (let i = at; i < at + 200 && i < s.length; i++) if (/\s/.test(s[i])) return i + 1;
  return at;
}

/**
 * Cap one chain for storage, keeping both ends.
 *
 * The invariant that matters is that the result never exceeds `cap`: this is
 * the only thing standing between a reasoning model and an unbounded record,
 * and the marker counts against the budget rather than being added on top.
 */
export function capReasoning(raw: string, cap: number = REASONING_CAP): CappedReasoning {
  const text = raw.trim();
  if (text.length <= cap) return { text, clipped: false };

  const dropped = text.length - cap;
  const marker = `\n\n⋯ ${formatTokens(dropped)} characters of working elided ⋯\n\n`;
  const room = cap - marker.length;
  /* Degenerate cap — smaller than the marker itself. Fall back to a plain
     head, because a "both ends" cap with no room for either end is worse than
     an honest truncation. */
  if (room < 200) return { text: text.slice(0, Math.max(0, cap - 1)) + "…", clipped: true };

  const headWant = Math.floor(room * 0.6);
  const head = text.slice(0, backUp(text, headWant)).trimEnd();
  const tail = text.slice(forwardTo(text, text.length - (room - head.length))).trimStart();
  return { text: head + marker + tail, clipped: true };
}

/**
 * The one line a finished chain collapses to.
 *
 * Deliberately says "Thought", not "Reasoned" or "Thinking complete": it is
 * the word every person already uses for this, and the panel it heads is read
 * at a glance or not at all. A duration with no token count is still worth
 * saying — a local model reports no usage and "Thought for 4s" is true.
 */
export function thoughtLabel(ms?: number, tokens?: number): string {
  let out: string;
  if (ms == null) out = "Thought before answering";
  else if (ms < 1500) out = "Thought for a moment";
  else if (ms < 60000) out = `Thought for ${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  else {
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    out = `Thought for ${m}m${s ? ` ${s}s` : ""}`;
  }
  if (tokens) out += ` · ${formatTokens(tokens)} tokens`;
  return out;
}

/** Live, before the answer starts. The counter is the honest version of a
 *  progress bar: we do not know how long this will take or what stage it is
 *  at, and inventing stage names for a stream we cannot see would be the app
 *  making things up about its own model. */
export function thinkingLabel(ms: number): string {
  if (ms < 1500) return "Thinking";
  if (ms < 60000) return `Thinking · ${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  return `Thinking · ${m}m ${Math.floor((ms % 60000) / 1000)}s`;
}
