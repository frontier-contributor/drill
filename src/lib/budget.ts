/* ============================================================================
 * budget.ts — how many tokens a one-shot operation may spend, and what to
 * change when that was not enough.
 *
 * Every structured call in services/ai used to pass one fixed number as
 * max_tokens — 2,400 for a weekly rollup, 1,200 for /remember, 512 for marking
 * a recall — and nothing else. Those numbers were sized for a model that starts
 * writing immediately. A model that reasons first spends the same budget on its
 * scratchpad, and what comes back is an empty reply with finish_reason
 * "length". The weekly rollup failed that way every single time, on exactly the
 * free reasoning models OpenRouter's own notes steer people towards.
 *
 * Two decisions, made here and nowhere else:
 *
 *   How much room.  The answer's own size, plus room to think when the model is
 *   known to think. A ceiling is not a bill — providers charge for what was
 *   written, not for what was allowed — so headroom costs nothing on a reply
 *   that did not need it. It is still capped, because some providers refuse a
 *   max_tokens above the model's own output limit, and that refusal is a 400
 *   whose wording reads like "this conversation is too long".
 *
 *   What to change on the second try.  Only what the first try gave evidence
 *   for. Reasoning is turned down only when the first reply actually reasoned,
 *   because on a hybrid model that does not think by default — Claude through
 *   OpenRouter is the common one — the same parameter turns thinking *on*, and
 *   guessing wrong there makes a cheap call dearer and slower. It is the rule
 *   lib/thinking.ts follows: act on what is known, never on a model's name.
 *
 * Pure: no fetch, no stores. services/ai/structured.ts runs the attempts.
 * ========================================================================== */
import type { BackendType, ReasoningEffort } from "@/types";
import type { ThinkingVerdict } from "@/lib/thinking";

/** Room to think, on top of the answer, for a model the catalogue says reasons. */
const THINKING_ROOM = 4096;
/** Ceiling on the first attempt when the model's own limit is not known. */
const UNKNOWN_CEILING = 8192;
/** And on the second. Most current models accept this much output; one that
 *  does not says so, which is at least an honest failure. */
const UNKNOWN_RETRY_CEILING = 16384;

export interface BudgetInput {
  /** What the visible answer needs — the number each call used to pass as
   *  max_tokens on its own. */
  answerTokens: number;
  /** Whether the model reasons, as lib/thinking.ts reads the catalogue. */
  verdict: ThinkingVerdict;
  backend: BackendType;
  /** The most the model will write in one reply, when the catalogue says. */
  maxOutput?: number;
  /** 1 for the first try, 2 for the one recovery after running out of room. */
  attempt: 1 | 2;
  /** The first try came back having reasoned — a reasoning trace, a reasoning
   *  token count, or a <think> block. Evidence, where the verdict is a lookup. */
  sawReasoning?: boolean;
}

export interface BudgetPlan {
  maxTokens: number;
  /** OpenRouter's reasoning control. Absent means "leave the model's default". */
  reasoning?: { effort: ReasoningEffort };
  /** Ollama's thinking switch. Absent means "leave the model's default". */
  think?: boolean;
}

export function planBudget(input: BudgetInput): BudgetPlan {
  const answer = Math.max(1, Math.round(input.answerTokens));
  const room = firstRoom(answer, input.verdict);

  if (input.attempt === 1) return clamp({ maxTokens: room }, answer, input.maxOutput, UNKNOWN_CEILING);

  const plan: BudgetPlan = { maxTokens: room * 2 };
  if (input.sawReasoning) {
    /* "low" rather than "none" or "minimal": a model whose reasoning is
       mandatory rejects "none", and "minimal" is not a level every reasoning
       family accepts. "low" is understood by all of them. Groq and the custom
       backend get room and no dial — Groq returns a 400 for a reasoning
       parameter on a model that has none, and the custom backend is whatever
       server it was pointed at (see lib/chatActions.ts). */
    if (input.backend === "openrouter") plan.reasoning = { effort: "low" };
    if (input.backend === "ollama") plan.think = false;
  }
  return clamp(plan, answer, input.maxOutput, UNKNOWN_RETRY_CEILING);
}

function firstRoom(answer: number, verdict: ThinkingVerdict): number {
  if (verdict === "yes") return answer + Math.max(THINKING_ROOM, answer * 2);
  /* The catalogue says this model does not take a reasoning parameter, so the
     number the call was written with is the right one. */
  if (verdict === "no") return answer;
  /* Not known: most of what this covers is local and Groq models, where a
     reasoning model is exactly what people run. Modest room, not a gamble. */
  return Math.max(answer * 2, answer + 1024);
}

function clamp(plan: BudgetPlan, answer: number, maxOutput: number | undefined, ceiling: number): BudgetPlan {
  const limit = maxOutput && maxOutput > 0 ? maxOutput : ceiling;
  /* The answer's own size is the floor — unless the model cannot write that
     much at all, in which case asking for more is a request it will refuse. */
  plan.maxTokens = Math.max(Math.min(plan.maxTokens, limit), Math.min(answer, limit));
  return plan;
}

/** A second attempt that would send the same request is not a retry, it is the
 *  same failure paid for twice. */
export function samePlan(a: BudgetPlan, b: BudgetPlan): boolean {
  return (
    a.maxTokens === b.maxTokens &&
    (a.reasoning?.effort ?? null) === (b.reasoning?.effort ?? null) &&
    (a.think ?? null) === (b.think ?? null)
  );
}

/** "7,200 tokens, thinking turned down to low" — for the error that names what
 *  was tried. Formatted by hand so the wording does not depend on the locale. */
export function describePlan(plan: BudgetPlan): string {
  const n = String(plan.maxTokens).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (
    `${n} tokens` +
    (plan.reasoning ? `, thinking turned down to ${plan.reasoning.effort}` : "") +
    (plan.think === false ? ", thinking off" : "")
  );
}

/**
 * A reply that ran out of room — empty, or nothing but reasoning — as opposed
 * to one that failed for any other reason.
 *
 * A class rather than a sentence to match on: structured.ts has to tell this
 * apart from a rejected key or a dropped connection, and wording is not an
 * interface. backends.ts throws it; nothing else needs to know it exists.
 */
export class ReplyCutOff extends Error {
  readonly finish: string | undefined;
  readonly reasoned: boolean;

  constructor(message: string, finish: string | undefined, reasoned: boolean) {
    super(message);
    this.name = "ReplyCutOff";
    this.finish = finish;
    this.reasoned = reasoned;
  }
}
