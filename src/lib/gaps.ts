/* ============================================================================
 * gaps.ts — what the learner is currently getting wrong, and how often.
 *
 * The app generates the single most useful sentence about a learner every time
 * they fail a card, and then throws it away. `AI.markRecall` returns
 * `missing: ["the ordering the chain rule gives", ...]` — a precise diagnosis,
 * produced by a model that had the card, the correct answer and what the
 * learner actually wrote in front of it — and until now it was rendered under
 * the card for a few seconds, held in `ReviewContext.lastMark` until the next
 * one, and lost.
 *
 * So every later call started again from nothing. The card writer did not know
 * what to aim a card at. The exam generator did not know what to test. The
 * tutor rediscovered the same confusion in conversation after conversation.
 * The one thing an assistant that exists "to help you learn faster" should
 * know about you was the one thing it never kept.
 *
 * The exam side already did a version of this — ExamRail counts the phrases
 * its marker wrote down. It matched them by exact string, which puts "chain
 * rule ordering" and "the ordering in the chain rule" in different buckets,
 * and it only ever looked at exams, which happen rarely. Reviews happen every
 * day.
 *
 * Deliberately computed, never stored as memory. START-HERE §2.6: never
 * memorise what can be computed. A gap that has stopped recurring should stop
 * being mentioned, and that happens for free when the answer is derived from a
 * window of the log rather than written down once and left there.
 *
 * Pure: takes log entries, returns clusters. No stores, no DOM.
 * ========================================================================== */
import { extractKeywords } from "@/lib/memoryRetrieval";
import { DAY } from "@/lib/util";
import type { LogEntry } from "@/types";

export interface Gap {
  /** The clearest phrasing the marker used for this confusion. */
  text: string;
  /** How many times something in this cluster was recorded. */
  n: number;
  /** How many distinct cards it showed up on. Three cards is a concept you
   *  have not got; one card three times is a card that needs rewriting, and
   *  the difference is worth keeping because the fix is different. */
  cards: number;
  /** Most recent occurrence, so a stale gap sinks. */
  last: number;
  /** The cards it showed up on, most-missed first — what a weak-spots exam
   *  is built from. Empty for gaps recorded without a card (older log
   *  entries, exam questions not grounded in one). */
  cardIds: string[];
}

/**
 * What a gap is found in. A review log entry is one; so is a marked exam
 * answer, turned into this shape by the caller — which is how the two sources
 * of "what they got wrong" share one clustering instead of the exam rail
 * counting exact strings on its own.
 */
export type GapSource = Pick<LogEntry, "t" | "m" | "c">;

export interface GapOpts {
  /** How far back to look. A confusion you cleared up last month is not a
   *  gap, and saying it is teaches the model to argue with you. */
  days?: number;
  /** How many clusters to return. */
  limit?: number;
  /** Phrases below this many recorded occurrences are noise — one bad
   *  evening, or the marker being unusually specific once. */
  minCount?: number;
}

interface Cluster {
  /** The keywords of the *first* phrase in the cluster, never widened.
   *
   *  Matching against the accumulated union instead was the obvious thing and
   *  it decays: every phrase that joins adds its own words, the union grows,
   *  and the overlap ratio of the next genuine match falls below the
   *  threshold — so a confusion stops recognising itself after three or four
   *  recordings. A fixed seed keeps the question the same every time it is
   *  asked. */
  seed: Set<string>;
  /** Every exact phrasing seen, with how often, so the label is the one the
   *  marker actually reached for most rather than the first one recorded. */
  phrasings: Map<string, number>;
  n: number;
  /** Card id → how many times this confusion was recorded on it. */
  cards: Map<string, number>;
  last: number;
}

/**
 * How alike two phrases must be to count as the same confusion.
 *
 * A *ratio*, not a count of shared words, and that distinction is the whole
 * difficulty. "Share two significant words" reads as strict and is not: "chain
 * rule ordering" and "product rule ordering" share two, and merging those
 * would tell a model the learner has one problem where they have two — in a
 * block that every prompt in the app is built on. Overlap divided by the union
 * puts that pair at 0.5 and the genuine restatements at 0.75 and above, and
 * 0.6 is the line between them.
 */
const SAME_CONFUSION = 0.6;

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const k of a) if (b.has(k)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

function pickLabel(phrasings: Map<string, number>): string {
  let best = "";
  let bestN = -1;
  for (const [text, n] of phrasings) {
    /* Most frequent wins; a tie goes to the shorter, because the short
       phrasings are the crisp ones and this ends up in a prompt. */
    if (n > bestN || (n === bestN && text.length < best.length)) {
      best = text;
      bestN = n;
    }
  }
  return best;
}

/**
 * Cluster the marker's "missing" phrases into recurring gaps.
 *
 * Single pass: each phrase joins whichever existing cluster it is most like,
 * if it is like any of them enough, or starts its own. Not the best
 * clustering available, and deliberately so — it is explainable, it is stable
 * as entries arrive, and it runs on every prompt build.
 */
export function gapsFrom<E extends GapSource>(entries: E[], opts: GapOpts = {}): Gap[] {
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 5;
  const minCount = opts.minCount ?? 2;
  const since = Date.now() - days * DAY;

  const clusters: Cluster[] = [];

  for (const e of entries) {
    if (e.t < since || !e.m || !e.m.length) continue;
    for (const raw of e.m) {
      const text = String(raw || "").trim();
      if (!text) continue;
      const keys = new Set(extractKeywords(text));
      if (!keys.size) continue;

      /* Best match rather than first match: a phrase that is 0.9 like one
         cluster and 0.65 like another belongs to the first, and iteration
         order is not an argument about meaning. */
      let hit: Cluster | undefined;
      let bestScore = 0;
      for (const c of clusters) {
        const score = similarity(keys, c.seed);
        if (score >= SAME_CONFUSION && score > bestScore) {
          hit = c;
          bestScore = score;
        }
      }

      if (!hit) {
        hit = { seed: keys, phrasings: new Map(), n: 0, cards: new Map(), last: 0 };
        clusters.push(hit);
      }
      hit.phrasings.set(text, (hit.phrasings.get(text) || 0) + 1);
      hit.n++;
      if (e.c) hit.cards.set(e.c, (hit.cards.get(e.c) || 0) + 1);
      if (e.t > hit.last) hit.last = e.t;
    }
  }

  return clusters
    .filter((c) => c.n >= minCount)
    .map((c) => ({
      text: pickLabel(c.phrasings),
      n: c.n,
      cards: c.cards.size,
      last: c.last,
      cardIds: [...c.cards].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    }))
    .sort((a, b) => b.n - a.n || b.cards - a.cards || b.last - a.last)
    .slice(0, limit);
}

/** One line per gap, for a prompt. Says how many times and across how many
 *  cards, because "seen on four different cards" is what tells a model this is
 *  a concept and not a badly worded card. */
export function renderGaps(gaps: Gap[]): string {
  return gaps
    .map((g) => {
      const across = g.cards > 1 ? `, on ${g.cards} different cards` : "";
      return `- ${g.text} (missed ${g.n}×${across})`;
    })
    .join("\n");
}
