/* ============================================================================
 * ReviewContext — the review-loop state that used to be five module-level
 * variables at the top of ui.js (current, revealed, lastTag, lastAttempt,
 * lastMark). Deliberately small: the card on screen, whether it is flipped,
 * the live recall draft, and the two things the tutor wants to know about
 * the attempt.
 *
 * `refresh()` is the direct equivalent of the old render(): it re-runs
 * rollover + nextCard and resets the per-card fields. Every mutation that
 * used to call render() (deck switches, card edits, imports…) calls
 * refresh() here too; grade() advances the queue itself.
 * ========================================================================== */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import * as store from "@/services/store";
import type { Grade, MarkResult, QueueItem } from "@/types";

interface ReviewState {
  current: QueueItem | null;
  revealed: boolean;
  attempt: string;
  lastAttempt: string;
  lastMark: MarkResult | null;
  setAttempt: (s: string) => void;
  refresh: () => void;
  reveal: () => void;
  setMark: (m: MarkResult | null) => void;
  grade: (g: Grade) => void;
}

const Ctx = createContext<ReviewState | null>(null);

export function ReviewProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [attempt, setAttempt] = useState("");
  const [lastAttempt, setLastAttempt] = useState("");
  const [lastMark, setLastMark] = useState<MarkResult | null>(null);
  const [lastTag, setLastTag] = useState("");

  const resetCard = useCallback((tag: string) => {
    store.rollover();
    setCurrent(store.nextCard(tag));
    setRevealed(false);
    setAttempt("");
    setLastAttempt("");
    setLastMark(null);
  }, []);

  const refresh = useCallback(() => resetCard(lastTag), [resetCard, lastTag]);

  const grade = useCallback(
    (g: Grade) => {
      if (!current) return;
      /* The attempt goes into the log with the grade. A grade on its own says
         you got it wrong; the sentence you actually wrote says *how* — which
         is the difference between a tutor that can only count and one that
         can read back what you were thinking. */
      store.gradeCard(current, g, {
        attempt: lastAttempt || attempt,
        verdict: lastMark?.verdict,
        /* The marker's diagnosis, kept rather than shown once and dropped.
           It is the most specific thing anything in this app ever says about
           what the learner does not understand, and every AI call used to
           start again without it — see lib/gaps. */
        missing: lastMark?.missing
      });
      const tag = current.def.tag;
      setLastTag(tag);
      resetCard(tag);
    },
    [current, resetCard, attempt, lastAttempt, lastMark]
  );

  return (
    <Ctx.Provider
      value={{
        current,
        revealed,
        attempt,
        lastAttempt,
        lastMark,
        setAttempt,
        refresh,
        reveal: () => {
          setLastAttempt(attempt);
          setRevealed(true);
        },
        setMark: setLastMark,
        grade
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useReview(): ReviewState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useReview must be used within ReviewProvider");
  return ctx;
}

/** The review loop mounts this provider; Cards and Figures mount it for the
 *  editor and the card writer, and the rest do not. Settings opens over every
 *  one of them and can change what the queue is made of — a restored backup,
 *  an imported deck — so it needs to ask for a refresh without requiring one.
 *  `review?.refresh()` is right in the review loop and correctly nothing
 *  everywhere else. */
export function useMaybeReview(): ReviewState | null {
  return useContext(Ctx);
}
