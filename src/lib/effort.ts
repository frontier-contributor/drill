/* ============================================================================
 * effort.ts — what "low / medium / high" actually costs.
 *
 * Effort has been settable at three scopes since the settings panel was
 * written, resolved with full provenance by lib/resolveSetting.ts, and read by
 * nothing at all. A dial that turns and changes nothing is worse than no dial:
 * it makes you think you have tuned something.
 *
 * This is the one place that gives it meaning, so there is exactly one answer
 * to "what does high do". Three things move, and they are the three that
 * actually decide what a message costs:
 *
 *   how much of the conversation goes back up the wire
 *   how many memories are retrieved
 *   how long the reply is allowed to be
 *
 * A fourth follows from it: at low effort the app stops making the extra
 * follow-up-suggestion request entirely, because "cheap" should mean one
 * request, not one and a bit.
 * ========================================================================== */
import type { Effort } from "@/types/core";
import type { ChatMode } from "@/types/chat";

export interface EffortBudget {
  /** How many of the most recent turns are sent. Infinity sends the lot. */
  historyTurns: number;
  /** Cap on memories injected, overriding a memory source's own limit. */
  memoryLimit: number;
  /** Multiplier on the conversation's own maxTokens for the reply. */
  replyScale: number;
  /** Whether the second, cheaper follow-up request is worth making. */
  followups: boolean;
  /**
   * Rounds of tool use allowed in agent mode. START-HERE §2.2 named the effort
   * dial as where an agent loop would land, and this is that landing: the dial
   * already meant "how much is one message allowed to cost", and a round of
   * tool use is a whole request, so it belongs to the same budget as history
   * and reply length rather than to a switch of its own.
   *
   * Low is deliberately non-zero. One lookup is the difference between "I
   * cannot know what you studied" and an answer — cheap effort should still be
   * able to check one thing.
   */
  agentSteps: number;
  /**
   * One line for the chip's tooltip, in plain words.
   *
   * Says nothing about lookups. Effort is read by every mode, but `agentSteps`
   * only means something in agent and deep — a blurb that promised "up to
   * three lookups" while the thread was set to Direct was describing a budget
   * that could not be spent. The lookup sentence is appended by the chip,
   * which is the only place that knows the mode.
   */
  blurb: string;
}

export const EFFORT_BUDGETS: Record<Effort, EffortBudget> = {
  low: {
    historyTurns: 6,
    memoryLimit: 3,
    replyScale: 0.5,
    followups: false,
    agentSteps: 1,
    blurb: "Short memory, brief answers."
  },
  medium: {
    historyTurns: 24,
    memoryLimit: 8,
    replyScale: 1,
    followups: true,
    agentSteps: 3,
    blurb: "The working default: recent history, eight memories, full-length answers."
  },
  high: {
    historyTurns: Number.POSITIVE_INFINITY,
    memoryLimit: 16,
    replyScale: 2,
    followups: true,
    agentSteps: 6,
    blurb: "The whole conversation, twice the memory, room for a long answer. Costs the most."
  }
};

export const EFFORT_ORDER: Effort[] = ["low", "medium", "high"];

export function budgetFor(effort: Effort): EffortBudget {
  return EFFORT_BUDGETS[effort] || EFFORT_BUDGETS.medium;
}

/**
 * Deep mode's round allowance, derived from the reactive one.
 *
 * `2n + 2`, because writing the plan and closing each step are themselves
 * rounds — a plan that runs out of budget before its own last item is worse
 * than no plan, since it produces an answer that visibly skipped half of what
 * it promised. Lives here rather than in the mode picker so the number shown
 * on the chip and the number the loop is given cannot drift apart.
 */
export function deepSteps(agentSteps: number): number {
  return agentSteps * 2 + 2;
}

/**
 * What this effort buys *in the mode currently selected*, as one sentence.
 *
 * The two chips sit side by side in the composer and both look like cost
 * dials, so their relationship has to be stated somewhere or it reads as two
 * settings that might be fighting. They are not: effort sets the size of
 * everything, and the mode decides whether the lookup budget is one of the
 * things being sized.
 */
export function effortMeans(effort: Effort, mode: ChatMode): string {
  const b = budgetFor(effort);
  /* Image mode makes one request like Direct, but saying "no lookups" there
     would answer a question nobody asked: what effort buys when the reply is
     a picture is how much of the thread the model is reminded of, not how
     much it writes. */
  if (mode === "image") return b.blurb + " The picture's own shape and size are the two dials beside the composer.";
  if (mode === "direct") return b.blurb + " No lookups — Direct mode answers in one request.";
  const n = mode === "deep" ? deepSteps(b.agentSteps) : b.agentSteps;
  return `${b.blurb} In ${mode === "deep" ? "Deep" : "Agent"} mode it also sets the lookup budget: up to ${n}, each one a request.`;
}