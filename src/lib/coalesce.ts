/* ============================================================================
 * coalesce — a burst of values in, at most one out per interval, newest wins.
 *
 * A streamed reply arrives as fifty to a hundred tokens a second, and each one
 * used to be its own React update. That update re-renders every turn in the
 * thread and re-parses the whole of the reply so far — markdown, sanitiser,
 * KaTeX, highlighting — so the work per token grows with the reply and the
 * total grows with its square. Nobody can read a hundred frames a second of
 * text; the screen needs the newest text a few dozen times a second and none
 * of the ones in between.
 *
 * Values that are skipped are dropped, never queued: each one is the whole
 * text so far, so the newest contains every earlier one.
 *
 * The first value after a quiet spell is delivered at once — a reply's first
 * token should not wait behind a timer that has nothing to coalesce.
 * ========================================================================== */

export interface Coalescer<T> {
  /** Offer a value. Delivered now if the interval has passed, otherwise held
   *  (replacing whatever was held) until it has. */
  push(value: T): void;
  /** Forget whatever is held and stop the timer. Call before delivering
   *  something out of band — a held token landing after the stream has been
   *  cleared would put a finished reply back on screen as one still arriving. */
  cancel(): void;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function coalesce<T>(deliver: (value: T) => void, intervalFor: (value: T) => number): Coalescer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held: { value: T } | null = null;
  let last = 0;

  const flush = () => {
    timer = null;
    if (!held) return;
    const { value } = held;
    held = null;
    last = now();
    deliver(value);
  };

  return {
    push(value) {
      const wait = intervalFor(value) - (now() - last);
      if (wait <= 0 && timer == null) {
        last = now();
        deliver(value);
        return;
      }
      held = { value };
      if (timer == null) timer = setTimeout(flush, Math.max(0, wait));
    },
    cancel() {
      if (timer != null) clearTimeout(timer);
      timer = null;
      held = null;
    }
  };
}

/** How long a streamed text of this length may go between repaints. About
 *  thirty a second while a reply is short, easing toward eight as it grows:
 *  each repaint re-parses everything so far, so a long reply earns a longer
 *  gap. The ceiling is still well inside what reads as continuous. */
export function streamInterval(text: string): number {
  return Math.min(120, 32 + text.length / 400);
}
