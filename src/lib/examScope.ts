/* ============================================================================
 * examScope.ts — resolving an exam's scope locally, before any call is made.
 *
 * "test me on what I learned three days ago" has to become a legible count —
 * "14–20 March · 4 entries · 23 cards" — the instant you finish typing, per
 * START-HERE.md §5. This module does that resolution and also assembles the
 * material blob the generation prompt is built from, capped so one huge
 * project can't blow the context window on scope alone.
 * ========================================================================== */
import * as store from "@/services/store";
import * as journalStore from "@/services/journalStore";
import * as examStore from "@/services/examStore";
import { dayInRange, parseWhen, type WhenRange } from "@/lib/when";
import { extractKeywords } from "@/lib/memoryRetrieval";
import { gapsFrom, type Gap, type GapSource } from "@/lib/gaps";
import { DAY, stripTags } from "@/lib/util";
import type { ExamScope } from "@/types/exam";
import type { Card, Deck } from "@/types";
import type { JournalEntry } from "@/types/journal";

const MAX_CARDS = 80;
const MAX_ENTRIES = 30;

/* A weak-spots exam is narrower on purpose. It is a set of questions about a
   handful of confusions, and eighty cards of material would bury the ones
   that matter under the ones that merely ride along. */
const WEAK_CARDS = 36;
const WEAK_ENTRIES = 8;
const WEAK_GAPS = 8;
/** How far back "keeps getting wrong" looks when no date is given. Longer
 *  than the thirty days the prompts use, because an exam is where you go
 *  looking for old trouble on purpose. */
const WEAK_DAYS = 60;

/** Keyword overlap, the same method memoryRetrieval.ts uses for memory — no
 *  embeddings (a locked decision), just counting how many of the topic's own
 *  words show up in the candidate. Good enough to rank "matplotlib" above
 *  everything else in a project without requiring an exact tag match. */
function topicScore(topicWords: string[], text: string): number {
  if (!topicWords.length) return 0;
  const words = new Set(extractKeywords(text));
  return topicWords.filter((w) => words.has(w)).length;
}

function journalText(e: JournalEntry): string {
  const s = e.summary!;
  return [s.narrative, ...s.learned, ...s.stuck, ...s.open].join(" ");
}

function cardText(c: Card): string {
  return c.tag + " " + stripTags(c.q) + " " + stripTags(c.a);
}

/** Rank by topical relevance and drop anything that scored zero — a topic is
 *  a request to find what is on-subject across the whole project, not to
 *  re-sort what was already going to be included. */
