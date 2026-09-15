/* ============================================================================
 * rememberArg.ts — "/remember <fact>", read without asking a model.
 *
 * The slash command used to throw its argument away. `/remember I prefer the
 * intuition before the formula` ran an extraction pass over the conversation
 * instead, which usually found nothing durable and said so — so the one
 * sentence the learner had typed specifically to be remembered was the one
 * thing guaranteed not to be. On the empty chat screen it did nothing at all.
 *
 * A fact typed after /remember is the plainest case of START-HERE §2.4's one
 * exception: the learner stated it, so it is saved as `stated` and commits
 * under the default autonomy. The type is a best guess from the wording. That
 * is enough, because the type only sets a retrieval weight and the receipt
 * makes it one click to fix — spending a request to classify one sentence
 * would be the wrong trade.
 * ========================================================================== */
import type { MemoryScope, MemoryType } from "@/types/core";

export interface RememberArg {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
}

/** Null when there is nothing after the command worth saving. */
export function parseRememberArg(arg: string): RememberArg | null {
  let text = String(arg || "").trim();
  let scope: MemoryScope = "project";
  /* Project is the default because almost everything said in a project is
     about that project; a fact true everywhere has to say so. */
  const g = /^(global|everywhere)\s*:\s*/i.exec(text);
  if (g) {
    scope = "global";
    text = text.slice(g[0].length);
  }
  /* "remember that I…" is how people say it; the memory is the part after. */
  text = text.replace(/^that\b\s*/i, "").trim();
  if (text.length < 3) return null;
  return { scope, type: guessType(text), text };
}

/**
 * The memory type a sentence reads as. Ordered, because the categories overlap
 * in wording: "I'm trying to learn X by December" is a goal before it is a
 * statement about who someone is, and "I don't understand why…" is an open
 * question before it is a preference.
 */
export function guessType(text: string): MemoryType {
  const t = text.toLowerCase().trim();
  if (/https?:\/\/\S+/.test(t)) return "reference";
  if (/\b(my goal|goal is|i want to|i('m| am) (aiming|trying|planning) to|i aim to|i plan to|by the end of|deadline)\b/.test(t)) {
    return "goal";
  }
  if (
    /\?$/.test(t) ||
    /\b(not sure (why|how|what|whether)|don'?t (understand|get)|do not (understand|get)|still confused|confused (about|by)|open question|need to figure out)\b/.test(t)
  ) {
    return "open";
  }
  if (/^(always|never)\b/.test(t) || /\b(notation|convention|denote|we write|use \S+ for)\b/.test(t)) return "convention";
  if (/\b(prefer|rather|i like|i love|i hate|i (don'?t|do not) like|keep (it|answers|replies) (short|brief)|too (long|verbose|short))\b/.test(t)) {
    return "preference";
  }
  if (/^(i am|i'm|i work|i study|i studied|i have|i've|i know|my (background|job|role|field|degree|name))\b/.test(t)) return "profile";
  return "understanding";
}

/**
 * Which turns one bare /remember reads.
 *
 * It used to send every turn since the last save, however many that was. A long
 * thread met the provider's limit and got back "this conversation is now
 * longer than the model will accept — lower Effort", which has nothing to do
 * with a save. This reads forward from where the last save stopped, up to a
 * character budget, and says where it got to: nothing is skipped, and running
 * it again carries on from there.
 *
 * `lengths[i]` is the text length of turn i, 0 for a turn with nothing in it.
 * The first turn with text is always taken, so a single enormous one is read
 * (clipped by the caller) rather than blocking every save after it. `end` is
 * exclusive.
 */
export function wrapUpWindow(lengths: number[], from: number, maxChars: number): { end: number; chars: number } {
  const start = Math.max(0, Math.min(from, lengths.length));
  let end = start;
  let chars = 0;
  for (let i = start; i < lengths.length; i++) {
    const n = Math.max(0, lengths[i] || 0);
    if (chars > 0 && chars + n > maxChars) break;
    chars += n;
    end = i + 1;
  }
  return { end, chars };
}
