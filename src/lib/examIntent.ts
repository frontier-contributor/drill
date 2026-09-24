/* ============================================================================
 * examIntent.ts — "take me to an exam on these", carried across a navigation.
 *
 * The review rail lists what you keep getting wrong and offers to examine you
 * on it; the exam view is another section with its own state. This is the
 * one-shot note between them, the same shape as the composer's dropped-file
 * queue: set on the way out, read on arrival, then cleared.
 *
 * Its own file, with no imports, because the review rail is in the review
 * loop's entry chunk and lib/examScope.ts — which would otherwise be the
 * natural home — pulls the exam and journal stores in behind it.
 * ========================================================================== */

let pending: "weak" | null = null;

export function requestWeakExam(): void {
  pending = "weak";
}

/** Read without clearing, so a StrictMode double render sees it both times;
 *  the arriving view clears it in an effect. */
export function peekAim(): "weak" | null {
  return pending;
}

export function clearAim(): void {
  pending = null;
}