function byTopic<T>(items: T[], topicWords: string[], textOf: (item: T) => string): T[] {
  if (!topicWords.length) return items;
  return items
    .map((item) => ({ item, score: topicScore(topicWords, textOf(item)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

function buildMaterial(entries: JournalEntry[], cards: Card[]): string {
  const parts: string[] = [];
  if (entries.length) {
    parts.push(
      "JOURNAL ENTRIES:\n" +
        entries
          .map((e) => {
            const s = e.summary!;
            return (
              `--- ${e.day} [journal:${e.id}] ---\n${s.narrative}\n` +
              (s.learned.length ? `Learned: ${s.learned.join("; ")}\n` : "") +
              (s.stuck.length ? `Stuck: ${s.stuck.join("; ")}\n` : "") +
              (s.open.length ? `Open: ${s.open.join("; ")}\n` : "")
            );
          })
          .join("\n")
    );
  }
  if (cards.length) {
    parts.push("CARDS:\n" + cards.map((c) => `[card:${c.id}] (${c.tag}) Q: ${stripTags(c.q)} A: ${stripTags(c.a)}`).join("\n"));
  }
  return parts.join("\n\n");
}

function findCard(id: string): Card | null {
  for (const d of Object.values(store.get().decks)) {
    const c = d.cards.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}

/** Rebuilds the exact same material an exam was generated from, from the ids
 *  frozen in its scope — used by "more questions" / "harder" so extending an
 *  exam replays the same source set rather than re-resolving a date phrase
 *  that might parse differently by the time you ask for more. */
export function materialFromScope(scope: ExamScope): string {
  const entries = scope.journalIds.map((id) => journalStore.get(id)).filter((e): e is JournalEntry => !!e && !!e.summary);
  const cards = scope.cardIds.map(findCard).filter((c): c is Card => !!c);
  return buildMaterial(entries, cards);
}

/**
 * Every marked exam answer in the project, as the same shape a review log
 * entry has, so an exam's "missing" and a review's are clustered together by
 * one definition of a gap. The card is whichever the question was built from,
 * when it was built from one.
 */
export function examMisses(projectId: string): GapSource[] {
  const out: GapSource[] = [];
  for (const e of examStore.listForProject(projectId)) {
    for (const q of e.questions) {
      if (!q.result?.missing?.length || q.result.verdict === "got") continue;
      out.push({
        t: q.answeredAt || e.created,
        m: q.result.missing,
        c: q.sourceRefs.find((r) => r.kind === "card")?.id
      });
    }
  }
  return out;
}

/** What a weak-spots exam is made of: the recurring confusions, the cards
 *  they happened on (most-missed first), then the weakest cards overall to
 *  fill out the set. */
function weakMaterial(projectId: string, decks: Deck[], range: WhenRange | null): { gaps: Gap[]; cards: Card[] } {
  const inRange = (t: number) => (range ? t >= range.from && t <= range.to : true);
  const sources: GapSource[] = [...store.logOf(decks), ...examMisses(projectId)].filter((e) => inRange(e.t));
  const days = range ? Math.ceil((Date.now() - range.from) / DAY) + 1 : WEAK_DAYS;
  const gaps = gapsFrom(sources, { days, limit: WEAK_GAPS });

  const byId = new Map<string, Card>();
  for (const d of decks) for (const c of d.cards) byId.set(c.id, c);

  const picked: Card[] = [];
  const seen = new Set<string>();
  const add = (c: Card | undefined) => {
    if (!c || seen.has(c.id) || picked.length >= WEAK_CARDS) return;
    seen.add(c.id);
    picked.push(c);
  };
  /* Round-robin across gaps, so the first confusion's twelve cards do not
     crowd out the second confusion's only one. */
  const lists = gaps.map((g) => g.cardIds);
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) add(byId.get(l[i]));

  /* Then the weakest cards overall (leeches, lapses) ranked the one way the
     app ranks them. They are weak whether or not a marker ever wrote down
     why. */
  const weak = decks.flatMap((d) => store.weakCardsOf(d, WEAK_CARDS).map((c) => ({ c, st: d.srs[c.id] })));
  weak.sort(
    (a, b) => Number(store.isLeech(b.st)) - Number(store.isLeech(a.st)) || (b.st?.lapses || 0) - (a.st?.lapses || 0)
  );
  for (const w of weak) if ((w.st?.lapses || 0) > 0 || store.isLeech(w.st)) add(w.c);

  return { gaps, cards: picked };
}

export interface ScopeInput {
  projectId: string;
  /** Free text, run through lib/when.ts first. Empty means no date filter. */
  when: string;
  manualFrom?: number | null;
  manualTo?: number | null;
  /** Empty means every deck in the project. */
  deckIds: string[];
  /** Empty means every tag. */
  tags: string[];
  /** Free-text subject — "matplotlib", "gradient descent". When set, cards
   *  and journal entries are found by keyword relevance across whatever decks
   *  are in scope (every deck in the project, unless deckIds narrows that),
   *  rather than requiring an exact tag. Empty means no topic filter. */
  topic?: string;
  /** Aim at what the learner keeps getting wrong. Dates, decks, tags and a
   *  topic still narrow it. */
  focus?: "weak";
}

export interface ResolvedScope {
  scope: ExamScope;
  range: WhenRange | null;
  /** True when `when` had text that lib/when.ts could not parse — the
   *  caller should fall back to showing a manual date-range picker. */
  unparsed: boolean;
  entries: JournalEntry[];
  cards: Card[];
  counts: { entries: number; cards: number; decks: number; gaps: number };
  material: string;
  /** The recurring confusions a weak-spots exam targets; empty otherwise. */
  gaps: Gap[];
}

export function resolveScope(input: ScopeInput): ResolvedScope {
  const whenText = input.when.trim();
  const parsed = whenText ? parseWhen(whenText) : null;
  const unparsed = !!whenText && !parsed;
  const range: WhenRange | null =
    parsed || (input.manualFrom != null && input.manualTo != null ? { from: input.manualFrom, to: input.manualTo, label: "custom range" } : null);

  const topic = (input.topic || "").trim();
  const topicWords = topic ? extractKeywords(topic) : [];

  const weak = input.focus === "weak";

  const allEntries = journalStore.listForProject(input.projectId).filter((e) => e.summary);
  let entries = range ? allEntries.filter((e) => dayInRange(e.day, range)) : allEntries;
  /* A weak-spots exam reads the days you wrote down being stuck, and only
     those: the rest of the journal is what went fine. */
  if (weak) entries = entries.filter((e) => e.summary!.stuck.length > 0);
  entries = byTopic(entries, topicWords, journalText).slice(0, weak ? WEAK_ENTRIES : MAX_ENTRIES);

  const decks = input.deckIds.length ? input.deckIds.map((id) => store.get().decks[id]).filter(Boolean) : store.decksOf(input.projectId);
  let gaps: Gap[] = [];
  let cards: Card[] = [];
  if (weak) {
    const found = weakMaterial(input.projectId, decks, range);
    gaps = found.gaps;
    cards = found.cards;
  } else {
    for (const d of decks) cards = cards.concat(d.cards);
  }
  if (input.tags.length) {
    const tagset = new Set(input.tags.map((t) => t.toLowerCase()));
    cards = cards.filter((c) => tagset.has(c.tag.toLowerCase()));
  }
  cards = byTopic(cards, topicWords, cardText).slice(0, weak ? WEAK_CARDS : MAX_CARDS);

  const baseLabel = topic
    ? topic + (range ? " · " + range.label : "")
    : range?.label || (input.deckIds.length || input.tags.length ? "selected material" : "everything");

  const scope: ExamScope = {
    projectId: input.projectId,
    from: range?.from ?? null,
    to: range?.to ?? null,
    label: weak ? "What I keep getting wrong" + (topic || range ? " · " + baseLabel : "") : baseLabel,
    deckIds: input.deckIds,
    tags: input.tags,
    journalIds: entries.map((e) => e.id),
    cardIds: cards.map((c) => c.id),
    topic: topic || undefined,
    ...(weak ? { focus: "weak" as const, gaps: gaps.map((g) => g.text) } : {})
  };

  return {
    scope,
    range,
    unparsed,
    entries,
    cards,
    counts: { entries: entries.length, cards: cards.length, decks: decks.length, gaps: gaps.length },
    material: buildMaterial(entries, cards),
    gaps
  };
}
