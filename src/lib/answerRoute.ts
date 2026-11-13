/* ============================================================================
 * answerRoute.ts — which of the two engines answers a message.
 *
 * There are five modes and two ways to answer: one request, or the loop in
 * services/agent/. This is the one place that maps the first onto the second,
 * because three things have to agree about it and used to each work it out
 * for themselves — the send path (which engine runs), buildMessages (whether
 * a PDF names OpenRouter's parser, which only a single request can do), and
 * the composer (what the mode row and the Web switch promise).
 *
 * Pure, and imports nothing but types, so the review loop's entry chunk can
 * never be made to carry it in.
 * ========================================================================== */
import type { ChatActionId } from "@/lib/chatActions";
import type { ChatMode } from "@/types/chat";

/**
 *   single  one request — Quick, and every request that draws or films
 *   auto    the loop, a plan offered but never required
 *   deep    the loop, a plan required and closed out before the answer
 */
export type AnswerRoute = "single" | "auto" | "deep";

export function answerRoute(mode: ChatMode | undefined, actions: readonly ChatActionId[] = []): AnswerRoute {
  if (mode === "deep") return "deep";
  if (mode === "quick" || mode === "image" || mode === "video") return "single";
  /* A reply that may come back as a picture comes back through one request.
     The loop's rounds carry words; a picture drawn mid-loop would arrive on a
     round that turned out to be a lookup and be thrown away with it. So the
     Image switch on a chat model that draws takes the thread's message down
     the single path, and says so in the Tools menu. */
  if (actions.includes("image")) return "single";
  return "auto";
}
